/**
 * Wires the trading engine to the world: D1 for state, Toss for quotes, minute
 * candles and orders, Massive for warm-up sessions.
 *
 * Who calls `tickDashboards`: the 전략 tab while it is open, and
 * `scripts/trading-runner.mjs` when trading must continue with the tab closed.
 * Both may call at once; a D1 lease makes one tick run at a time and a minimum
 * gap keeps the two from doubling the pace. Nothing here is on a timer of its
 * own — a Worker cannot keep one — which is why the dashboard shows whether the
 * background runner is online.
 *
 * Toss only accepts calls from registered IP addresses. A local runner (the
 * owner's machine) meets that; the deployed Worker's shared egress usually does
 * not, and the readiness reasons say so instead of failing silently.
 */

import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db/ensure";
import type { DashboardBrokerBalance, DashboardMode, DashboardState, DashboardStrategyStats, TradingDashboardResponse, TradingDashboardView } from "@/lib/dashboard-types";
import {
  BrokerRejection, createPaperBroker, dashboardSummary, DASHBOARD_CAPITAL_USD, emptyDashboard, event, heldQuantity, isActiveOrder,
  requestStop, startDashboard, tickDashboard, type DashboardBroker, type DashboardMarketData, type EngineDeps,
} from "@/lib/trading-engine";
import { registeredRelayStrategies } from "@/lib/strategy-generation-store";
import { refreshIntradaySurgePool } from "@/lib/surge-intraday-live";
import { todaysSurgeStrategies } from "@/lib/surge-slot-strategies";
import type { SlotStrategy } from "@/lib/relay-engine";
import { fetchTossMinuteCandles, fetchTossQuote, fetchTossTradingDay } from "@/lib/market-data";
import {
  tossBuyingPower, tossCancelOrder, tossCreateOrder, tossGetOrder, tossHoldings, tossPrimaryAccount, tossSellableQuantity,
  tossTradingStatus, tossListOrders, TossOrderError, type TossTradingStatus,
} from "@/lib/toss-orders";
import { usLimitPrice } from "@/lib/toss-order-shapes";
import { aggregateMinuteCandles, parseTossCandle, rangeAfter, type MinuteCandle } from "@/lib/live-bars";
import { easternWallTimeToEpoch, shiftDate } from "@/lib/market-clock";
import { loadRelaySessions } from "@/lib/relay-data";
import { feePerSidePct } from "@/lib/broker-costs";
import { slotById } from "@/lib/trade-slots";
import { adherencePct } from "@/lib/trade-adherence";

export const LIVE_CONFIRM_PHRASE = "실거래 시작";
export const RUNNER_INTERVAL_SECONDS = 15;
const MODES: DashboardMode[] = ["live", "paper"];

/**
 * Two independent books, four dashboards.
 *
 * `relay` runs the slot rules registered from the 전략 tab; `surge` runs the
 * rules registered from 투자 › 급등주 against that day's ranking pool. They keep
 * separate state rows, separate capital and separate strategy lists, so a click
 * on one board can never place an order the other board's evidence describes —
 * which is the whole reason the 급등주 dashboard is not the 전략 dashboard with a
 * different heading.
 */
export type TradingBook = "relay" | "surge";
export const TRADING_BOOKS: TradingBook[] = ["relay", "surge"];
const rowId = (book: TradingBook, mode: DashboardMode) => (book === "relay" ? mode : `surge-${mode}`);
const LEASE_MS = 120_000;
/** The page and the runner both tick; closer than this, the second one is skipped. */
const MIN_TICK_GAP_MS = 8_000;
const RUNNER_ONLINE_MS = 45_000;
const BALANCE_REFRESH_MS = 60_000;

export class TradingUserError extends Error {}

