/**
 * Account-level backtest for 급등주 rules.
 *
 * The twin of `runRelay`, with one structural difference and one new number.
 *
 * The difference is the universe. A relay slot trades a fixed ticker list; a
 * surge rule trades whatever became a surge (or crash) event earlier the same
 * day, so each session carries its own events — each one invisible until the
 * minute it was first observed (`lib/surge-observation.ts`). A rule may take up
 * to `maxTradesPerDay` trades in sequence, one position at a time, never the
 * same name twice, resuming its search after each exit.
 *
 * The new number is **R**. The point of this feature is a payoff ratio that
 * survives costs, so every trade is also reported as a multiple of the money it
 * put at risk (quantity × entry × stop%), and the account summary carries the
 * expectancy in R alongside the percentages. A rule with a 63% win rate and a
 * 0.9:1 payoff is a losing rule, and only the R column says so.
 *
 * Everything else is deliberately identical to the relay engine, because the
 * two have to be comparable: decisions on completed bars, fills at the next
 * bar's open, the entry bar held so a wick through the stop is a stop, the
 * stop taken first when a bar covers both stop and target, equity marked at
 * every held bar's low, and the whole balance in one position.
 */

import { accountMetrics, type AccountDay, type IntradayBar, type RelayMetrics } from "./relay-engine.ts";
import { TOSS_US_EQUITY } from "./broker-costs.ts";
import { surgeCostPerSidePct } from "./surge-costs.ts";
import { assessTrade, adherencePct } from "./trade-adherence.ts";
import { observedCandidates, minuteEnd } from "./surge-observation.ts";
import { SURGE_EXECUTION, type SessionPrefix, type SurgeCandidate, type SurgeOrder, type SurgeStrategy } from "./surge-spec.ts";

/** One trading day: its same-day events, and each event's bars at the rule's resolution. */
export type SurgeSession = {
  date: string;
  candidates: SurgeCandidate[];
  bars: Record<string, IntradayBar[]>;
  /** Running totals of the session bars trimmed before each symbol's first loaded bar. */
  prefix?: Record<string, SessionPrefix>;
};

export type SurgeOutcome = {
  strategyId: string;
  symbol: string | null;
  signal: boolean;
  signalTime: string | null;
  traded: boolean;
  reason: string;
  rank: number | null;
  /** The move at which the traded event was first observed. */
  eventChangePct: number | null;
  observedAt: string | null;
  entryTime: string | null;
  exitTime: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number;
  exit: "stop" | "target" | "time" | null;
  stopPct: number | null;
  targetPct: number | null;
  /** Dollars the stop put at risk at the fill — the denominator of `rMultiple`. */
  riskUsd: number;
  /** Net P&L ÷ risk. The only scale on which a payoff ratio means anything. */
  rMultiple: number | null;
  costUsd: number;
  pnlUsd: number;
  returnPct: number;
  ruleCompliant: boolean | null;
  violations: string[];
};

export type SurgeDay = Omit<AccountDay, "slots"> & { slots: SurgeOutcome[] };

/** What the account-level summary cannot say on its own: is the payoff positive? */
export type SurgeExpectancy = {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  /** Mean R across every filled trade. Positive expectancy is this number > 0. */
  expectancyR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  /** avgWin ÷ |avgLoss| — the realised 손익비, which is not the rule's intended one. */
  payoffRatio: number | null;
  /** Win rate this payoff needs to break even. Compare with `winRatePct`. */
  breakEvenWinRatePct: number | null;
  /** Newey-West lag-5 95% lower bound on mean R; ≤ 0 means the edge is not established. */
  expectancyLower95R: number | null;
  totalRiskedUsd: number;
  stopExits: number;
  targetExits: number;
  timeExits: number;
};

export type SurgeResult = {
  from: string;
  to: string;
  startingCapitalUsd: number;
  endingEquityUsd: number;
  days: SurgeDay[];
  metrics: RelayMetrics;
  expectancy: SurgeExpectancy;
};

const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const BACKTEST_TOLERANCE_PCT = 0.001;

const idle = (strategyId: string, reason: string, extra: Partial<SurgeOutcome> = {}): SurgeOutcome => ({
  strategyId, symbol: null, signal: false, signalTime: null, traded: false, reason,
  rank: null, eventChangePct: null, observedAt: null, entryTime: null, exitTime: null, entryPrice: null, exitPrice: null,
  quantity: 0, exit: null, stopPct: null, targetPct: null, riskUsd: 0, rMultiple: null,
  costUsd: 0, pnlUsd: 0, returnPct: 0, ruleCompliant: null, violations: [],
  ...extra,
});

