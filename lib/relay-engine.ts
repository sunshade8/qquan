/**
 * Account-level relay backtest.
 *
 * The evaluation unit here is **one account's daily P&L**, not a strategy's
 * average trade. That distinction is the whole point. A book of five rules each
 * averaging +0.4% per trade says nothing about whether the account gained
 * anything on a given day: the rules may never have fired, may have fired on the
 * same day and fought for the same dollars, or may have averaged +0.4% across a
 * month in which most days lost money. So this engine walks the calendar, runs
 * the slots in clock order against a single balance, and reports what the
 * balance did — including the days nothing traded and the days it fell.
 *
 * Capital is not divided. Each slot that fires uses the full balance and hands
 * it back before the next slot opens, so a measured edge reaches the account at
 * its own size rather than at one-Nth of it.
 */

import { SLOTS, slotById, assertTradable, type Slot, type SlotId } from "./trade-slots.ts";
import { costPerSidePct } from "./symbol-liquidity.ts";

export type IntradayBar = { date: string; time: string; open: number; high: number; low: number; close: number; volume: number };

/** Everything a slot rule may look at. Nothing here postdates the slot window. */
export type SlotSessionContext = {
  date: string;
  slot: Slot;
  /** Bars inside this slot's window, per symbol, in order. */
  window: Record<string, IntradayBar[]>;
  /** The session so far, up to the slot's start — the opening range, the gap, the day's high. */
  earlier: Record<string, IntradayBar[]>;
  /** Prior sessions' regular-hours bars, for relative-volume and range baselines. */
  history: Record<string, IntradayBar[][]>;
  equityUsd: number;
};

/**
 * At most one entry per slot. A slot that wants two positions is two slots; the
 * relay's guarantee is that one balance is in one place at a time.
 */
export type SlotOrder = {
  symbol: string;
  /** Bar time to enter on; the fill is that bar's open. */
  entryTime: string;
  /** Stop distance from entry, percent. Required — an intraday rule without a stop is not a rule. */
  stopPct: number;
  /** Target distance from entry, percent, or null to hold to the slot's end. */
  targetPct: number | null;
  reason: string;
};

export type SlotStrategy = {
  id: string;
  name: string;
  slot: SlotId;
  summary: string;
  universe: string[];
  rules: string[];
  evidence: string;
  cautions: string[];
  /** Prior sessions the rule needs before its first valid decision. */
  warmupSessions: number;
  scan(context: SlotSessionContext): SlotOrder | null;
};

export type SlotOutcome = {
  slot: SlotId;
  strategyId: string | null;
  symbol: string | null;
  traded: boolean;
  reason: string;
  entryTime: string | null;
  exitTime: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number;
  exit: "stop" | "target" | "slot_end" | null;
  costUsd: number;
  pnlUsd: number;
  returnPct: number;
};

export type RelayDay = {
  date: string;
  startEquityUsd: number;
  endEquityUsd: number;
  returnPct: number;
  traded: boolean;
  slots: SlotOutcome[];
};

export type RelayMetrics = {
  sessions: number;
  tradingDays: number;
  flatDays: number;
  totalTrades: number;
  /** The number the goal is stated in: mean of the account's daily returns. */
  meanDailyPct: number | null;
  medianDailyPct: number | null;
  positiveDayPct: number | null;
  /** Share of sessions that actually cleared +1%, and +2%. */
  daysAbove1PctShare: number | null;
  daysAbove2PctShare: number | null;
  worstDayPct: number | null;
  bestDayPct: number | null;
  maxDrawdownPct: number | null;
  totalReturnPct: number | null;
  costPaidUsd: number;
  /** Compounded daily mean, annualised over 252 sessions — the goal's own arithmetic. */
  impliedAnnualPct: number | null;
};

export type RelayResult = {
  from: string;
  to: string;
  startingCapitalUsd: number;
  endingEquityUsd: number;
  assignments: Array<{ slot: SlotId; strategyId: string | null; strategyName: string | null }>;
  days: RelayDay[];
  metrics: RelayMetrics;
};

const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const inWindow = (time: string, slot: Slot) => minutes(time) >= minutes(slot.from) && minutes(time) < minutes(slot.to);