function setting(name: string) {
  const bindings = env as unknown as Record<string, string | undefined>;
  const value = bindings[name] ?? process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function limitBandPct() {
  const parsed = Number(setting("TRADING_LIMIT_BAND_PCT") ?? "1");
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : 1;
}

function d1() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  return binding;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- storage

type Row = { state_payload: string; lease_owner: string | null; lease_until: number | null; last_tick_at: number | null; runner_heartbeat_at: number | null };

function parseState(payload: string, mode: DashboardMode): DashboardState {
  try {
    const parsed = JSON.parse(payload) as Partial<DashboardState>;
    if (parsed && parsed.version === 1) return { ...emptyDashboard(mode), ...parsed, mode };
  } catch {
    // fall through to a fresh dashboard
  }
  return emptyDashboard(mode);
}

async function readRow(book: TradingBook, mode: DashboardMode) {
  await ensureSchema();
  const id = rowId(book, mode);
  let row = await d1().prepare("SELECT state_payload, lease_owner, lease_until, last_tick_at, runner_heartbeat_at FROM trading_dashboards WHERE id = ?").bind(id).first<Row>();
  if (!row) {
    await d1().prepare("INSERT OR IGNORE INTO trading_dashboards (id, state_payload, updated_at) VALUES (?, ?, ?)").bind(id, JSON.stringify(emptyDashboard(mode)), Date.now()).run();
    row = await d1().prepare("SELECT state_payload, lease_owner, lease_until, last_tick_at, runner_heartbeat_at FROM trading_dashboards WHERE id = ?").bind(id).first<Row>();
  }
  return { state: parseState(row?.state_payload ?? "", mode), lastTickAt: row?.last_tick_at ?? null, runnerHeartbeatAt: row?.runner_heartbeat_at ?? null };
}

async function acquireLease(book: TradingBook, mode: DashboardMode, owner: string) {
  const now = Date.now();
  const result = await d1().prepare("UPDATE trading_dashboards SET lease_owner = ?, lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)")
    .bind(owner, now + LEASE_MS, rowId(book, mode), now).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function releaseLease(book: TradingBook, mode: DashboardMode, owner: string) {
  await d1().prepare("UPDATE trading_dashboards SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?").bind(rowId(book, mode), owner).run();
}

async function saveState(book: TradingBook, mode: DashboardMode, owner: string, state: DashboardState) {
  const now = Date.now();
  const result = await d1().prepare("UPDATE trading_dashboards SET state_payload = ?, last_tick_at = ?, updated_at = ?, lease_until = ? WHERE id = ? AND lease_owner = ?")
    .bind(JSON.stringify(state), now, now, now + LEASE_MS, rowId(book, mode), owner).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error("대시보드 잠금을 잃어 상태를 저장하지 못했습니다.");
}

/** Runs `change` on the freshest state while holding the lease, waiting for a running tick to finish. */
async function withLease(book: TradingBook, mode: DashboardMode, change: (state: DashboardState) => Promise<DashboardState> | DashboardState, waitMs = 25_000) {
  await readRow(book, mode);
  const owner = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  while (!(await acquireLease(book, mode, owner))) {
    if (Date.now() > deadline) throw new TradingUserError("대시보드가 다른 작업(틱)으로 갱신 중입니다. 잠시 후 다시 시도하세요.");
    await sleep(400);
  }
  try {
    const { state } = await readRow(book, mode);
    const next = await change(state);
    await saveState(book, mode, owner, next);
    return next;
  } finally {
    await releaseLease(book, mode, owner).catch(() => undefined);
  }
}

// -------------------------------------------------------------- market data

type CandleCache = { date: string; candles: Map<number, MinuteCandle>; coveredFrom: number; coveredTo: number };
const candleCache = new Map<string, CandleCache>();

/**
 * Minute candles covering [needFromMs, now]. Warm: one small request for the
 * minutes since the last fetch. Cold, a new day, or a gap longer than one page:
 * page back from now until `needFromMs`.
 */
async function candlesFor(symbol: string, date: string, needFromMs: number, nowMs: number) {
  let entry = candleCache.get(symbol);
  if (!entry || entry.date !== date) {
    entry = { date, candles: new Map(), coveredFrom: Number.POSITIVE_INFINITY, coveredTo: 0 };
    candleCache.set(symbol, entry);
  }
  const merge = (raw: Parameters<typeof parseTossCandle>[0][]) => {
    const parsed = raw.map(parseTossCandle).filter((candle): candle is MinuteCandle => candle !== null);
    for (const candle of parsed) entry!.candles.set(candle.endMs, candle);
    return parsed;
  };
  const sinceMinutes = Math.ceil((nowMs - entry.coveredTo) / 60_000) + 3;
  if (entry.coveredFrom <= needFromMs && sinceMinutes <= 200) {
    if (nowMs - entry.coveredTo > 3_000) {
      merge((await fetchTossMinuteCandles(symbol, { count: Math.max(5, sinceMinutes) })).candles);
      entry.coveredTo = nowMs;
    }
    return entry;
  }
  entry.candles.clear();
  let before: string | null = null;
  let reached = Number.POSITIVE_INFINITY;
  for (let page = 0; page < 8; page += 1) {
    const result: Awaited<ReturnType<typeof fetchTossMinuteCandles>> = await fetchTossMinuteCandles(symbol, { count: 200, before });
    const parsed = merge(result.candles);
    if (!parsed.length) break;
    reached = Math.min(reached, ...parsed.map((candle) => candle.endMs));
    if (reached <= needFromMs || !result.nextBefore) break;
    before = result.nextBefore;
  }
  entry.coveredFrom = needFromMs;
  entry.coveredTo = nowMs;
  return entry;
}

const priorCache = new Map<string, Promise<Awaited<ReturnType<typeof loadRelaySessions>>>>();

const tossMarket: DashboardMarketData = {
  async sessionBars(symbol, date, nowMs, step = 5, from = "04:00") {
    const entry = await candlesFor(symbol, date, easternWallTimeToEpoch(date, from), nowMs);
    return aggregateMinuteCandles([...entry.candles.values()], nowMs, step).filter((bar) => bar.date === date && bar.time >= from);
  },
  async priorSessions(symbol, date, count, step = 5) {
    const key = `${symbol}|${date}|${count}|${step}`;
    if (!priorCache.has(key)) {
      priorCache.set(key, loadRelaySessions([symbol], shiftDate(date, -Math.ceil(count * 1.5) - 7), shiftDate(date, -1), 0, () => undefined, step));
    }
    const loaded = await priorCache.get(key)!;
    return loaded.sessions.slice(-count).map((session) => session.bars[symbol] ?? []);
  },
  async range(symbol, fromMs, toMs) {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(toMs));
    const entry = await candlesFor(symbol, date, fromMs, toMs);
    return rangeAfter([...entry.candles.values()], fromMs, toMs);
  },
};

// ------------------------------------------------------------------- brokers

function asRejection(error: unknown) {
  if (error instanceof TossOrderError && error.status >= 400 && error.status < 500) {
    return new BrokerRejection(`[${error.code}] ${error.message}`, error.code);
  }
  return error;
}

async function sessionProblem(_symbol: string, slotId: SlotStrategy["slot"], date: string, window?: { from: string; to: string }): Promise<string | null> {
  const day = await fetchTossTradingDay(date), slot = { ...slotById(slotId)!, ...window };
  const session = slot.session === "premarket" ? day?.preMarket : slot.session === "regular" ? day?.regularMarket : day?.afterMarket;
  if (!session) return "브로커 달력에 거래 세션이 없습니다.";
  const start = Date.parse(session.startTime), end = Date.parse(session.endTime);
  const now = Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) return "브로커 거래 세션 밖입니다.";
  if (start > easternWallTimeToEpoch(date, slot.from) || end < easternWallTimeToEpoch(date, slot.to)) return "조기 폐장·단축 세션 — 이 슬롯은 쉬어갑니다.";
  return null;
}