/** Newey-West lag-5 lower bound, matching `lowerMean95` in the relay validator. */
function lower95(values: number[]) {
  const n = values.length;
  if (n < 20 || values.some((value) => !Number.isFinite(value))) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const deviations = values.map((value) => value - mean);
  let variance = deviations.reduce((a, b) => a + b * b, 0) / n;
  for (let lag = 1; lag <= Math.min(5, n - 1); lag += 1) {
    let covariance = 0;
    for (let i = lag; i < n; i += 1) covariance += deviations[i] * deviations[i - lag];
    variance += (2 * (1 - lag / 6) * covariance) / n;
  }
  return round(mean - 1.96 * Math.sqrt(Math.max(0, variance) / (n - 1)), 4);
}

type Mark = { low: number; close: number };

function execute(
  order: SurgeOrder,
  candidate: SurgeCandidate,
  bars: IntradayBar[],
  signalTime: string,
  equityUsd: number,
  strategy: SurgeStrategy,
  stress: { costMultiplier?: number; entryDelayBars?: number },
): { outcome: SurgeOutcome; marks: Mark[] } {
  const planned = {
    symbol: order.symbol, signal: true, signalTime, stopPct: order.stopPct, targetPct: order.targetPct,
    rank: candidate.rank, eventChangePct: round(candidate.changePct, 3), observedAt: candidate.observedAt ?? null,
  };
  const missed = (why: string) => ({
    outcome: idle(strategy.id, `${order.reason} — ${why}`, { ...planned, violations: [`신호 미체결: ${why}`] }),
    marks: [] as Mark[],
  });

  const first = bars.findIndex((bar) => minutes(bar.time) > minutes(signalTime));
  const entryIndex = first < 0 ? -1 : first + (stress.entryDelayBars ?? 0);
  if (entryIndex < 0 || entryIndex >= bars.length) return missed("신호 이후 체결할 봉이 없음");
  // The last bar held: the earlier of the 15:55 flat and the hold limit from the fill.
  const holdBars = Math.max(1, Math.floor(strategy.maxHoldMinutes / strategy.step));
  const exitLimit = Math.min(minutes(strategy.lastBar), minutes(bars[entryIndex].time) + (holdBars - 1) * strategy.step);
  if (minutes(bars[entryIndex].time) > exitLimit) return missed("체결 가능한 봉이 청산 시각을 넘음");

  const entryPrice = bars[entryIndex].open;
  if (!(entryPrice > 0)) return missed("진입 봉 시가가 비정상");
  if (minutes(bars[entryIndex].time) !== minutes(signalTime) + strategy.step * (1 + (stress.entryDelayBars ?? 0))) {
    return missed("체결 봉 누락 또는 거래 중단");
  }
  const signalBar = bars.find((bar) => bar.time === signalTime);
  if (!signalBar || Math.abs(entryPrice / signalBar.close - 1) * 100 > SURGE_EXECUTION.maxEntryDriftPct) {
    return missed("신호 대비 진입 가격 이탈");
  }

  const sideCostPct = surgeCostPerSidePct(order.symbol, entryPrice, (candidate.priorDollarVolume ?? candidate.dollarVolume)) * (stress.costMultiplier ?? 1);
  const side = sideCostPct / 100;
  const budget = equityUsd * (1 - SURGE_EXECUTION.reservePct / 100);
  const quantity = Math.min(
    Math.floor(budget / (entryPrice * (1 + side))),
    Math.floor((signalBar.volume * SURGE_EXECUTION.participationPct) / 100),
  );
  if (quantity < 1) return missed(`잔고 $${equityUsd.toFixed(0)}·참여 한도로 1주도 못 삼`);

  const stopPrice = entryPrice * (1 - order.stopPct / 100);
  const targetPrice = entryPrice * (1 + order.targetPct / 100);
  const cashAfterEntry = equityUsd - quantity * entryPrice * (1 + side);
  const sellFee = (TOSS_US_EQUITY.secSellFeePct / 100) * (stress.costMultiplier ?? 1);
  const liquidation = (price: number) => cashAfterEntry + quantity * price * (1 - side - sellFee);

  const held = bars.filter((bar, index) => index >= entryIndex && minutes(bar.time) <= exitLimit);
  let exitPrice = held.at(-1)!.close;
  let exitTime = held.at(-1)!.time;
  let exit: NonNullable<SurgeOutcome["exit"]> = "time";
  const marks: Mark[] = [];
  for (const [index, bar] of held.entries()) {
    const open = index === 0 ? entryPrice : bar.open;
    if (bar.low <= stopPrice) {
      exitPrice = Math.min(stopPrice, open); exitTime = bar.time; exit = "stop";
      marks.push({ low: liquidation(exitPrice), close: liquidation(exitPrice) });
      break;
    }
    if (bar.high >= targetPrice) {
      exitPrice = Math.max(targetPrice, open); exitTime = bar.time; exit = "target";
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
  const riskUsd = grossIn * (order.stopPct / 100);
  const adherence = assessTrade({
    stopPct: order.stopPct, targetPct: order.targetPct,
    referenceEntryPrice: entryPrice, entryPrice, exitPrice,
    exit: exit === "time" ? "slot_end" : exit,
    tolerancePct: BACKTEST_TOLERANCE_PCT,
  });
  const violations = [...adherence.violations];
  if (held.some((bar, i) => i > 0 && minutes(bar.time) - minutes(held[i - 1].time) !== strategy.step)) {
    violations.push("보유 구간 봉 누락 — 체결 경로 검증 불가");
  }
  if (exit === "time" && minutes(exitTime) !== exitLimit) {
    violations.push("청산 봉 누락 — 강제 청산 검증 불가");
  }

  return {
    outcome: {
      strategyId: strategy.id, ...planned, traded: true, reason: order.reason,
      entryTime: bars[entryIndex].time, exitTime,
      entryPrice: round(entryPrice, 4), exitPrice: round(exitPrice, 4),
      quantity, exit,
      riskUsd: round(riskUsd, 4),
      rMultiple: riskUsd > 0 ? round(pnlUsd / riskUsd, 4) : null,
      costUsd: round(costUsd, 4), pnlUsd: round(pnlUsd, 4),
      returnPct: round((pnlUsd / equityUsd) * 100, 4),
      ruleCompliant: adherence.compliant && violations.length === adherence.violations.length,
      violations,
    },
    marks,
  };
}

export function runSurge(
  strategy: SurgeStrategy,
  sessions: SurgeSession[],
  options: { capitalUsd: number; costMultiplier?: number; entryDelayBars?: number },
): SurgeResult {
  if (!Number.isFinite(options.capitalUsd) || options.capitalUsd <= 0) {
    throw new Error("유효한 시작 자본이 필요합니다.");
  }

  let equity = options.capitalUsd;
  let peak = equity;
  let maxDrawdown = 0;
  let closePeak = equity;
  let closeMaxDrawdown = 0;
  let costPaid = 0;
  const days: SurgeDay[] = [];

  for (const session of sessions) {
    const startEquity = equity;
    let dayPeak = equity;
    let dayLow = equity;
    let dayDrawdown = 0;
    const observe = (mark: Mark) => {
      dayLow = Math.min(dayLow, mark.low);
      maxDrawdown = Math.max(maxDrawdown, (peak - mark.low) / peak);
      dayDrawdown = Math.max(dayDrawdown, (dayPeak - mark.low) / dayPeak);
      peak = Math.max(peak, mark.close);
      dayPeak = Math.max(dayPeak, mark.close);
    };

    const outcomes: SurgeOutcome[] = [];
    const pool = session.candidates.filter((candidate) => strategy.eligible(candidate));
    if (!pool.length) {
      outcomes.push(idle(strategy.id, session.candidates.length ? "규칙 조건에 맞는 당일 사건 없음" : "당일 관측 사건 없음"));
    } else {
      const rows = pool.map((candidate) => ({ candidate, bars: session.bars[candidate.symbol] ?? [], prefix: session.prefix?.[candidate.symbol] }));
      const allTimes = [...new Set(rows.flatMap((row) => row.bars.map((bar) => bar.time)))].sort((left, right) => minutes(left) - minutes(right));
      const used = new Set<string>();
      let resumeAfter = -1;
      while (outcomes.length < strategy.maxTradesPerDay) {
        if ((equity / startEquity - 1) * 100 <= -SURGE_EXECUTION.maxDailyLossPct) break;
        let decision: { order: SurgeOrder; time: string } | null = null;
        let failure: string | null = null;
        for (const time of allTimes) {
          if (minutes(time) <= resumeAfter) continue;
          const visible = rows.filter((row) => !used.has(row.candidate.symbol)).map((row) => ({
            ...row, bars: row.bars.filter((bar) => minutes(bar.time) <= minutes(time)),
          }));
          try {
            const order = strategy.scan({ date: session.date, asOf: time, rows: visible, equityUsd: equity });
            if (order) { decision = { order, time }; break; }
          } catch (error) {
            failure = error instanceof Error ? error.message : "알 수 없음";
            break;
          }
        }
        if (failure) {
          outcomes.push(idle(strategy.id, `규칙 오류: ${failure}`, { violations: [`규칙 오류: ${failure}`] }));
          break;
        }
        if (!decision) break;
        const candidate = observedCandidates(pool, session.date, minuteEnd(decision.time, strategy.step), strategy.pool)
          .find((row) => row.symbol === decision!.order.symbol);
        used.add(decision.order.symbol);
        if (!candidate) {
          outcomes.push(idle(strategy.id, `관측 전 종목(${decision.order.symbol})`, {
            signal: true, signalTime: decision.time, violations: ["규칙 위반 주문: 아직 관측되지 않은 종목"],
          }));
          resumeAfter = minutes(decision.time);
          continue;
        }
        const executed = execute(decision.order, candidate, session.bars[candidate.symbol] ?? [], decision.time, equity, strategy, options);
        executed.marks.forEach(observe);
        equity += executed.outcome.pnlUsd;
        costPaid += executed.outcome.costUsd;
        outcomes.push(executed.outcome);
        // The next search starts after this trade's exit bar — or after the
        // signal when it never filled — exactly as the live runner resumes.
        resumeAfter = minutes(executed.outcome.exitTime ?? decision.time);
      }
      if (!outcomes.length) outcomes.push(idle(strategy.id, "조건 미충족"));
    }

    observe({ low: equity, close: equity });
    closePeak = Math.max(closePeak, equity);
    closeMaxDrawdown = Math.max(closeMaxDrawdown, (closePeak - equity) / closePeak);
    days.push({
      date: session.date,
      startEquityUsd: round(startEquity, 2),
      endEquityUsd: round(equity, 2),
      returnPct: round((equity / startEquity - 1) * 100, 4),
      intradayLowPct: round(Math.min(0, (dayLow / startEquity - 1) * 100), 4),
      intradayDrawdownPct: round(dayDrawdown * 100, 4),
      traded: outcomes.some((outcome) => outcome.traded),
      slots: outcomes,
    });
  }

  const trades = days.flatMap((day) => day.slots).filter((slot) => slot.traded);
  const rs = trades.map((trade) => trade.rMultiple).filter((value): value is number => value !== null);
  const wins = rs.filter((value) => value > 0);
  const losses = rs.filter((value) => value <= 0);
  const avgWinR = wins.length ? round(wins.reduce((a, b) => a + b, 0) / wins.length, 4) : null;
  const avgLossR = losses.length ? round(losses.reduce((a, b) => a + b, 0) / losses.length, 4) : null;
  const payoff = avgWinR !== null && avgLossR !== null && avgLossR < 0
    ? round(avgWinR / Math.abs(avgLossR), 4)
    : null;

  return {
    from: days[0]?.date ?? "",
    to: days.at(-1)?.date ?? "",
    startingCapitalUsd: options.capitalUsd,
    endingEquityUsd: round(equity, 2),
    days,
    metrics: accountMetrics(days, options.capitalUsd, equity, { maxDrawdown, closeMaxDrawdown, costPaidUsd: costPaid }),
    expectancy: {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: rs.length ? round((wins.length / rs.length) * 100, 2) : null,
      expectancyR: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length, 4) : null,
      avgWinR,
      avgLossR,
      payoffRatio: payoff,
      breakEvenWinRatePct: payoff !== null && payoff > 0 ? round((1 / (payoff + 1)) * 100, 2) : null,
      expectancyLower95R: lower95(rs),
      totalRiskedUsd: round(trades.reduce((sum, trade) => sum + trade.riskUsd, 0), 2),
      stopExits: trades.filter((trade) => trade.exit === "stop").length,
      targetExits: trades.filter((trade) => trade.exit === "target").length,
      timeExits: trades.filter((trade) => trade.exit === "time").length,
    },
  };
}

export { adherencePct };
