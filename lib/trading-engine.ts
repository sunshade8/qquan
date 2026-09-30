/**
 * The trading dashboards' engine: one `tick` advances a dashboard by looking at
 * the clock, the broker and the bars, and returns the next state.
 *
 * It is the live twin of `runRelay`. The same `decideSlot` asks the same rule
 * the same question — completed bars only, one entry per slot, the full balance,
 * out by the slot's end — so a live trade that differs from its backtest differs
 * because of execution, and `assessTrade` names how.
 *
 * Nothing here touches the network or the database. The broker and the market
 * data are injected, which is what lets the Node tests drive a full
 * start → signal → fill → stop → liquidate → stopped cycle without an order
 * ever leaving the machine. `lib/trading-runner.ts` wires in Toss and D1.
 *
 * The engine is also idempotent under retries: every order carries a
 * deterministic idempotency key, and an order whose submission got no answer is
 * re-sent with that same key rather than assumed lost.
 */

import type {
  DashboardEvent, DashboardMode, DashboardOrder, DashboardState, DashboardStrategyStats, DashboardTrade, OrderPurpose,
} from "./dashboard-types.ts";
import { barMinutesOf, decideSlot, inSlotWindow, orderProblem, sliceSession, strategyWindow, type IntradayBar, type SlotStrategy } from "./relay-engine.ts";
import { costPerSidePct, halfSpreadPct } from "./symbol-liquidity.ts";
import { feePerSidePct, TOSS_US_EQUITY } from "./broker-costs.ts";
import { assessTrade, type TradeExit } from "./trade-adherence.ts";
import { easternParts, easternWallTimeToEpoch, isWeekday, timeMinutes } from "./market-clock.ts";
import { latestCompleteBarStart, type BarIntervalMinutes } from "./live-bars.ts";
import { toClientOrderId, usLimitPrice } from "./toss-order-shapes.ts";

export const DASHBOARD_CAPITAL_USD = 1_000;
/** An entry that has not filled within a minute is no longer the next-bar fill the rule assumed. */
export const ENTRY_ORDER_TIMEOUT_MS = 60_000;
/** An exit that has not filled is canceled and re-sent further through the book. */
export const EXIT_ORDER_TIMEOUT_MS = 30_000;
/** Toss honours an idempotency key for ten minutes; past that a re-send could place a second order. */
const RESUBMIT_WINDOW_MS = 9 * 60_000;

const MAX_EVENTS = 150;
const MAX_FINISHED_ORDERS = 60;
const MAX_FINISHED_TRADES = 400;

export type BrokerQuote = { price: number; bid: number | null; ask: number | null; timestamp?: string | null; bookTimestamp?: string | null };
export type BrokerOrderState = {
  status: "working" | "filled" | "canceled" | "rejected";
  filledQuantity: number;
  averageFillPrice: number | null;
  commissionUsd: number;
  message?: string | null;
};
export type SubmitRequest = {
  clientOrderId: string; symbol: string; side: "buy" | "sell"; quantity: number;
  limitPrice: number | null; referencePrice: number;
};

/**
 * A definite "no" from the broker — the order does not exist. Anything else
 * thrown from `submit` is treated as ambiguous and retried with the same key.
 */
export class BrokerRejection extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export interface DashboardBroker {
  readonly mode: DashboardMode;
  quote(symbol: string): Promise<BrokerQuote>;
  submit(request: SubmitRequest): Promise<{ brokerOrderId: string; state?: BrokerOrderState }>;
  poll(order: DashboardOrder): Promise<BrokerOrderState>;
  cancel(order: DashboardOrder): Promise<void>;
  buyingPowerUsd?(): Promise<number | null>;
  sellableQuantity?(symbol: string): Promise<number | null>;
  /** Why an entry cannot be sent now: session calendar, account state. `window` is the rule's own clock. */
  entryProblem?(symbol: string, slot: SlotStrategy["slot"], date: string, window?: { from: string; to: string }): Promise<string | null>;
}

export interface DashboardMarketData {
  /** Completed strategy-resolution bars for the ET date so far, from `from` ("HH:MM" ET, default 04:00). */
  sessionBars(symbol: string, date: string, nowMs: number, step?: BarIntervalMinutes, from?: string): Promise<IntradayBar[]>;
  /** Up to `count` prior sessions' bars, oldest first. */
  priorSessions(symbol: string, date: string, count: number, step?: BarIntervalMinutes): Promise<IntradayBar[][]>;
  /** Low and high traded after `fromMs`. */
  range(symbol: string, fromMs: number, toMs: number): Promise<{ low: number; high: number } | null>;
}

export type EngineDeps = {
  now: () => number;
  id: () => string;
  strategies: SlotStrategy[];
  broker: DashboardBroker;
  market: DashboardMarketData;
  /** How far past the quote a marketable limit is priced, percent per attempt. */
  limitBandPct: number;
  /** Persist order intent before any external submit, so a restart retains its idempotency key. */
  checkpoint?(state: DashboardState): Promise<void>;
};

const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const ACTIVE_ORDER = new Set<DashboardOrder["status"]>(["submitting", "working", "cancel_requested"]);
export const isActiveOrder = (order: DashboardOrder) => ACTIVE_ORDER.has(order.status);
export const heldQuantity = (trade: DashboardTrade) => trade.boughtQuantity - trade.soldQuantity;

export function emptyDashboard(mode: DashboardMode): DashboardState {
  return {
    version: 1, mode, status: "stopped", runId: null, stopPhase: null,
    initialCapitalUsd: DASHBOARD_CAPITAL_USD, cashUsd: DASHBOARD_CAPITAL_USD,
    peakEquityUsd: DASHBOARD_CAPITAL_USD, maxDrawdownPct: 0,
    startedAt: null, stopRequestedAt: null, stoppedAt: null, lastTickAt: null, lastError: null,
    slotProgress: {}, orders: [], trades: [], strategies: {}, daily: [], brokerBalance: null, events: [], previousRuns: [],
  };
}