async function tossLiveBroker(): Promise<DashboardBroker> {
  const account = await tossPrimaryAccount();
  if (!account) throw new Error("주문 가능한 토스 BROKERAGE 계좌를 찾지 못했습니다.");
  const seq = account.accountSeq;
  return {
    mode: "live",
    async entryProblem(symbol, slot, date, window) {
      const calendar = await sessionProblem(symbol, slot, date, window);
      if (calendar) return calendar;
      const orders = await tossListOrders(seq, "OPEN");
      if (orders.length) return "계좌에 미체결 주문이 있어 신규 진입을 보류합니다.";
      const holdings = await tossHoldings(seq);
      if (holdings.items.some(item => !Number.isFinite(Number(item.quantity)))) return "브로커 보유 수량을 확인할 수 없습니다.";
      if (holdings.items.some(item => item.symbol === symbol && Number(item.quantity) > 0)) return "수동 매수 또는 미조정 보유 종목과 겹칩니다.";
      return null;
    },
    quote: (symbol) => fetchTossQuote(symbol, { withBook: true }),
    async submit(request) {
      if (setting("TOSS_TRADING_DISABLED") === "true") throw new BrokerRejection("TOSS_TRADING_DISABLED=true 로 실주문이 잠겨 있습니다.", "disabled");
      try {
        // A marketable DAY limit: accepted in pre-, regular and after-market
        // alike (measured 2026-09-09), and capped so a thin book cannot fill it anywhere.
        const result = await tossCreateOrder(seq, {
          clientOrderId: request.clientOrderId, symbol: request.symbol, side: request.side === "buy" ? "BUY" : "SELL",
          orderType: "LIMIT", timeInForce: "DAY", quantity: String(request.quantity),
          price: usLimitPrice(request.limitPrice ?? request.referencePrice),
        });
        return { brokerOrderId: result.orderId };
      } catch (error) {
        throw asRejection(error);
      }
    },
    async poll(order) {
      if (!order.brokerOrderId) throw new Error("주문번호 없음");
      const snapshot = await tossGetOrder(seq, order.brokerOrderId);
      const filled = Number(snapshot.execution?.filledQuantity ?? 0) || 0;
      const average = snapshot.execution?.averageFilledPrice ? Number(snapshot.execution.averageFilledPrice) : null;
      const reported = [snapshot.execution?.commission, snapshot.execution?.tax].map((value) => (value === null || value === undefined ? Number.NaN : Number(value))).filter(Number.isFinite);
      const commissionUsd = reported.length ? reported.reduce((sum, value) => sum + value, 0) : filled && average ? filled * average * (feePerSidePct() / 100) : 0;
      const status = snapshot.status === "FILLED" ? "filled"
        : snapshot.status === "CANCELED" || snapshot.status === "REPLACED" ? "canceled"
          : snapshot.status === "REJECTED" ? "rejected" : "working";
      return { status, filledQuantity: filled, averageFillPrice: average, commissionUsd, message: status === "rejected" ? "토스가 주문을 거부했습니다" : null };
    },
    async cancel(order) {
      if (!order.brokerOrderId) return;
      try {
        await tossCancelOrder(seq, order.brokerOrderId);
      } catch (error) {
        // Already filled or already canceled: the next poll shows which.
        if (error instanceof TossOrderError && error.status >= 400 && error.status < 500) return;
        throw error;
      }
    },
    buyingPowerUsd: () => tossBuyingPower(seq, "USD"),
    sellableQuantity: (symbol) => tossSellableQuantity(seq, symbol),
  };
}