/**
 * Walks one slot: fills at the entry bar's open, then checks each later bar in
 * the window. A bar covering both the stop and the target is scored as the stop,
 * because the bar does not say which came first and the optimistic reading is
 * what turns a losing rule into a winning backtest. Anything still open at the
 * window's edge is closed there — a slot hands the balance back.
 */
function executeSlot(order: SlotOrder, bars: IntradayBar[], equityUsd: number): Omit<SlotOutcome, "slot" | "strategyId"> {
  const entryIndex = bars.findIndex((bar) => bar.time === order.entryTime);
  const idle = { symbol: order.symbol, traded: false, reason: `${order.reason} — 진입 봉을 찾지 못함`, entryTime: null, exitTime: null, entryPrice: null, exitPrice: null, quantity: 0, exit: null, costUsd: 0, pnlUsd: 0, returnPct: 0 } as const;
  if (entryIndex < 0 || entryIndex >= bars.length - 1) return { ...idle };

  const entryPrice = bars[entryIndex].open;
  if (!(entryPrice > 0)) return { ...idle };
  const sideCostPct = costPerSidePct(order.symbol);
  const quantity = Math.floor(equityUsd / (entryPrice * (1 + sideCostPct / 100)));
  if (quantity < 1) return { ...idle, reason: `${order.reason} — 잔고 $${equityUsd.toFixed(0)}로 1주도 못 삼` };

  const stopPrice = entryPrice * (1 - order.stopPct / 100);
  const targetPrice = order.targetPct === null ? null : entryPrice * (1 + order.targetPct / 100);

  let exitPrice = bars.at(-1)!.close;
  let exitTime = bars.at(-1)!.time;
  let exit: SlotOutcome["exit"] = "slot_end";
  for (let index = entryIndex + 1; index < bars.length; index += 1) {
    const bar = bars[index];
    if (bar.low <= stopPrice) { exitPrice = Math.min(stopPrice, bar.open); exitTime = bar.time; exit = "stop"; break; }
    if (targetPrice !== null && bar.high >= targetPrice) { exitPrice = Math.max(targetPrice, bar.open); exitTime = bar.time; exit = "target"; break; }
    exitPrice = bar.close; exitTime = bar.time;
  }

  const grossIn = quantity * entryPrice;
  const grossOut = quantity * exitPrice;
  const costUsd = (grossIn + grossOut) * (sideCostPct / 100);
  const pnlUsd = grossOut - grossIn - costUsd;
  return {
    symbol: order.symbol, traded: true, reason: order.reason,
    entryTime: bars[entryIndex].time, exitTime,
    entryPrice: round(entryPrice, 4), exitPrice: round(exitPrice, 4),
    quantity, exit, costUsd: round(costUsd, 4), pnlUsd: round(pnlUsd, 4),
    returnPct: round((pnlUsd / equityUsd) * 100, 4),
  };
}

/** Regular-hours bars for one session, per symbol. */
export type SessionBars = { date: string; bars: Record<string, IntradayBar[]> };