/** Appends to the log; a repeat of the last line only moves its time, so a retry loop cannot flood it. */
export function event(state: DashboardState, at: string, kind: DashboardEvent["kind"], message: string) {
  const last = state.events.at(-1);
  if (last && last.kind === kind && last.message === message) last.at = at;
  else state.events.push({ at, kind, message });
  if (kind === "error") state.lastError = message;
}

/** Positions marked at their last known price. */
export function equityOf(state: DashboardState) {
  const positionsValue = state.trades.reduce((sum, trade) => {
    const held = heldQuantity(trade);
    return held > 0 ? sum + held * (trade.markPrice ?? trade.entryPrice ?? 0) : sum;
  }, 0);
  return { positionsValue: round(positionsValue, 2), equity: round(state.cashUsd + positionsValue, 2) };
}

/**
 * A new run always starts from the fixed capital. The previous run's result is
 * kept as a one-line summary; mixing two runs' trades into one P&L would make
 * the total return meaningless.
 */
export function startDashboard(state: DashboardState, deps: Pick<EngineDeps, "now" | "id">, note?: string): DashboardState {
  if (state.status !== "stopped") throw new Error(state.status === "stopping" ? "정지 절차가 끝난 뒤에 다시 시작할 수 있습니다." : "이미 실행 중입니다.");
  const at = new Date(deps.now()).toISOString();
  const previousRuns = [...state.previousRuns];
  if (state.runId) {
    const { equity } = equityOf(state);
    previousRuns.unshift({
      runId: state.runId, startedAt: state.startedAt, stoppedAt: state.stoppedAt, finalEquityUsd: equity,
      returnPct: round((equity / state.initialCapitalUsd - 1) * 100), trades: state.trades.filter((trade) => trade.status === "closed").length,
    });
  }
  const next = emptyDashboard(state.mode);
  next.status = "running";
  next.runId = deps.id();
  next.startedAt = at;
  next.previousRuns = previousRuns.slice(0, 10);
  next.brokerBalance = state.brokerBalance;
  event(next, at, "info", `${state.mode === "live" ? "실전" : "모의"} 트레이딩 시작 — 자본 $${DASHBOARD_CAPITAL_USD.toLocaleString("en-US")}${note ? ` · ${note}` : ""}`);
  return next;
}

export function requestStop(state: DashboardState, nowMs: number): DashboardState {
  if (state.status !== "running") throw new Error(state.status === "stopping" ? "이미 정지 절차가 진행 중입니다." : "실행 중이 아닙니다.");
  const next = structuredClone(state);
  const at = new Date(nowMs).toISOString();
  next.status = "stopping";
  next.stopPhase = "cancel_buys";
  next.stopRequestedAt = at;
  event(next, at, "info", "정지 요청 — ① 미체결 매수 취소 → ② 대시보드 보유 종목 청산 → ③ 체결 확인");
  return next;
}

type Ctx = {
  state: DashboardState;
  deps: EngineDeps;
  nowMs: number;
  at: string;
  quotes: Map<string, BrokerQuote | null>;
};

function stats(ctx: Ctx, trade: Pick<DashboardTrade, "strategyId" | "strategyName" | "slot">): DashboardStrategyStats {
  const existing = ctx.state.strategies[trade.strategyId];
  if (existing) return existing;
  const created: DashboardStrategyStats = { id: trade.strategyId, name: trade.strategyName, slot: trade.slot, signals: 0, entries: 0, missed: 0, closed: 0, compliant: 0, deviations: 0, wins: 0, pnlUsd: 0, commissionUsd: 0 };
  ctx.state.strategies[trade.strategyId] = created;
  return created;
}

async function quoteFor(ctx: Ctx, symbol: string) {
  if (ctx.quotes.has(symbol)) return ctx.quotes.get(symbol) ?? null;
  try {
    const quote = await ctx.deps.broker.quote(symbol);
    const usable = quote && quote.price > 0 ? quote : null;
    ctx.quotes.set(symbol, usable);
    return usable;
  } catch (error) {
    ctx.quotes.set(symbol, null);
    event(ctx.state, ctx.at, "warn", `${symbol} 시세 조회 실패: ${error instanceof Error ? error.message : "알 수 없음"}`);
    return null;
  }
}

/** Execution slack: at least a quarter percent, wider for names whose spread alone is wider. */
export function executionTolerancePct(symbol: string) {
  return Math.max(0.25, halfSpreadPct(symbol) * 2);
}

function markMissed(ctx: Ctx, trade: DashboardTrade, why: string) {
  trade.status = "missed";
  trade.violations = [`신호 미체결: ${why}`];
  trade.compliant = null;
  stats(ctx, trade).missed += 1;
  event(ctx.state, ctx.at, "warn", `${trade.strategyName} ${trade.symbol} 신호 미체결 — ${why}`);
}

function closeTrade(ctx: Ctx, trade: DashboardTrade) {
  trade.status = "closed";
  const pnl = trade.sellNotionalUsd - trade.buyNotionalUsd - trade.commissionUsd;
  trade.pnlUsd = round(pnl, 4);
  trade.returnPct = trade.equityAtEntryUsd > 0 ? round((pnl / trade.equityAtEntryUsd) * 100) : null;
  const adherence = assessTrade({
    stopPct: trade.stopPct, targetPct: trade.targetPct,
    referenceEntryPrice: trade.referencePrice, entryPrice: trade.entryPrice ?? trade.referencePrice,
    exitPrice: trade.exitPrice ?? trade.entryPrice ?? trade.referencePrice, exit: trade.exit ?? "shutdown",
    entryDelayLimitSeconds: (trade.barMinutes ?? 5) * 60,
    entryDelaySeconds: trade.entryAt ? (Date.parse(trade.entryAt) - Date.parse(trade.decidedAt)) / 1000 : null,
    heldPastSlotSeconds: trade.exitAt && trade.exit !== "shutdown" ? Math.max(0, (Date.parse(trade.exitAt) - Date.parse(trade.slotEndsAt)) / 1000) : null,
    tolerancePct: executionTolerancePct(trade.symbol),
  });
  trade.compliant = adherence.compliant;
  trade.violations = adherence.violations;
  trade.entrySlippagePct = adherence.entrySlippagePct;
  const row = stats(ctx, trade);
  row.closed += 1;
  if (adherence.compliant) row.compliant += 1; else row.deviations += 1;
  if (pnl > 0) row.wins += 1;
  row.pnlUsd = round(row.pnlUsd + pnl, 4);
  row.commissionUsd = round(row.commissionUsd + trade.commissionUsd, 4);
  event(ctx.state, ctx.at, "fill", `${trade.strategyName} ${trade.symbol} 청산(${EXIT_TEXT[trade.exit ?? "shutdown"]}) 손익 ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}${adherence.compliant ? "" : ` · 이탈: ${adherence.violations.join("; ")}`}`);
}