const paperBroker: DashboardBroker = { ...createPaperBroker((symbol) => fetchTossQuote(symbol, { withBook: true })), entryProblem: sessionProblem };

/** The rules a book may trade. Nothing else can reach its engine. */
async function bookStrategies(book: TradingBook): Promise<SlotStrategy[]> {
  return book === "relay" ? registeredRelayStrategies() : todaysSurgeStrategies();
}

async function engineDeps(book: TradingBook, mode: DashboardMode, state: DashboardState, leaseOwner: string): Promise<EngineDeps> {
  const registered = await bookStrategies(book);
  return {
    checkpoint: (next) => saveState(book, mode, leaseOwner, next),
    now: () => Date.now(),
    id: () => crypto.randomUUID(),
    strategies: registered.filter(strategy => (state.strategyIds ?? []).includes(strategy.id)),
    broker: mode === "live" ? await tossLiveBroker() : paperBroker,
    market: tossMarket,
    limitBandPct: limitBandPct(),
  };
}

async function refreshBalance(previous: DashboardBrokerBalance | null): Promise<DashboardBrokerBalance | null> {
  if (previous && !previous.error && Date.now() - Date.parse(previous.fetchedAt) < BALANCE_REFRESH_MS) return previous;
  try {
    const account = await tossPrimaryAccount();
    if (!account) throw new Error("토스 계좌 없음");
    const cash = await tossBuyingPower(account.accountSeq, "USD");
    const holdings = await tossHoldings(account.accountSeq);
    const usHoldings = holdings.items.filter((item) => item.currency === "USD" || item.marketCountry === "US")
      .reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.lastPrice) || 0), 0);
    return { accountNo: account.accountNo, cashBuyingPowerUsd: cash, holdingsValueUsd: Number((holdings.marketValueUsd || usHoldings).toFixed(2)), fetchedAt: new Date().toISOString(), error: null };
  } catch (error) {
    return { accountNo: previous?.accountNo ?? null, cashBuyingPowerUsd: previous?.cashBuyingPowerUsd ?? null, holdingsValueUsd: previous?.holdingsValueUsd ?? null, fetchedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "잔고 조회 실패" };
  }
}

