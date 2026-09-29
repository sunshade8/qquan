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
 *
 * Three rules keep the simulation honest, each fixing a way it used to flatter a
 * strategy:
 *
 * 1. **The rule decides on closed bars and fills on the next one.** A slot rule
 *    is asked once per completed bar, in clock order, and only sees bars that had
 *    closed by then. It used to receive the whole window and name its own entry
 *    time, which let it read the 09:55 bar and buy at 09:30.
 * 2. **The entry bar is held.** The fill is at the entry bar's open, so a wick
 *    through the stop inside that same bar is a stop — it used to be skipped.
 * 3. **Drawdown is measured inside the day.** Equity is marked at every bar a
 *    position is held, at the bar's low, so a −5% morning that recovers by the
 *    close still shows as a −5% drawdown instead of 0%.
 */

import { SLOTS, slotById, assertTradable, type Slot, type SlotId } from "./trade-slots.ts";
import { TOSS_US_EQUITY } from "./broker-costs.ts";
import { costPerSidePct } from "./symbol-liquidity.ts";
import { assessTrade, adherencePct } from "./trade-adherence.ts";

export type IntradayBar = { date: string; time: string; open: number; high: number; low: number; close: number; volume: number };

/**
 * Everything a slot rule may look at at one decision point. Nothing here
 * postdates the close of the bar that opened at `asOf`.
 */
export type SlotSessionContext = {
  date: string;
  slot: Slot;
  /** Start time ("HH:MM", ET) of the most recent completed bar. The decision is made at its close. */
  asOf: string;
  /** This slot's bars up to and including `asOf`, per symbol, in order. */
  window: Record<string, IntradayBar[]>;
  /** The session so far, up to the slot's start — the opening range, the gap, the day's high. */
  earlier: Record<string, IntradayBar[]>;
  /** Prior sessions' bars, for relative-volume and range baselines. */
  history: Record<string, IntradayBar[][]>;
  equityUsd: number;
};

/**
 * At most one entry per slot. A slot that wants two positions is two slots; the
 * relay's guarantee is that one balance is in one place at a time.
 *
 * There is deliberately no entry time. The order fills at the open of the
 * symbol's next bar after the decision — the earliest a live runner that waits
 * for the bar to close could fill it — so a rule cannot choose a fill it has
 * already seen the future of.
 */
export type SlotOrder = {
  symbol: string;
  /** Stop distance from entry, percent. Required — an intraday rule without a stop is not a rule. */
  stopPct: number;
  /** Target distance from entry, percent, or null to hold to the slot's end. */
  targetPct: number | null;
  reason: string;
};

export type SlotStrategy = {
  /**
   * The bar the rule reads and decides on, in minutes. Backtest and live both
   * build bars at this resolution, fill on the next bar of it and judge a late
   * fill against one bar of it. Defaults to 5 for legacy relay rules.
   */
  barMinutes?: 1 | 3 | 5;
  /**
   * The clock the rule owns when it is not simply its slot's: decisions are
   * asked on bars starting in [from, to) and a position is flat by `to`. A
   * 급등주 rule uses it to read the whole regular session and time its entries
   * from its own event rather than from a fixed slot.
   */
  window?: { from: string; to: string };
  /** Sequential entries allowed in one day, one position at a time. Defaults to 1. */
  maxEntriesPerDay?: number;
  /** Time exit, in minutes from the fill bar's open. Null or absent holds to the window's end. */
  maxHoldMinutes?: number | null;
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
  execution?: { participationPct: number; reservePct: number; maxDailyLossPct: number; maxEntryDriftPct: number; maxSpreadPct: number };
  scan(context: SlotSessionContext): SlotOrder | null;
};

export type SlotOutcome = {
  slot: SlotId;
  strategyId: string | null;
  symbol: string | null;
  /** The rule asked for a position. A signal that could not be filled still counts. */
  signal: boolean;
  /** Start time of the bar the decision was made on. */
  signalTime: string | null;
  traded: boolean;
  reason: string;
  entryTime: string | null;
  exitTime: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number;
  exit: "stop" | "target" | "slot_end" | null;
  stopPct: number | null;
  targetPct: number | null;
  costUsd: number;
  pnlUsd: number;
  returnPct: number;
  /** Null when nothing traded; otherwise whether execution matched the rule. */
  ruleCompliant: boolean | null;
  /** Every way this slot departed from its rule, including a signal that never filled. */
  violations: string[];
};