export const EXIT_TEXT: Record<TradeExit, string> = { stop: "손절", target: "목표", slot_end: "시간 청산", shutdown: "정지 청산" };

/** Folds a broker order snapshot into the order, the trade and the cash. */
function applyOrderState(ctx: Ctx, order: DashboardOrder, next: BrokerOrderState) {
  const trade = ctx.state.trades.find((item) => item.id === order.tradeId);
  const filled = Math.max(order.filledQuantity, Math.min(order.quantity, next.filledQuantity));
  const delta = filled - order.filledQuantity;
  const commissionDelta = Math.max(0, next.commissionUsd - order.commissionUsd);
  if (trade && delta > 0 && next.averageFillPrice !== null) {
    const notionalDelta = next.averageFillPrice * filled - (order.averageFillPrice ?? 0) * order.filledQuantity;
    if (order.side === "buy") {
      trade.boughtQuantity += delta;
      trade.buyNotionalUsd = round(trade.buyNotionalUsd + notionalDelta, 6);
      trade.entryPrice = round(trade.buyNotionalUsd / trade.boughtQuantity, 6);
      if (!trade.entryAt) {
        trade.entryAt = ctx.at;
        trade.checkedThroughMs = ctx.nowMs;
        stats(ctx, trade).entries += 1;
      }
      trade.status = "open";
      trade.markPrice = next.averageFillPrice;
      ctx.state.cashUsd = round(ctx.state.cashUsd - notionalDelta, 6);
    } else {
      trade.soldQuantity += delta;
      trade.sellNotionalUsd = round(trade.sellNotionalUsd + notionalDelta, 6);
      trade.exitPrice = round(trade.sellNotionalUsd / trade.soldQuantity, 6);
      trade.exitAt = ctx.at;
      trade.exit = order.purpose === "entry" ? "shutdown" : order.purpose;
      ctx.state.cashUsd = round(ctx.state.cashUsd + notionalDelta, 6);
    }
    event(ctx.state, ctx.at, "fill", `${order.side === "buy" ? "매수" : "매도"} 체결 ${order.symbol} ${delta}주 @ $${next.averageFillPrice.toFixed(4)}${ctx.deps.broker.mode === "paper" ? " (모의)" : ""}`);
  }
  if (trade && commissionDelta > 0) {
    trade.commissionUsd = round(trade.commissionUsd + commissionDelta, 6);
    ctx.state.cashUsd = round(ctx.state.cashUsd - commissionDelta, 6);
  }
  order.filledQuantity = filled;
  order.averageFillPrice = next.averageFillPrice ?? order.averageFillPrice;
  order.commissionUsd = Math.max(order.commissionUsd, next.commissionUsd);
  order.updatedAt = ctx.at;
  if (next.message) order.message = next.message;
  if (next.status !== "working") order.status = next.status;
  if (!trade || isActiveOrder(order)) return;

  if (order.side === "buy") {
    if (trade.boughtQuantity === 0) markMissed(ctx, trade, order.status === "rejected" ? `주문 거부 — ${order.message ?? "사유 없음"}` : "진입 주문이 제한 시간 안에 체결되지 않아 취소");
    else if (order.filledQuantity < order.quantity) event(ctx.state, ctx.at, "warn", `${trade.symbol} 매수 부분 체결 ${order.filledQuantity}/${order.quantity}주 — 체결분만 보유`);
  } else if (heldQuantity(trade) <= 0) {
    closeTrade(ctx, trade);
  }
}

function requestOf(order: DashboardOrder): SubmitRequest {
  return { clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, quantity: order.quantity, limitPrice: order.limitPrice, referencePrice: order.referencePrice };
}

const PURPOSE_CODE: Record<OrderPurpose, string> = { entry: "en", stop: "sl", target: "tp", slot_end: "se", shutdown: "sd" };

async function placeOrder(ctx: Ctx, trade: DashboardTrade, spec: { side: "buy" | "sell"; purpose: OrderPurpose; quantity: number; limitPrice: number | null; referencePrice: number; attempt: number }) {
  const runKey = (ctx.state.runId ?? "run").replace(/-/g, "").slice(0, 10);
  const tradeKey = trade.id.replace(/-/g, "").slice(0, 16);
  const order: DashboardOrder = {
    id: ctx.deps.id(), tradeId: trade.id,
    clientOrderId: toClientOrderId(`${runKey}-${tradeKey}-${PURPOSE_CODE[spec.purpose]}${spec.attempt}`),
    brokerOrderId: null, symbol: trade.symbol, side: spec.side, purpose: spec.purpose,
    quantity: spec.quantity, limitPrice: spec.limitPrice, referencePrice: spec.referencePrice,
    filledQuantity: 0, averageFillPrice: null, commissionUsd: 0, status: "submitting",
    attempt: spec.attempt, submittedAt: ctx.at, updatedAt: ctx.at, message: null,
  };
  ctx.state.orders.push(order);
  await ctx.deps.checkpoint?.(ctx.state);
  const label = `${spec.side === "buy" ? "매수" : "매도"} ${trade.symbol} ${spec.quantity}주${spec.limitPrice !== null ? ` 지정가 $${spec.limitPrice}` : " (모의 체결)"}`;
  try {
    const result = await ctx.deps.broker.submit(requestOf(order));
    order.brokerOrderId = result.brokerOrderId;
    order.status = "working";
    event(ctx.state, ctx.at, "order", `${label} 접수 — ${spec.purpose === "entry" ? "진입" : EXIT_TEXT[spec.purpose]}`);
    if (result.state) applyOrderState(ctx, order, result.state);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없음";
    if (error instanceof BrokerRejection) {
      order.status = "rejected";
      order.message = message;
      event(ctx.state, ctx.at, "error", `${label} 거부 — ${message}`);
      if (spec.side === "buy") markMissed(ctx, trade, `주문 거부 — ${message}`);
    } else {
      order.message = message;
      event(ctx.state, ctx.at, "error", `${label} 응답 없음 — 같은 주문 식별자로 다음 틱에 재확인합니다 (${message})`);
    }
    return false;
  }
}