// --------------------------------------------------------------------- ticks

async function tickOne(book: TradingBook, mode: DashboardMode, options: { force?: boolean } = {}) {
  const row = await readRow(book, mode);
  if (row.state.status === "stopped") return "idle";
  if (!options.force && row.lastTickAt && Date.now() - row.lastTickAt < MIN_TICK_GAP_MS) return "recent";
  const owner = crypto.randomUUID();
  if (!(await acquireLease(book, mode, owner))) return "busy";
  try {
    const { state } = await readRow(book, mode);
    if (state.status === "stopped") return "idle";
    let next: DashboardState;
    try {
      next = await tickDashboard(state, await engineDeps(book, mode, state, owner));
    } catch (error) {
      next = structuredClone((await readRow(book, mode)).state);
      next.lastTickAt = new Date().toISOString();
      event(next, next.lastTickAt, "error", `틱 실패: ${error instanceof Error ? error.message : "알 수 없음"}`);
    }
    if (mode === "live") next.brokerBalance = await refreshBalance(next.brokerBalance);
    await saveState(book, mode, owner, next);
    return "ticked";
  } finally {
    await releaseLease(book, mode, owner).catch(() => undefined);
  }
}

/** Runs independently of order management, so discovery cannot delay exits. */
export async function refreshSurgeObservationsIfRunning() {
  const rows = await Promise.all(MODES.map(mode => readRow("surge", mode)));
  if (rows.some(row => row.state.status === "running")) await refreshIntradaySurgePool();
}

export async function tickDashboards(source: "page" | "runner") {
  await ensureSchema();
  if (source === "runner") {
    await Promise.all(TRADING_BOOKS.flatMap((book) => MODES.map((mode) => readRow(book, mode))));
    await d1().prepare("UPDATE trading_dashboards SET runner_heartbeat_at = ?").bind(Date.now()).run();
  }
  const results: Record<string, string> = {};
  for (const book of TRADING_BOOKS) {
    for (const mode of MODES) {
      const key = rowId(book, mode);
      try {
        results[key] = await tickOne(book, mode);
      } catch (error) {
        results[key] = `error: ${error instanceof Error ? error.message : "unknown"}`;
      }
    }
  }
  return results;
}

// ------------------------------------------------------------ start and stop

let tossStatusCache: { value: TossTradingStatus; at: number } | null = null;

async function cachedTossStatus(force = false) {
  if (!force && tossStatusCache && Date.now() - tossStatusCache.at < 30_000) return tossStatusCache.value;
  const value = await tossTradingStatus().catch((error): TossTradingStatus => ({
    ready: false, reason: error instanceof Error ? error.message : "토스 상태 확인 실패", cause: "unknown",
    egressIp: null, account: null, buyingPowerUsd: null, usCommissionRate: null, usCommissionEndDate: null, orderMode: "loc",
  }));
  tossStatusCache = { value, at: Date.now() };
  return value;
}