export type RelayDay = {
  date: string;
  startEquityUsd: number;
  endEquityUsd: number;
  returnPct: number;
  /** Lowest marked equity during the day relative to the day's start, percent (≤ 0). */
  intradayLowPct: number;
  /** Peak-to-trough inside this day alone, percent. */
  intradayDrawdownPct: number;
  traded: boolean;
  slots: SlotOutcome[];
};

export type RelayMetrics = {
  sessions: number;
  tradingDays: number;
  flatDays: number;
  totalTrades: number;
  signals: number;
  /** Signals the simulator could not fill — no bar left in the slot, a malformed order, too little cash. */
  missedSignals: number;
  compliantTrades: number;
  /** Share of filled trades executed as their rule said. */
  adherencePct: number | null;
  winRatePct: number | null;
  /** The number the goal is stated in: mean of the account's daily returns. */
  meanDailyPct: number | null;
  medianDailyPct: number | null;
  positiveDayPct: number | null;
  /** Share of sessions that actually cleared +1%, and +2%. */
  daysAbove1PctShare: number | null;
  daysAbove2PctShare: number | null;
  worstDayPct: number | null;
  bestDayPct: number | null;
  /** Worst intraday low of any single day, percent from that day's start. */
  worstIntradayPct: number | null;
  /** Peak-to-trough on the bar-by-bar equity path, intraday lows included. */
  maxDrawdownPct: number | null;
  /** The same measure on end-of-day equity only — kept to show how much the close hides. */
  endOfDayMaxDrawdownPct: number | null;
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
export const inSlotWindow = (time: string, slot: Pick<Slot, "from" | "to">) => minutes(time) >= minutes(slot.from) && minutes(time) < minutes(slot.to);

export const barMinutesOf = (strategy: Pick<SlotStrategy, "barMinutes">): 1 | 3 | 5 => strategy.barMinutes ?? 5;

/** The window a rule decides in and is flat by: its own when it has one, otherwise its slot's. */
export function strategyWindow(strategy: Pick<SlotStrategy, "slot" | "window">): Slot {
  const slot = slotById(strategy.slot);
  if (!slot) throw new Error(`알 수 없는 슬롯: ${strategy.slot}`);
  return strategy.window ? { ...slot, from: strategy.window.from, to: strategy.window.to } : slot;
}

/**
 * A backtest fill *is* the modelled price, so the only deviation left to catch
 * is a gap through the stop. The slack only absorbs float rounding.
 */
const BACKTEST_TOLERANCE_PCT = 0.001;

/** Liquidation value of the account at one bar: its worst point and where it closed. */
type Mark = { low: number; close: number };

const idleOutcome = (slot: SlotId, strategyId: string | null, reason: string, extra: Partial<SlotOutcome> = {}): SlotOutcome => ({
  slot, strategyId, symbol: null, signal: false, signalTime: null, traded: false, reason,
  entryTime: null, exitTime: null, entryPrice: null, exitPrice: null, quantity: 0, exit: null,
  stopPct: null, targetPct: null, costUsd: 0, pnlUsd: 0, returnPct: 0, ruleCompliant: null, violations: [],
  ...extra,
});

/** Why an order cannot be taken as written, or null when it can. */
export function orderProblem(order: SlotOrder, universe: string[]): string | null {
  if (!order || typeof order.symbol !== "string" || !universe.includes(order.symbol)) return `유니버스 밖 종목(${order?.symbol ?? "없음"})`;
  if (!Number.isFinite(order.stopPct) || order.stopPct <= 0) return "손절폭이 없거나 0 이하";
  if (order.targetPct !== null && (!Number.isFinite(order.targetPct) || order.targetPct <= 0)) return "목표폭이 0 이하";
  return null;
}

/**
 * Walks one slot from the fill: enters at the open of the first bar after the
 * decision, then checks every bar from that one on. A bar covering both the stop
 * and the target is scored as the stop, because the bar does not say which came
 * first and the optimistic reading is what turns a losing rule into a winning
 * backtest. Anything still open at the window's edge is closed there — a slot
 * hands the balance back.
 */
function executeSlot(
  order: SlotOrder,
  bars: IntradayBar[],
  signalTime: string,
  equityUsd: number,
  base: { slot: SlotId; strategyId: string },
  rule: Pick<SlotStrategy, "execution" | "maxHoldMinutes"> & { step: number; window: Slot },
  stress: { costMultiplier?: number; entryDelayBars?: number },
): { outcome: SlotOutcome; marks: Mark[] } {
  const { execution, step } = rule;
  const planned = { symbol: order.symbol, signal: true, signalTime, stopPct: order.stopPct, targetPct: order.targetPct };
  const missed = (why: string) => ({
    outcome: idleOutcome(base.slot, base.strategyId, `${order.reason} — ${why}`, { ...planned, violations: [`신호 미체결: ${why}`] }),
    marks: [],
  });

  const first = bars.findIndex((bar) => minutes(bar.time) > minutes(signalTime));
  const entryIndex = first < 0 ? -1 : first + (stress.entryDelayBars ?? 0);
  if (entryIndex < 0 || entryIndex >= bars.length) return missed("신호 이후 슬롯 안에 체결할 봉이 없음");
  const entryPrice = bars[entryIndex].open;
  if (!(entryPrice > 0)) return missed("진입 봉 시가가 비정상");

  if (execution && minutes(bars[entryIndex].time) !== minutes(signalTime) + step * (1 + (stress.entryDelayBars ?? 0))) return missed("체결 봉 누락 또는 거래 중단");
  const signalBar = bars.find(bar => bar.time === signalTime);
  if (execution && (!signalBar || Math.abs(entryPrice / signalBar.close - 1) * 100 > execution.maxEntryDriftPct)) return missed("신호 대비 진입 가격 이탈");
  const sideCostPct = costPerSidePct(order.symbol) * (stress.costMultiplier ?? 1);
  const side = sideCostPct / 100;
  const budget = equityUsd * (1 - (execution?.reservePct ?? 0) / 100);
  const quantity = Math.min(Math.floor(budget / (entryPrice * (1 + side))), execution ? Math.floor((signalBar?.volume ?? 0) * execution.participationPct / 100) : Infinity);
  if (quantity < 1) return missed(`잔고 $${equityUsd.toFixed(0)}로 1주도 못 삼`);

  const stopPrice = entryPrice * (1 - order.stopPct / 100);
  const targetPrice = order.targetPct === null ? null : entryPrice * (1 + order.targetPct / 100);
  const cashAfterEntry = equityUsd - quantity * entryPrice * (1 + side);
  const sellFee = execution ? TOSS_US_EQUITY.secSellFeePct / 100 * (stress.costMultiplier ?? 1) : 0;
  const liquidation = (price: number) => cashAfterEntry + quantity * price * (1 - side - sellFee);

  // A time exit closes on the last bar that ends by the hold limit.
  const holdLimit = rule.maxHoldMinutes ? minutes(bars[entryIndex].time) + rule.maxHoldMinutes : Infinity;
  const held = bars.slice(entryIndex).filter((bar, index) => index === 0 || minutes(bar.time) + step <= holdLimit);
  const lastIndex = entryIndex + held.length - 1;
  let exitPrice = bars[lastIndex].close;
  let exitTime = bars[lastIndex].time;
  let exit: NonNullable<SlotOutcome["exit"]> = "slot_end";
  const marks: Mark[] = [];
  for (let index = entryIndex; index <= lastIndex; index += 1) {
    const bar = bars[index];
    // On the entry bar the position exists from the open on, so its whole range
    // after the fill — the wick through the stop included — happened while held.
    const open = index === entryIndex ? entryPrice : bar.open;
    if (bar.low <= stopPrice) {
      exitPrice = Math.min(stopPrice, open); exitTime = bar.time; exit = "stop";
      marks.push({ low: liquidation(exitPrice), close: liquidation(exitPrice) });
      break;
    }
    if (targetPrice !== null && bar.high >= targetPrice) {
      exitPrice = Math.max(targetPrice, open); exitTime = bar.time; exit = "target";
      // A bar that opened through the target sold at the open; otherwise the dip
      // to the low may have come first.
      marks.push({ low: liquidation(open >= targetPrice ? exitPrice : bar.low), close: liquidation(exitPrice) });
      break;
    }
    exitPrice = bar.close; exitTime = bar.time;
    marks.push({ low: liquidation(bar.low), close: liquidation(bar.close) });
  }

  const grossIn = quantity * entryPrice;
  const grossOut = quantity * exitPrice;
  const costUsd = (grossIn + grossOut) * side + grossOut * sellFee;
  const pnlUsd = grossOut - grossIn - costUsd;
  const adherence = assessTrade({
    stopPct: order.stopPct, targetPct: order.targetPct,
    referenceEntryPrice: entryPrice, entryPrice, exitPrice, exit,
    tolerancePct: BACKTEST_TOLERANCE_PCT,
  });
  const dataViolations: string[] = [];
  if (execution) {
    const heldBars = bars.slice(entryIndex).filter(bar => bar.time <= exitTime);
    if (heldBars.some((bar, i) => i > 0 && minutes(bar.time) - minutes(heldBars[i-1].time) !== step)) dataViolations.push("보유 구간 봉 누락 — 체결 경로 검증 불가");
    const due = Math.min(minutes(rule.window.to), holdLimit) - step;
    if (exit === "slot_end" && minutes(exitTime) !== due) dataViolations.push("슬롯 종료 봉 누락 — 청산 검증 불가");
  }
  return {
    outcome: {
      ...base, ...planned, traded: true, reason: order.reason,
      entryTime: bars[entryIndex].time, exitTime,
      entryPrice: round(entryPrice, 4), exitPrice: round(exitPrice, 4),
      quantity, exit, costUsd: round(costUsd, 4), pnlUsd: round(pnlUsd, 4),
      returnPct: round((pnlUsd / equityUsd) * 100, 4),
      ruleCompliant: adherence.compliant && !dataViolations.length, violations: [...adherence.violations, ...dataViolations],
    },
    marks,
  };
}

/**
 * Session bars for one date, per symbol, 04:00–19:55 ET. `bars` is the
 * five-minute set every legacy caller reads; a book that holds rules at other
 * resolutions carries those in `barsByStep`, and `sessionBarsAt` picks the one
 * a rule asked for — a rule is never silently fed a coarser bar than it reads.
 */
export type SessionBars = {
  date: string;
  bars: Record<string, IntradayBar[]>;
  barsByStep?: Partial<Record<1 | 3 | 5, Record<string, IntradayBar[]>>>;
};

export function sessionBarsAt(session: SessionBars, step: 1 | 3 | 5) {
  const bars = session.barsByStep?.[step] ?? (step === 5 ? session.bars : undefined);
  if (!bars) throw new Error(`${session.date} 세션에 ${step}분봉이 없습니다. 전략의 봉 주기로 데이터를 불러와야 합니다.`);
  return bars;
}

export type SlotDecision = { order: SlotOrder | null; signalTime: string | null; error: string | null };

/**
 * Asks a rule for a decision once per completed bar, in clock order, stopping at
 * the first order. `after` skips bars already evaluated — the live runner calls
 * this every tick and must not re-decide on a bar it has already seen.
 *
 * Shared by the backtest and the live runner so both ask the rule the same
 * question with the same information.
 */
export function decideSlot(
  strategy: SlotStrategy,
  slot: Slot,
  date: string,
  window: Record<string, IntradayBar[]>,
  earlier: Record<string, IntradayBar[]>,
  history: Record<string, IntradayBar[][]>,
  equityUsd: number,
  options: { after?: string | null; onBar?: (time: string) => void; exclude?: ReadonlySet<string> } = {},
): SlotDecision {
  // A symbol already traded today is out of the rule's reach, as if unlisted.
  if (options.exclude?.size) window = Object.fromEntries(Object.entries(window).filter(([symbol]) => !options.exclude!.has(symbol)));
  const times = [...new Set(Object.values(window).flatMap((bars) => bars.map((bar) => bar.time)))]
    .filter((time) => !options.after || minutes(time) > minutes(options.after))
    .sort((left, right) => minutes(left) - minutes(right));
  for (const time of times) {
    const visible: Record<string, IntradayBar[]> = {};
    for (const [symbol, bars] of Object.entries(window)) {
      let count = 0;
      while (count < bars.length && minutes(bars[count].time) <= minutes(time)) count += 1;
      visible[symbol] = bars.slice(0, count);
    }
    options.onBar?.(time);
    try {
      const order = strategy.scan({ date, slot, asOf: time, window: visible, earlier, history, equityUsd });
      if (order) return { order, signalTime: time, error: null };
    } catch (error) {
      return { order: null, signalTime: time, error: error instanceof Error ? error.message : "알 수 없음" };
    }
  }
  return { order: null, signalTime: null, error: null };
}

/** Splits one session's bars into the slot's window and everything before it. */
export function sliceSession(bars: Record<string, IntradayBar[]>, universe: string[], slot: Pick<Slot, "from" | "to">) {
  const window: Record<string, IntradayBar[]> = {};
  const earlier: Record<string, IntradayBar[]> = {};
  for (const symbol of universe) {
    const all = bars[symbol] ?? [];
    window[symbol] = all.filter((bar) => inSlotWindow(bar.time, slot));
    earlier[symbol] = all.filter((bar) => minutes(bar.time) < minutes(slot.from));
  }
  return { window, earlier };
}

export function runRelay(
  strategies: SlotStrategy[],
  sessions: SessionBars[],
  options: { capitalUsd: number; costMultiplier?: number; entryDelayBars?: number },
): RelayResult {
  if (!Number.isFinite(options.capitalUsd) || options.capitalUsd <= 0) throw new Error("유효한 시작 자본이 필요합니다.");
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
  let closePeak = equity;
  let closeMaxDrawdown = 0;
  let costPaid = 0;
  const days: RelayDay[] = [];

  for (let index = warmup; index < sessions.length; index += 1) {
    const session = sessions[index];
    const startEquity = equity;
    let dayPeak = equity;
    let dayLow = equity;
    let dayDrawdown = 0;
    const observe = (mark: Mark) => {
      // The low is judged against the peak reached before this bar: inside one
      // bar the order of the high and the low is unknown.
      dayLow = Math.min(dayLow, mark.low);
      maxDrawdown = Math.max(maxDrawdown, (peak - mark.low) / peak);
      dayDrawdown = Math.max(dayDrawdown, (dayPeak - mark.low) / dayPeak);
      peak = Math.max(peak, mark.close);
      dayPeak = Math.max(dayPeak, mark.close);
    };
    const outcomes: SlotOutcome[] = [];

    for (const slot of SLOTS) {
      const strategy = bySlot.get(slot.id);
      if (!strategy) {
        outcomes.push(idleOutcome(slot.id, null, "배정된 전략 없음"));
        continue;
      }
      if (strategy.execution && (equity / startEquity - 1) * 100 <= -strategy.execution.maxDailyLossPct) {
        outcomes.push(idleOutcome(slot.id, strategy.id, "일 손실 한도 — 신규 진입 중지")); continue;
      }
      const step = barMinutesOf(strategy);
      const ruleWindow = strategyWindow(strategy);
      const { window, earlier } = sliceSession(sessionBarsAt(session, step), strategy.universe, ruleWindow);
      const history: Record<string, IntradayBar[][]> = {};
      for (const symbol of strategy.universe) {
        history[symbol] = sessions.slice(Math.max(0, index - strategy.warmupSessions), index).map((prior) => sessionBarsAt(prior, step)[symbol] ?? []);
      }

      const decision = decideSlot(strategy, ruleWindow, session.date, window, earlier, history, equity);
      if (decision.error) {
        outcomes.push(idleOutcome(slot.id, strategy.id, `규칙 오류: ${decision.error}`, { signalTime: decision.signalTime, violations: [`규칙 오류: ${decision.error}`] }));
        continue;
      }
      if (!decision.order || !decision.signalTime) {
        outcomes.push(idleOutcome(slot.id, strategy.id, "조건 미충족"));
        continue;
      }
      const problem = orderProblem(decision.order, strategy.universe);
      if (problem) {
        outcomes.push(idleOutcome(slot.id, strategy.id, `${decision.order.reason ?? "주문"} — ${problem}`, {
          symbol: decision.order.symbol ?? null, signal: true, signalTime: decision.signalTime,
          violations: [`규칙 위반 주문: ${problem}`],
        }));
        continue;
      }
      const { outcome, marks } = executeSlot(decision.order, window[decision.order.symbol] ?? [], decision.signalTime, equity, { slot: slot.id, strategyId: strategy.id },
        { execution: strategy.execution, maxHoldMinutes: strategy.maxHoldMinutes, step, window: ruleWindow }, options);
      marks.forEach(observe);
      equity += outcome.pnlUsd;
      costPaid += outcome.costUsd;
      outcomes.push(outcome);
    }

    observe({ low: equity, close: equity });
    closePeak = Math.max(closePeak, equity);
    closeMaxDrawdown = Math.max(closeMaxDrawdown, (closePeak - equity) / closePeak);
    days.push({
      date: session.date, startEquityUsd: round(startEquity, 2), endEquityUsd: round(equity, 2),
      returnPct: round((equity / startEquity - 1) * 100, 4),
      intradayLowPct: round(Math.min(0, (dayLow / startEquity - 1) * 100), 4),
      intradayDrawdownPct: round(dayDrawdown * 100, 4),
      traded: outcomes.some((outcome) => outcome.traded),
      slots: outcomes,
    });
  }

  return {
    from: days[0]?.date ?? "", to: days.at(-1)?.date ?? "",
    startingCapitalUsd: options.capitalUsd, endingEquityUsd: round(equity, 2),
    assignments: SLOTS.map((slot) => ({ slot: slot.id, strategyId: bySlot.get(slot.id)?.id ?? null, strategyName: bySlot.get(slot.id)?.name ?? null })),
    days,
    metrics: accountMetrics(days, options.capitalUsd, equity, { maxDrawdown, closeMaxDrawdown, costPaidUsd: costPaid }),
  };
}

/**
 * The minimum a walked calendar has to report for `accountMetrics` to describe
 * it. `RelayDay` satisfies it; so does the surge engine's day, which has no
 * slots and one trade.
 */
export type AccountDay = Omit<RelayDay, "slots"> & {
  slots: Array<Pick<SlotOutcome, "traded" | "signal" | "ruleCompliant" | "pnlUsd">>;
};

/**
 * The account-level summary of a walked calendar. Shared with the surge engine
 * in `lib/surge-engine.ts` so "what did the balance do" has exactly one
 * definition: two books measured by two functions cannot be compared.
 */
export function accountMetrics(
  days: AccountDay[],
  capitalUsd: number,
  endingEquityUsd: number,
  totals: { maxDrawdown: number; closeMaxDrawdown: number; costPaidUsd: number },
): RelayMetrics {
  const dailyReturns = days.map((day) => day.returnPct);
  const tradingDays = days.filter((day) => day.traded).length;
  const meanDaily = mean(dailyReturns);
  const share = (predicate: (value: number) => boolean) => days.length ? round((dailyReturns.filter(predicate).length / days.length) * 100, 2) : null;
  const allOutcomes = days.flatMap((day) => day.slots);
  const trades = allOutcomes.filter((outcome) => outcome.traded);
  const compliant = trades.filter((outcome) => outcome.ruleCompliant === true).length;

  return {
    sessions: days.length,
    tradingDays,
    flatDays: days.length - tradingDays,
    totalTrades: trades.length,
    signals: allOutcomes.filter((outcome) => outcome.signal).length,
    missedSignals: allOutcomes.filter((outcome) => outcome.signal && !outcome.traded).length,
    compliantTrades: compliant,
    adherencePct: adherencePct(compliant, trades.length),
    winRatePct: trades.length ? round((trades.filter((outcome) => outcome.pnlUsd > 0).length / trades.length) * 100, 2) : null,
    meanDailyPct: meanDaily === null ? null : round(meanDaily, 4),
    medianDailyPct: median(dailyReturns) === null ? null : round(median(dailyReturns)!, 4),
    positiveDayPct: share((value) => value > 0),
    daysAbove1PctShare: share((value) => value >= 1),
    daysAbove2PctShare: share((value) => value >= 2),
    worstDayPct: dailyReturns.length ? round(Math.min(...dailyReturns), 4) : null,
    bestDayPct: dailyReturns.length ? round(Math.max(...dailyReturns), 4) : null,
    worstIntradayPct: days.length ? round(Math.min(...days.map((day) => day.intradayLowPct)), 4) : null,
    maxDrawdownPct: days.length ? round(totals.maxDrawdown * 100, 3) : null,
    endOfDayMaxDrawdownPct: days.length ? round(totals.closeMaxDrawdown * 100, 3) : null,
    totalReturnPct: round((endingEquityUsd / capitalUsd - 1) * 100, 4),
    costPaidUsd: round(totals.costPaidUsd, 2),
    impliedAnnualPct: meanDaily === null ? null : round(((1 + meanDaily / 100) ** 252 - 1) * 100, 1),
  };
}

export { SLOTS, slotById };