/** Polls every open order, applies fills, and cancels orders that waited too long. */
async function reconcileOrders(ctx: Ctx) {
  for (const order of ctx.state.orders.filter(isActiveOrder)) {
    const age = ctx.nowMs - Date.parse(order.submittedAt);
    if (order.status === "submitting") {
      if (age > RESUBMIT_WINDOW_MS) {
        // An unanswered order can already be filled at the broker. Keep it
        // active and block subsequent orders; expiry never proves rejection.
        const message = "주문 상태 불명 — 재전송을 중단했습니다. 토스 주문·체결 내역 확인과 계좌 대사가 필요합니다.";
        if (order.message !== message) {
          order.message = message;
          order.updatedAt = ctx.at;
          event(ctx.state, ctx.at, "error", `${order.symbol} ${order.side === "buy" ? "매수" : "매도"}: ${message}`);
        }
        continue;
      }
      try {
        const result = await ctx.deps.broker.submit(requestOf(order));
        order.brokerOrderId = result.brokerOrderId;
        order.status = "working";
        if (result.state) { applyOrderState(ctx, order, result.state); continue; }
      } catch (error) {
        if (error instanceof BrokerRejection) {
          applyOrderState(ctx, order, { status: "rejected", filledQuantity: 0, averageFillPrice: null, commissionUsd: 0, message: error.message });
        }
        continue;
      }
    }

    let snapshot: BrokerOrderState;
    try {
      snapshot = await ctx.deps.broker.poll(order);
    } catch (error) {
      event(ctx.state, ctx.at, "warn", `${order.symbol} 주문 조회 실패: ${error instanceof Error ? error.message : "알 수 없음"}`);
      continue;
    }
    applyOrderState(ctx, order, snapshot);
    if (order.status !== "working") continue;

    const trade = ctx.state.trades.find(item => item.id === order.tradeId);
    const deadline = order.side === "buy" ? Math.min(
      Date.parse(order.submittedAt) + ENTRY_ORDER_TIMEOUT_MS,
      trade ? Date.parse(trade.decidedAt) + (trade.barMinutes ?? 5) * 60_000 : Infinity,
      trade ? Date.parse(trade.slotEndsAt) : Infinity,
    ) : Date.parse(order.submittedAt) + EXIT_ORDER_TIMEOUT_MS;
    if (ctx.nowMs >= deadline) {
      try {
        await ctx.deps.broker.cancel(order);
        order.status = "cancel_requested";
        order.updatedAt = ctx.at;
        event(ctx.state, ctx.at, "order", `${order.symbol} ${order.side === "buy" ? "매수" : "매도"} ${Math.round(age / 1000)}초 미체결 — 취소 요청`);
      } catch (error) {
        event(ctx.state, ctx.at, "warn", `${order.symbol} 주문 취소 실패: ${error instanceof Error ? error.message : "알 수 없음"}`);
      }
    }
  }
}

/** A sell the broker just refused (market closed, say) is retried once a minute, not every tick. */
const EXIT_RETRY_AFTER_REJECT_MS = 60_000;

async function submitExit(ctx: Ctx, trade: DashboardTrade, purpose: TradeExit) {
  const held = heldQuantity(trade);
  if (held <= 0) return false;
  trade.pendingExit = trade.pendingExit ?? purpose;
  const lastSell = ctx.state.orders.filter((order) => order.tradeId === trade.id && order.side === "sell").at(-1);
  if (lastSell?.status === "rejected" && ctx.nowMs - Date.parse(lastSell.updatedAt) < EXIT_RETRY_AFTER_REJECT_MS) return false;
  let quantity = held;
  if (ctx.deps.broker.sellableQuantity) {
    const sellable = await ctx.deps.broker.sellableQuantity(trade.symbol).catch(() => null);
    if (sellable === null || !Number.isFinite(sellable) || sellable < 0) {
      event(ctx.state, ctx.at, "error", `${trade.symbol} 매도 가능 수량 확인 실패 — 다음 틱에서 재확인합니다.`);
      return false;
    }
    if (sellable < quantity) {
      quantity = Math.floor(sellable);
      if (quantity < 1) {
        event(ctx.state, ctx.at, "error", `${trade.symbol} 매도 가능 수량이 0입니다 (대시보드 보유 ${held}주).`);
        return false;
      }
      event(ctx.state, ctx.at, "warn", `${trade.symbol} 매도 가능 ${sellable}주 — 보유 ${held}주 중 일부만 매도`);
    }
  }
  const quote = await quoteFor(ctx, trade.symbol);
  const reference = ctx.deps.broker.mode === "paper" ? quote?.price : quote?.bid ?? quote?.price;
  if (!reference) {
    event(ctx.state, ctx.at, "error", `${trade.symbol} 시세가 없어 ${EXIT_TEXT[trade.pendingExit]} 매도를 내지 못했습니다. 다음 틱에 재시도합니다.`);
    return false;
  }
  trade.exitAttempts += 1;
  // Each retry reaches further through the book, but never more than three bands.
  const reach = ctx.deps.limitBandPct * Math.min(trade.exitAttempts, 3);
  const limitPrice = ctx.deps.broker.mode === "paper" ? null : Number(usLimitPrice(reference * (1 - reach / 100)));
  return placeOrder(ctx, trade, { side: "sell", purpose: trade.pendingExit, quantity, limitPrice, referencePrice: reference, attempt: trade.exitAttempts });
}