let quoteProbe: { ok: boolean; reason: string | null; at: number } | null = null;

async function tossQuotesReachable(force = false) {
  if (!force && quoteProbe && Date.now() - quoteProbe.at < 60_000) return quoteProbe;
  try {
    await fetchTossQuote("AAPL");
    quoteProbe = { ok: true, reason: null, at: Date.now() };
  } catch (error) {
    quoteProbe = { ok: false, reason: error instanceof Error ? error.message : "토스 시세 조회 실패", at: Date.now() };
  }
  return quoteProbe;
}

export async function startTrading(book: TradingBook, mode: DashboardMode, confirm: string | undefined) {
  if (mode === "live") {
    if (confirm !== LIVE_CONFIRM_PHRASE) throw new TradingUserError(`실거래를 시작하려면 확인 문구 “${LIVE_CONFIRM_PHRASE}”를 정확히 입력하세요.`);
    const toss = await cachedTossStatus(true);
    if (!toss.ready) throw new TradingUserError(`토스 계좌가 준비되지 않았습니다: ${toss.reason ?? toss.cause}`);
    if ((toss.buyingPowerUsd ?? 0) < DASHBOARD_CAPITAL_USD) {
      throw new TradingUserError(`USD 매수가능금액 $${(toss.buyingPowerUsd ?? 0).toFixed(2)}가 시작 자본 $${DASHBOARD_CAPITAL_USD.toLocaleString("en-US")}보다 적습니다.`);
    }
  } else {
    const probe = await tossQuotesReachable(true);
    if (!probe.ok) throw new TradingUserError(`모의투자도 토스 실시간 시세로 체결합니다. 시세를 가져오지 못했습니다: ${probe.reason}`);
  }
  const strategies = await bookStrategies(book);
  if (!strategies.length) {
    throw new TradingUserError(book === "relay"
      ? "전략 탭에서 검증된 슬롯 전략을 먼저 생성하세요."
      : "급등주 탭에서 검증을 통과한 규칙을 먼저 생성하세요. 당일 사건은 실행 중 관측합니다.");
  }
  const note = `${book === "relay" ? "슬롯" : "급등주"} 전략 ${strategies.length}개`;
  await withLease(book, mode, (state) => ({ ...startDashboard(state, { now: () => Date.now(), id: () => crypto.randomUUID() }, note), strategyIds: strategies.map(strategy => strategy.id) }));
  await tickOne(book, mode, { force: true }).catch(() => undefined);
}

export async function stopTrading(book: TradingBook, mode: DashboardMode) {
  await withLease(book, mode, (state) => requestStop(state, Date.now()));
  // Start the cancel step now rather than on the next scheduled tick.
  await tickOne(book, mode, { force: true }).catch(() => undefined);
}