export function runRelay(
  strategies: SlotStrategy[],
  sessions: SessionBars[],
  options: { capitalUsd: number },
): RelayResult {
  for (const strategy of strategies) assertTradable(strategy.universe, strategy.name);

  const bySlot = new Map<SlotId, SlotStrategy>();
  for (const strategy of strategies) {
    if (bySlot.has(strategy.slot)) throw new Error(`슬롯 ${strategy.slot}에 전략이 둘 이상입니다: ${bySlot.get(strategy.slot)!.id}, ${strategy.id}`);
    bySlot.set(strategy.slot, strategy);
  }
  const warmup = Math.max(0, ...strategies.map((strategy) => strategy.warmupSessions));

  let equity = options.capitalUsd;
  let peak = equity;
  let maxDrawdown = 0;
  let costPaid = 0;
  const days: RelayDay[] = [];

  for (let index = warmup; index < sessions.length; index += 1) {
    const session = sessions[index];
    const startEquity = equity;
    const outcomes: SlotOutcome[] = [];

    for (const slot of SLOTS) {
      const strategy = bySlot.get(slot.id);
      if (!strategy) {
        outcomes.push({ slot: slot.id, strategyId: null, symbol: null, traded: false, reason: "배정된 전략 없음", entryTime: null, exitTime: null, entryPrice: null, exitPrice: null, quantity: 0, exit: null, costUsd: 0, pnlUsd: 0, returnPct: 0 });
        continue;
      }
      const window: Record<string, IntradayBar[]> = {};
      const earlier: Record<string, IntradayBar[]> = {};
      const history: Record<string, IntradayBar[][]> = {};
      for (const symbol of strategy.universe) {
        const all = session.bars[symbol] ?? [];
        window[symbol] = all.filter((bar) => inWindow(bar.time, slot));
        earlier[symbol] = all.filter((bar) => minutes(bar.time) < minutes(slot.from));
        history[symbol] = sessions.slice(Math.max(0, index - strategy.warmupSessions), index).map((prior) => prior.bars[symbol] ?? []);
      }

      let order: SlotOrder | null = null;
      try {
        order = strategy.scan({ date: session.date, slot, window, earlier, history, equityUsd: equity });
      } catch (error) {
        outcomes.push({ slot: slot.id, strategyId: strategy.id, symbol: null, traded: false, reason: `규칙 오류: ${error instanceof Error ? error.message : "알 수 없음"}`, entryTime: null, exitTime: null, entryPrice: null, exitPrice: null, quantity: 0, exit: null, costUsd: 0, pnlUsd: 0, returnPct: 0 });
        continue;
      }
      if (!order) {
        outcomes.push({ slot: slot.id, strategyId: strategy.id, symbol: null, traded: false, reason: "조건 미충족", entryTime: null, exitTime: null, entryPrice: null, exitPrice: null, quantity: 0, exit: null, costUsd: 0, pnlUsd: 0, returnPct: 0 });
        continue;
      }
      const executed = executeSlot(order, window[order.symbol] ?? [], equity);
      equity += executed.pnlUsd;
      costPaid += executed.costUsd;
      outcomes.push({ slot: slot.id, strategyId: strategy.id, ...executed });
    }

    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    days.push({
      date: session.date, startEquityUsd: round(startEquity, 2), endEquityUsd: round(equity, 2),
      returnPct: round((equity / startEquity - 1) * 100, 4),
      traded: outcomes.some((outcome) => outcome.traded),
      slots: outcomes,
    });
  }

  const dailyReturns = days.map((day) => day.returnPct);
  const tradingDays = days.filter((day) => day.traded).length;
  const meanDaily = mean(dailyReturns);
  const share = (predicate: (value: number) => boolean) => days.length ? round((dailyReturns.filter(predicate).length / days.length) * 100, 2) : null;

  return {
    from: days[0]?.date ?? "", to: days.at(-1)?.date ?? "",
    startingCapitalUsd: options.capitalUsd, endingEquityUsd: round(equity, 2),
    assignments: SLOTS.map((slot) => ({ slot: slot.id, strategyId: bySlot.get(slot.id)?.id ?? null, strategyName: bySlot.get(slot.id)?.name ?? null })),
    days,
    metrics: {
      sessions: days.length,
      tradingDays,
      flatDays: days.length - tradingDays,
      totalTrades: days.reduce((sum, day) => sum + day.slots.filter((slot) => slot.traded).length, 0),
      meanDailyPct: meanDaily === null ? null : round(meanDaily, 4),
      medianDailyPct: median(dailyReturns) === null ? null : round(median(dailyReturns)!, 4),
      positiveDayPct: share((value) => value > 0),
      daysAbove1PctShare: share((value) => value >= 1),
      daysAbove2PctShare: share((value) => value >= 2),
      worstDayPct: dailyReturns.length ? round(Math.min(...dailyReturns), 4) : null,
      bestDayPct: dailyReturns.length ? round(Math.max(...dailyReturns), 4) : null,
      maxDrawdownPct: days.length ? round(maxDrawdown * 100, 3) : null,
      totalReturnPct: round((equity / options.capitalUsd - 1) * 100, 4),
      costPaidUsd: round(costPaid, 2),
      impliedAnnualPct: meanDaily === null ? null : round(((1 + meanDaily / 100) ** 252 - 1) * 100, 1),
    },
  };
}

export { SLOTS, slotById };