const hasActive = (ctx: Ctx, trade: DashboardTrade, side: "buy" | "sell") =>
  ctx.state.orders.some((order) => order.tradeId === trade.id && order.side === side && isActiveOrder(order));

/** Stop, target and slot-end checks for every held position. */
async function manageExits(ctx: Ctx) {
  for (const trade of ctx.state.trades.filter((item) => heldQuantity(item) > 0)) {
    if (hasActive(ctx, trade, "sell")) continue;
    if (trade.pendingExit) {
      // The exit was already decided; a timed-out sell is re-sent, not re-judged.
      if (hasActive(ctx, trade, "buy")) continue;
      await submitExit(ctx, trade, trade.pendingExit);
      continue;
    }
    const entry = trade.entryPrice;
    if (!entry) continue;
    const quote = await quoteFor(ctx, trade.symbol);
    let range: { low: number; high: number } | null = null;
    if (trade.checkedThroughMs !== null) {
      try {
        range = await ctx.deps.market.range(trade.symbol, trade.checkedThroughMs, ctx.nowMs);
      } catch {
        range = null;
      }
    }
    const lows = [range?.low, quote?.price].filter((value): value is number => typeof value === "number");
    const highs = [range?.high, quote?.price].filter((value): value is number => typeof value === "number");
    if (range) trade.checkedThroughMs = ctx.nowMs;
    const stopPrice = entry * (1 - trade.stopPct / 100);
    const targetPrice = trade.targetPct === null ? null : entry * (1 + trade.targetPct / 100);
    const reason: TradeExit | null = lows.length && Math.min(...lows) <= stopPrice ? "stop"
      : targetPrice !== null && highs.length && Math.max(...highs) >= targetPrice ? "target"
        : ctx.nowMs >= Date.parse(trade.slotEndsAt) ? "slot_end" : null;
    if (!reason) continue;
    if (hasActive(ctx, trade, "buy")) {
      // Still filling the entry: stop buying before selling.
      const buy = ctx.state.orders.find((order) => order.tradeId === trade.id && order.side === "buy" && order.status === "working");
      if (buy) await ctx.deps.broker.cancel(buy).then(() => { buy.status = "cancel_requested"; }).catch(() => undefined);
      trade.pendingExit = reason;
      continue;
    }
    event(ctx.state, ctx.at, "signal", `${trade.strategyName} ${trade.symbol} ${EXIT_TEXT[reason]} 조건 — 매도`);
    await submitExit(ctx, trade, reason);
  }
}

/** A rule's progress row: per slot for a slot rule, per rule for one that owns its own window. */
const progressKey = (date: string, strategy: SlotStrategy) => `${date}:${strategy.window ? strategy.id : strategy.slot}`;

/** Asks every rule whose window is open about each bar that has closed since the last tick. */
async function scanEntries(ctx: Ctx) {
  const et = easternParts(ctx.nowMs);
  if (!isWeekday(et.date)) return;
  for (const strategy of ctx.deps.strategies) {
    const window = strategyWindow(strategy);
    if (!inSlotWindow(et.time, window)) continue;
    await scanStrategy(ctx, strategy, window, et);
    // One balance in one place: the first rule to act holds it for this tick.
    if (ctx.state.orders.some(isActiveOrder) || ctx.state.trades.some((trade) => trade.status === "entering" || heldQuantity(trade) > 0)) return;
  }
}