// --------------------------------------------------------------------- views

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function view(state: DashboardState, readiness: { ready: boolean; reasons: string[] }, RELAY_STRATEGIES: SlotStrategy[]): TradingDashboardView {
  const summary = dashboardSummary(state);
  const zero = (id: string, name: string, slot: DashboardStrategyStats["slot"]): DashboardStrategyStats => ({ id, name, slot, signals: 0, entries: 0, missed: 0, closed: 0, compliant: 0, deviations: 0, wins: 0, pnlUsd: 0, commissionUsd: 0 });
  const decorate = (stats: DashboardStrategyStats, extra: { summary: string; universe: string[]; registered: boolean; window?: SlotStrategy["window"]; barMinutes?: number }) => ({
    ...stats, summary: extra.summary, universe: extra.universe, registered: extra.registered,
    slotLabel: `${extra.window ? `${extra.window.from}–${extra.window.to} ET` : slotById(stats.slot)?.label ?? stats.slot}${extra.barMinutes ? ` · ${extra.barMinutes}분봉` : ""}`,
    adherencePct: adherencePct(stats.compliant, stats.closed),
    contributionPct: round((stats.pnlUsd / state.initialCapitalUsd) * 100, 4),
  });
  const registered = RELAY_STRATEGIES.map((strategy) => decorate(state.strategies[strategy.id] ?? zero(strategy.id, strategy.name, strategy.slot), { summary: strategy.summary, universe: strategy.universe, registered: true, window: strategy.window, barMinutes: strategy.barMinutes ?? 5 }));
  const retired = Object.values(state.strategies).filter((stats) => !RELAY_STRATEGIES.some((strategy) => strategy.id === stats.id))
    .map((stats) => decorate(stats, { summary: "등록 해제된 전략", universe: [], registered: false }));
  return {
    mode: state.mode, status: state.status, stopPhase: state.stopPhase, runId: state.runId,
    initialCapitalUsd: state.initialCapitalUsd, cashUsd: round(state.cashUsd),
    ...summary,
    maxDrawdownPct: round(state.maxDrawdownPct, 3),
    startedAt: state.startedAt, stopRequestedAt: state.stopRequestedAt, stoppedAt: state.stoppedAt,
    lastTickAt: state.lastTickAt, lastError: state.lastError, brokerBalance: state.brokerBalance, readiness,
    strategies: [...registered, ...retired],
    daily: state.daily,
    positions: state.trades.filter((trade) => trade.status === "entering" || heldQuantity(trade) > 0),
    orders: state.orders.filter(isActiveOrder),
    trades: state.trades.filter((trade) => trade.status === "closed" || trade.status === "missed").slice(-150).reverse(),
    events: state.events.slice(-80).reverse(),
    previousRuns: state.previousRuns,
  };
}

export async function tradingDashboards(book: TradingBook = "relay"): Promise<TradingDashboardResponse> {
  const RELAY_STRATEGIES = await bookStrategies(book);
  const [live, paper] = await Promise.all([readRow(book, "live"), readRow(book, "paper")]);
  const [toss, quotes] = await Promise.all([cachedTossStatus(), tossQuotesReachable()]);
  const liveReasons: string[] = [];
  if (!toss.ready) liveReasons.push(`토스 계좌 연결 안 됨: ${toss.reason ?? toss.cause ?? "원인 불명"}`);
  else if ((toss.buyingPowerUsd ?? 0) < DASHBOARD_CAPITAL_USD) liveReasons.push(`USD 매수가능금액 $${(toss.buyingPowerUsd ?? 0).toFixed(2)} < 시작 자본 $${DASHBOARD_CAPITAL_USD.toLocaleString("en-US")}`);
  if (setting("TOSS_TRADING_DISABLED") === "true") liveReasons.push("TOSS_TRADING_DISABLED=true — 실주문 잠금");
  const paperReasons = quotes.ok ? [] : [`토스 실시간 시세 없음: ${quotes.reason}`];
  if (!RELAY_STRATEGIES.length) {
    const why = book === "relay" ? "검증된 슬롯 전략이 없습니다." : "등록된 급등주 규칙이 없습니다. 급등주 탭에서 검증을 통과한 규칙을 먼저 생성하세요.";
    liveReasons.push(why);
    paperReasons.push(why);
  }
  const heartbeat = Math.max(live.runnerHeartbeatAt ?? 0, paper.runnerHeartbeatAt ?? 0);
  return {
    now: new Date().toISOString(),
    dashboards: {
      live: view(live.state, { ready: liveReasons.length === 0, reasons: liveReasons }, RELAY_STRATEGIES),
      paper: view(paper.state, { ready: paperReasons.length === 0, reasons: paperReasons }, RELAY_STRATEGIES),
    },
    runner: { online: heartbeat > 0 && Date.now() - heartbeat < RUNNER_ONLINE_MS, lastHeartbeatAt: heartbeat ? new Date(heartbeat).toISOString() : null, intervalSeconds: RUNNER_INTERVAL_SECONDS },
    book,
    registeredStrategies: RELAY_STRATEGIES.length,
    toss: { ready: toss.ready, reason: toss.reason, cause: toss.cause, egressIp: toss.egressIp, accountNo: toss.account?.accountNo ?? null, buyingPowerUsd: toss.buyingPowerUsd },
    capitalUsd: DASHBOARD_CAPITAL_USD,
  };
}