async function scanStrategy(ctx: Ctx, strategy: SlotStrategy, window: ReturnType<typeof strategyWindow>, et: ReturnType<typeof easternParts>) {
  const key = progressKey(et.date, strategy);
  const progress = ctx.state.slotProgress[key] ?? { lastBarTime: null, fired: false, entries: 0 };
  ctx.state.slotProgress[key] = progress;
  if (progress.fired) return;

  const step = barMinutesOf(strategy);
  const barMs = step * 60_000;
  const latestStart = latestCompleteBarStart(ctx.nowMs, step);
  const latest = easternParts(latestStart);
  if (latest.date !== et.date || !inSlotWindow(latest.time, window)) return;
  if (progress.lastBarTime && timeMinutes(latest.time) <= timeMinutes(progress.lastBarTime)) return;

  // One balance in one place: a position still leaving the previous slot blocks
  // this one, and any signal it would have taken meanwhile is judged stale later.
  const busy = ctx.state.orders.some(isActiveOrder) || ctx.state.trades.some((trade) => trade.status === "entering" || heldQuantity(trade) > 0);
  if (busy) {
    // Bars that close while this rule's own position is open are not re-asked
    // afterwards: the backtest resumes after the exit bar, and so does this.
    if ((progress.entries ?? 0) > 0 && ctx.state.trades.some((trade) => trade.strategyId === strategy.id && trade.date === et.date && (trade.status === "entering" || heldQuantity(trade) > 0))) {
      progress.lastBarTime = latest.time;
    }
    return;
  }

  // Nor is the bar the position was sold on: the search resumes after the exit, as in the backtest.
  const lastExitMs = Math.max(0, ...ctx.state.trades.filter((trade) => trade.strategyId === strategy.id && trade.date === et.date && trade.exitAt)
    .map((trade) => Date.parse(trade.exitAt!)));
  if (lastExitMs) {
    const through = easternParts(latestCompleteBarStart(lastExitMs, step));
    if (through.date === et.date && (!progress.lastBarTime || timeMinutes(through.time) > timeMinutes(progress.lastBarTime))) progress.lastBarTime = through.time;
  }

  const bars: Record<string, IntradayBar[]> = {};
  const history: Record<string, IntradayBar[][]> = {};
  try {
    for (const symbol of strategy.universe) {
      // A rule with its own window never reads before it, so its candles are not fetched from 04:00.
      bars[symbol] = (await ctx.deps.market.sessionBars(symbol, et.date, ctx.nowMs, step, strategy.window?.from)).filter(bar =>
        bar.date === et.date && timeMinutes(bar.time) % step === 0 && easternWallTimeToEpoch(bar.date, bar.time) + barMs <= ctx.nowMs);
      history[symbol] = strategy.warmupSessions > 0 ? await ctx.deps.market.priorSessions(symbol, et.date, strategy.warmupSessions, step) : [];
    }
  } catch (error) {
    event(ctx.state, ctx.at, "error", `${strategy.name} ${step}분봉 조회 실패: ${error instanceof Error ? error.message : "알 수 없음"}`);
    return;
  }

  const tradedToday = new Set(ctx.state.trades.filter((trade) => trade.strategyId === strategy.id && trade.date === et.date).map((trade) => trade.symbol));
  const { window: slotBars, earlier } = sliceSession(bars, strategy.universe, window, step);
  const decision = decideSlot(strategy, window, et.date, slotBars, earlier, history, ctx.state.cashUsd, {
    after: progress.lastBarTime,
    onBar: (time) => { progress.lastBarTime = time; },
    exclude: tradedToday,
  });
  if (decision.error) {
    progress.fired = true;
    event(ctx.state, ctx.at, "error", `${strategy.name} 규칙 오류 (${decision.signalTime}): ${decision.error} — 오늘 이 규칙은 쉽니다`);
    return;
  }
  if (!decision.order || !decision.signalTime) return;

  progress.entries = (progress.entries ?? 0) + 1;
  if (progress.entries >= (strategy.maxEntriesPerDay ?? 1)) progress.fired = true;
  const order = decision.order;
  const signalStartMs = easternWallTimeToEpoch(et.date, decision.signalTime);
  const problem = orderProblem(order, strategy.universe);
  const quote = problem ? null : await quoteFor(ctx, order.symbol);
  const windowEndMs = latestCompleteBarStart(easternWallTimeToEpoch(et.date, window.to), step) + barMs;
  // The fill is due at the next bar's open, so a time exit counts from there.
  const holdEndMs = strategy.maxHoldMinutes ? signalStartMs + barMs + Math.max(1, Math.floor(strategy.maxHoldMinutes / step)) * barMs : Infinity;
  const trade: DashboardTrade = {
    id: ctx.deps.id(), strategyId: strategy.id, strategyName: strategy.name, slot: strategy.slot,
    symbol: String(order.symbol ?? "?"), date: et.date, status: "entering", reason: order.reason ?? "",
    barMinutes: step,
    signalTime: decision.signalTime, decidedAt: new Date(signalStartMs + barMs).toISOString(),
    referencePrice: quote ? (ctx.deps.broker.mode === "paper" ? quote.price : quote.ask ?? quote.price) : 0,
    stopPct: order.stopPct, targetPct: order.targetPct,
    slotEndsAt: new Date(Math.min(windowEndMs, holdEndMs)).toISOString(),
    equityAtEntryUsd: equityOf(ctx.state).equity,
    boughtQuantity: 0, soldQuantity: 0, buyNotionalUsd: 0, sellNotionalUsd: 0,
    entryPrice: null, entryAt: null, exitPrice: null, exitAt: null, exit: null, pendingExit: null, exitAttempts: 0,
    markPrice: quote?.price ?? null, checkedThroughMs: null, commissionUsd: 0,
    pnlUsd: null, returnPct: null, compliant: null, violations: [], entrySlippagePct: null,
  };
  ctx.state.trades.push(trade);
  stats(ctx, trade).signals += 1;
  event(ctx.state, ctx.at, "signal", `${strategy.name} 신호 ${decision.signalTime} ${step}분봉 — ${trade.symbol} (${trade.reason})`);

  if (problem) return markMissed(ctx, trade, `규칙 위반 주문: ${problem}`);
  if (ctx.deps.now() >= signalStartMs + 2 * barMs) {
    return markMissed(ctx, trade, "체결해야 할 다음 봉이 이미 지남 (틱이 늦게 들어옴)");
  }
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) return markMissed(ctx, trade, "유효한 시세 없음");
  const execution = strategy.execution;
  const signalBar = slotBars[trade.symbol]?.find(bar => bar.time === decision.signalTime);
  if (execution) {
    if (!ctx.deps.broker.entryProblem) return markMissed(ctx, trade, "거래 세션·계좌 사전 확인 기능 없음");
    const entryProblem = await ctx.deps.broker.entryProblem(trade.symbol, strategy.slot, et.date, { from: window.from, to: window.to }).catch(() => "거래 세션·계좌 사전 조회 실패");
    if (entryProblem) return markMissed(ctx, trade, entryProblem);
    const quoteAge = quote.timestamp ? ctx.nowMs - Date.parse(quote.timestamp) : Infinity;
    const bookAge = quote.bookTimestamp ? ctx.nowMs - Date.parse(quote.bookTimestamp) : Infinity;
    if (!Number.isFinite(quoteAge) || quoteAge < -5000 || quoteAge > 60000 || !Number.isFinite(bookAge) || bookAge < -5000 || bookAge > 60000) return markMissed(ctx, trade, "시세·호가 시각 확인 실패 또는 60초 초과");
    if (!signalBar || signalBar.date !== et.date || signalBar.volume <= 0) return markMissed(ctx, trade, "유효한 신호 봉 없음");
    if (!(quote.bid && quote.ask && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.bid > 0 && quote.ask >= quote.bid)) return markMissed(ctx, trade, "양방향 호가 확인 실패");
    if ((quote.ask / quote.bid - 1) * 100 > execution.maxSpreadPct) return markMissed(ctx, trade, "허용 스프레드 초과");
    if (Math.abs(trade.referencePrice / signalBar.close - 1) * 100 > execution.maxEntryDriftPct) return markMissed(ctx, trade, "신호 대비 진입 가격 이탈");
    const daily = ctx.state.daily.find(day => day.date === et.date);
    const dayStart = daily?.startEquityUsd ?? ctx.state.daily.at(-1)?.equityUsd ?? ctx.state.initialCapitalUsd;
    if ((equityOf(ctx.state).equity / dayStart - 1) * 100 <= -execution.maxDailyLossPct) return markMissed(ctx, trade, "일 손실 한도 — 신규 진입 중지");
  }

  const band = ctx.deps.broker.mode === "paper" && !execution ? 0 : Math.min(ctx.deps.limitBandPct, execution?.maxEntryDriftPct ?? Infinity);
  const limitPrice = ctx.deps.broker.mode === "paper" && !execution ? null : Number(usLimitPrice(Math.min(trade.referencePrice * (1 + band / 100), execution && signalBar ? signalBar.close * (1 + execution.maxEntryDriftPct / 100) : Infinity)));
  const perShareCostPct = ctx.deps.broker.mode === "paper" ? costPerSidePct(trade.symbol) : feePerSidePct();
  let budget = ctx.state.cashUsd;
  if (ctx.deps.broker.buyingPowerUsd) {
    const power = await ctx.deps.broker.buyingPowerUsd().catch(() => null);
    if (power === null || !Number.isFinite(power) || power < 0) return markMissed(ctx, trade, "토스 주문 가능 금액 확인 실패 — 신규 주문 중단");
    if (power < budget) {
      budget = power;
      event(ctx.state, ctx.at, "warn", `토스 매수가능금액 $${power.toFixed(2)}가 대시보드 현금보다 적어 그만큼만 매수합니다.`);
    }
  }
  if (ctx.deps.broker.mode === "live" && !ctx.deps.broker.buyingPowerUsd) return markMissed(ctx, trade, "주문 가능 금액 조회 기능 없음");
  budget *= 1 - (execution?.reservePct ?? 0) / 100;
  const quantity = Math.min(Math.floor(budget / ((limitPrice ?? trade.referencePrice) * (1 + perShareCostPct / 100))), execution ? Math.floor((signalBar?.volume ?? 0) * execution.participationPct / 100) : Infinity);
  if (quantity < 1) return markMissed(ctx, trade, `잔고 $${budget.toFixed(2)}로 1주도 못 삼`);
  // Candle/account requests can cross a short strategy's entire fill window.
  // Recheck the real clock immediately before persisting/submitting the intent.
  const submitMs = ctx.deps.now();
  if (submitMs >= signalStartMs + 2 * barMs || submitMs >= Date.parse(trade.slotEndsAt)) {
    return markMissed(ctx, trade, "조회 중 다음 전략 봉의 진입 시간이 지남");
  }
  ctx.nowMs = submitMs;
  ctx.at = new Date(submitMs).toISOString();
  await placeOrder(ctx, trade, { side: "buy", purpose: "entry", quantity, limitPrice, referencePrice: trade.referencePrice, attempt: 1 });
}

/** The three-step stop: cancel buys → sell the dashboard's holdings → confirm fills. */
async function advanceStop(ctx: Ctx) {
  const state = ctx.state;
  if (state.stopPhase === "cancel_buys") {
    const buys = state.orders.filter((order) => order.side === "buy" && isActiveOrder(order));
    for (const order of buys.filter((item) => item.status === "working")) {
      try {
        await ctx.deps.broker.cancel(order);
        order.status = "cancel_requested";
        order.updatedAt = ctx.at;
        event(state, ctx.at, "order", `미체결 매수 취소 요청 — ${order.symbol} ${order.quantity - order.filledQuantity}주`);
      } catch (error) {
        event(state, ctx.at, "warn", `${order.symbol} 매수 취소 실패: ${error instanceof Error ? error.message : "알 수 없음"}`);
      }
    }
    // A cancel is only done when the broker says so; a partial fill before it
    // becomes a holding the next step sells.
    if (state.orders.some((order) => order.side === "buy" && isActiveOrder(order))) return;
    for (const trade of state.trades.filter((item) => item.status === "entering" && item.boughtQuantity === 0)) markMissed(ctx, trade, "정지로 진입 취소");
    state.stopPhase = "liquidate";
    event(state, ctx.at, "info", "① 미체결 매수 취소 완료");
  }

  if (state.stopPhase === "liquidate") {
    const held = state.trades.filter((trade) => heldQuantity(trade) > 0);
    for (const trade of held.filter((item) => !hasActive(ctx, item, "sell"))) {
      await submitExit(ctx, trade, trade.pendingExit ?? "shutdown");
    }
    if (held.some((trade) => !hasActive(ctx, trade, "sell"))) return;
    state.stopPhase = "confirm";
    event(state, ctx.at, "info", held.length ? `② 보유 ${held.length}종목 매도 주문 완료 — 체결 확인 중` : "② 대시보드가 매수한 보유 종목 없음");
  }

  if (state.stopPhase === "confirm") {
    const held = state.trades.filter((trade) => heldQuantity(trade) > 0);
    if (held.some((trade) => !hasActive(ctx, trade, "sell"))) {
      // A sell timed out and was canceled — go back and send it again.
      state.stopPhase = "liquidate";
      return;
    }
    if (held.length || state.orders.some(isActiveOrder)) return;
    state.status = "stopped";
    state.stopPhase = null;
    state.stoppedAt = ctx.at;
    const { equity } = equityOf(state);
    event(state, ctx.at, "info", `③ 체결 확인 — 정지 완료. 최종 자산 $${equity.toFixed(2)} (${((equity / state.initialCapitalUsd - 1) * 100).toFixed(2)}%)`);
  }
}

async function markToMarket(ctx: Ctx) {
  const state = ctx.state;
  for (const trade of state.trades.filter((item) => heldQuantity(item) > 0)) {
    const quote = await quoteFor(ctx, trade.symbol);
    if (quote) trade.markPrice = quote.price;
  }
  const { equity } = equityOf(state);
  const et = easternParts(ctx.nowMs);
  if (isWeekday(et.date) && (state.status !== "stopped" || state.stoppedAt === ctx.at)) {
    let row = state.daily.find((item) => item.date === et.date);
    if (!row) {
      row = { date: et.date, startEquityUsd: state.daily.at(-1)?.equityUsd ?? state.initialCapitalUsd, equityUsd: equity, pnlUsd: 0, returnPct: 0, trades: 0 };
      state.daily.push(row);
    }
    row.equityUsd = equity;
    row.pnlUsd = round(equity - row.startEquityUsd, 2);
    row.returnPct = row.startEquityUsd > 0 ? round((equity / row.startEquityUsd - 1) * 100) : 0;
    row.trades = state.trades.filter((trade) => trade.date === et.date && trade.entryAt).length;
  }
  state.peakEquityUsd = Math.max(state.peakEquityUsd, equity);
  state.maxDrawdownPct = round(Math.max(state.maxDrawdownPct, state.peakEquityUsd > 0 ? ((state.peakEquityUsd - equity) / state.peakEquityUsd) * 100 : 0), 4);
}

function prune(state: DashboardState, nowMs: number) {
  const today = easternParts(nowMs).date;
  for (const key of Object.keys(state.slotProgress)) if (!key.startsWith(today)) delete state.slotProgress[key];
  const activeOrders = state.orders.filter(isActiveOrder);
  state.orders = [...state.orders.filter((order) => !isActiveOrder(order)).slice(-MAX_FINISHED_ORDERS), ...activeOrders]
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  const live = (trade: DashboardTrade) => trade.status === "entering" || heldQuantity(trade) > 0 || state.orders.some((order) => order.tradeId === trade.id && isActiveOrder(order));
  state.trades = [...state.trades.filter((trade) => !live(trade)).slice(-MAX_FINISHED_TRADES), ...state.trades.filter(live)];
  state.events = state.events.slice(-MAX_EVENTS);
}

/**
 * Advances one dashboard by one step. Safe to call as often as the caller
 * likes: a tick with nothing to do changes only `lastTickAt`.
 */
export async function tickDashboard(input: DashboardState, deps: EngineDeps): Promise<DashboardState> {
  const state = structuredClone(input);
  const nowMs = deps.now();
  const ctx: Ctx = { state, deps, nowMs, at: new Date(nowMs).toISOString(), quotes: new Map() };
  state.lastTickAt = ctx.at;
  if (state.status === "stopped") return state;
  state.lastError = null;

  await reconcileOrders(ctx);
  if (state.status === "running") {
    await manageExits(ctx);
    await scanEntries(ctx);
  } else if (state.status === "stopping") {
    await advanceStop(ctx);
  }
  await markToMarket(ctx);
  prune(state, nowMs);
  return state;
}

/**
 * Paper execution against real quotes: fills at the last price and charges the
 * same per-symbol commission-plus-spread the backtest charges, so paper and
 * backtest differ only in *when* the runner saw the price.
 */
export function createPaperBroker(quote: (symbol: string) => Promise<BrokerQuote>): DashboardBroker {
  return {
    mode: "paper",
    quote,
    async submit(request) {
      const current = await quote(request.symbol);
      if (!current || !(current.price > 0)) throw new BrokerRejection(`${request.symbol} 시세가 없어 모의 체결할 수 없습니다.`, "no-quote");
      if (request.limitPrice !== null && (request.side === "buy" ? current.price > request.limitPrice : current.price < request.limitPrice)) throw new BrokerRejection("모의 주문 지정가 범위를 벗어났습니다.", "limit-price");
      const costPct = costPerSidePct(request.symbol) + (request.side === "sell" ? TOSS_US_EQUITY.secSellFeePct : 0);
      return {
        brokerOrderId: `paper-${request.clientOrderId}`,
        state: {
          status: "filled", filledQuantity: request.quantity, averageFillPrice: current.price,
          commissionUsd: round(request.quantity * current.price * (costPct / 100), 6),
        },
      };
    },
    async poll(order) {
      return {
        status: order.status === "cancel_requested" ? "canceled" : order.filledQuantity >= order.quantity ? "filled" : "working",
        filledQuantity: order.filledQuantity, averageFillPrice: order.averageFillPrice, commissionUsd: order.commissionUsd,
      };
    },
    async cancel() { /* paper orders fill on submit; nothing is ever resting */ },
  };
}

/** The view the dashboard renders, derived from state so it can never drift from it. */
export function dashboardSummary(state: DashboardState) {
  const { positionsValue, equity } = equityOf(state);
  const stats = Object.values(state.strategies);
  const realized = stats.reduce((sum, row) => sum + row.pnlUsd, 0);
  const openCost = state.trades.filter((trade) => heldQuantity(trade) > 0).reduce((sum, trade) => {
    const held = heldQuantity(trade);
    const basis = trade.boughtQuantity > 0 ? (trade.buyNotionalUsd / trade.boughtQuantity) * held : 0;
    return sum + held * (trade.markPrice ?? trade.entryPrice ?? 0) - basis;
  }, 0);
  const closed = stats.reduce((sum, row) => sum + row.closed, 0);
  const compliant = stats.reduce((sum, row) => sum + row.compliant, 0);
  // Closed trades' costs live in the per-strategy totals, which are never pruned.
  const commission = stats.reduce((sum, row) => sum + row.commissionUsd, 0)
    + state.trades.filter((trade) => trade.status !== "closed").reduce((sum, trade) => sum + trade.commissionUsd, 0);
  return {
    positionsValueUsd: positionsValue,
    equityUsd: equity,
    totalPnlUsd: round(equity - state.initialCapitalUsd, 2),
    totalReturnPct: round((equity / state.initialCapitalUsd - 1) * 100),
    realizedPnlUsd: round(realized, 2),
    unrealizedPnlUsd: round(openCost, 2),
    commissionUsd: round(commission, 2),
    adherencePct: closed ? round((compliant / closed) * 100, 2) : null,
    signals: stats.reduce((sum, row) => sum + row.signals, 0),
    missedSignals: stats.reduce((sum, row) => sum + row.missed, 0),
  };
}
