/**
 * H1: small gaps are noise and fill, large gaps are news and run.
 *
 * The exploratory pass found a monotone dose-response on 344 sessions of 5-minute
 * bars — gaps of 0.5-1% filled 77-91% of the time, gaps over 4% filled 15-40% —
 * and a monotone relationship is much harder to produce by chance than a single
 * threshold. This turns that observation into two executable rules and scores
 * them on the same bars.
 *
 * Four constraints shape the rules rather than the statistics:
 *
 * 1. **Long only.** The account cannot short, so the gap-*up* fade — the larger
 *    half of the observation — is not tradable and is not implemented. Only the
 *    gap-down fade (buy the open, target the prior close) and the gap-up
 *    continuation survive that filter. Half of a symmetric edge is not half as
 *    good; it is a different, smaller strategy, and it is the only one on offer.
 * 2. **Entry is the close of the first bar, never the official open.** Nobody
 *    fills at the 09:30:00 print. Using it would credit the strategy with the
 *    single most violent five minutes of the day for free.
 * 3. **The stop wins a tied bar.** When one bar's range covers both the stop and
 *    the target, the bar does not say which printed first, and taking the target
 *    is how a losing rule becomes a winning backtest.
 * 4. **Costs are the account's real costs**, from `broker-costs`, not a 5bps
 *    institutional placeholder.
 *
 * Every trade also records its worst excursion before the exit, because "the gap
 * filled" and "you were still in the position when it filled" are different
 * claims and only the second one pays.
 */

import { roundTripPct } from "./broker-costs.ts";
import { median, round } from "./quant.ts";

export type GapSetupId = "fade_gap_down" | "follow_gap_up";

export const GAP_SETUP_LABELS: Record<GapSetupId, string> = {
  fade_gap_down: "갭 하락 페이드 (전일 종가까지 회복 노림, 롱)",
  follow_gap_up: "갭 상승 추종 (대형 갭 지속 노림, 롱)",
};

export type GapExitReason = "target" | "stop" | "time_stop" | "session_end";

export type GapBar = { date: string; minute: number; open: number; high: number; low: number; close: number; volume: number };

export type GapTrade = {
  symbol: string;
  date: string;
  setup: GapSetupId;
  gapPct: number;
  previousClose: number;
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  /** Distance to the stop, percent of entry. One R. */
  riskPct: number;
  exitTime: number;
  exitPrice: number;
  exitReason: GapExitReason;
  rMultiple: number;
  grossReturnPct: number;
  netReturnPct: number;
  /** Worst drawdown inside the trade before it closed, percent of entry. */
  maxAdversePct: number;
  maxFavorablePct: number;
  barsHeld: number;
};

export type GapSkip = { symbol: string; date: string; reason: string };

export type GapOptions = {
  /** Gap-down fade window, absolute percent. Outside it, the gap is treated as news. */
  fadeMinGapPct: number;
  fadeMaxGapPct: number;
  /** Target-to-stop ratio for the fade. The target is fixed at the prior close. */
  fadeRewardRisk: number;
  /** Minutes past 09:30 after which an unfilled fade is abandoned. */
  fadeTimeStopMinute: number;
  followMinGapPct: number;
  followRewardRisk: number;
  /** Skip a setup whose stop sits further than this from entry. */
  maxRiskPct: number;
  costRoundTripPct: number;
};

export const GAP_DEFAULTS: GapOptions = {
  fadeMinGapPct: 0.5,
  fadeMaxGapPct: 2,
  fadeRewardRisk: 1,
  fadeTimeStopMinute: 12 * 60,
  followMinGapPct: 4,
  followRewardRisk: 2,
  maxRiskPct: 4,
  costRoundTripPct: roundTripPct(),
};

const RTH_OPEN_MINUTE = 9 * 60 + 30;

/**
 * Walks one symbol-session and returns the trade the rules produce, if any.
 *
 * `bars` must be that session's regular-hours bars in order, and `previousClose`
 * the prior session's last regular-hours close. A caller that cannot supply a
 * trustworthy previous close must pass null rather than reach further back: a
 * "gap" measured across a data hole is a multi-day move wearing a gap's name.
 */
export function scanGapSession(
  symbol: string,
  date: string,
  bars: GapBar[],
  previousClose: number | null,
  options: GapOptions,
): { trade: GapTrade | null; skip: GapSkip | null } {
  const skip = (reason: string) => ({ trade: null, skip: { symbol, date, reason } });
  if (!bars.length) return skip("정규장 분봉 없음");
  if (bars[0].minute !== RTH_OPEN_MINUTE) return skip(`09:30 시작 봉 없음 (첫 봉 ${bars[0].minute})`);
  if (previousClose === null || !(previousClose > 0)) return skip("직전 종가 없음 — 갭 계산 불가");
  // The rule needs an entry bar and at least one bar after it to trade against.
  // Demanding more would silently drop short but legitimate sessions.
  if (bars.length < 2) return skip("봉 수 부족 — 진입 봉 이후 봉이 없음");

  const first = bars[0];
  const gapPct = (first.open / previousClose - 1) * 100;

  let setup: GapSetupId;
  let stopPrice: number;
  let targetPrice: number;
  // Entry is the first bar's close: a price that actually traded, after the
  // opening auction has cleared.
  const entryPrice = first.close;

  if (gapPct <= -options.fadeMinGapPct && gapPct >= -options.fadeMaxGapPct) {
    setup = "fade_gap_down";
    targetPrice = previousClose;
    if (!(targetPrice > entryPrice)) return skip("첫 봉이 이미 갭을 메워 목표가가 진입가 아래");
    stopPrice = entryPrice - (targetPrice - entryPrice) / options.fadeRewardRisk;
  } else if (gapPct >= options.followMinGapPct) {
    setup = "follow_gap_up";
    stopPrice = first.low;
    if (!(entryPrice > stopPrice)) return skip("첫 봉 저가가 진입가 이상 — 유효 리스크 없음");
    targetPrice = entryPrice + (entryPrice - stopPrice) * options.followRewardRisk;
  } else {
    return skip(`갭 ${round(gapPct, 2)}% — 어느 규칙에도 해당 없음`);
  }

  const risk = entryPrice - stopPrice;
  if (!(risk > 0)) return skip("유효 리스크 없음");
  const riskPct = (risk / entryPrice) * 100;
  if (riskPct > options.maxRiskPct) return skip(`손절폭 ${round(riskPct, 2)}% > 상한 ${options.maxRiskPct}%`);

  const timeStopMinute = setup === "fade_gap_down" ? options.fadeTimeStopMinute : Number.POSITIVE_INFINITY;
  let exitPrice = bars.at(-1)!.close;
  let exitTime = bars.at(-1)!.minute;
  let exitIndex = bars.length - 1;
  let exitReason: GapExitReason = "session_end";
  let worstLow = first.close;
  let bestHigh = first.close;

  // Scanning starts one bar after entry: the entry bar has already closed.
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    if (bar.minute >= timeStopMinute) {
      exitPrice = bars[index - 1].close; exitTime = bars[index - 1].minute; exitIndex = index - 1; exitReason = "time_stop";
      break;
    }
    worstLow = Math.min(worstLow, bar.low);
    bestHigh = Math.max(bestHigh, bar.high);
    if (bar.low <= stopPrice) { exitPrice = stopPrice; exitTime = bar.minute; exitIndex = index; exitReason = "stop"; break; }
    if (bar.high >= targetPrice) { exitPrice = targetPrice; exitTime = bar.minute; exitIndex = index; exitReason = "target"; break; }
  }

  const costPerShare = entryPrice * (options.costRoundTripPct / 100);
  const netExit = exitPrice - costPerShare;
  return {
    trade: {
      symbol, date, setup,
      gapPct: round(gapPct, 3)!,
      previousClose: round(previousClose, 4)!,
      entryTime: first.minute,
      entryPrice: round(entryPrice, 4)!,
      stopPrice: round(stopPrice, 4)!,
      targetPrice: round(targetPrice, 4)!,
      riskPct: round(riskPct, 3)!,
      exitTime, exitPrice: round(exitPrice, 4)!, exitReason,
      rMultiple: round((netExit - entryPrice) / risk, 3)!,
      grossReturnPct: round((exitPrice / entryPrice - 1) * 100, 3)!,
      netReturnPct: round((netExit / entryPrice - 1) * 100, 3)!,
      maxAdversePct: round((worstLow / entryPrice - 1) * 100, 3)!,
      maxFavorablePct: round((bestHigh / entryPrice - 1) * 100, 3)!,
      barsHeld: exitIndex,
    },
    skip: null,
  };
}

export type GapSetupSummary = {
  setup: GapSetupId;
  label: string;
  trades: number;
  wins: number;
  winRatePct: number | null;
  breakevenWinRatePct: number;
  averageR: number | null;
  medianR: number | null;
  totalR: number | null;
  totalRExcludingBest: number | null;
  averageNetReturnPct: number | null;
  targetHits: number;
  stopHits: number;
  timeStops: number;
  /** Median worst drawdown inside a trade — the part a fill rate cannot show. */
  medianMaxAdversePct: number | null;
  worstMaxAdversePct: number | null;
  averageRiskPct: number | null;
};

export function summarizeGapSetup(setup: GapSetupId, trades: GapTrade[], rewardRisk: number, costRoundTripPct: number): GapSetupSummary {
  const own = trades.filter((trade) => trade.setup === setup);
  const rs = own.map((trade) => trade.rMultiple);
  const sortedR = [...rs].sort((left, right) => right - left);
  const wins = own.filter((trade) => trade.rMultiple > 0);
  const averageRisk = own.length ? own.reduce((sum, trade) => sum + trade.riskPct, 0) / own.length : null;
  // Costs are a fixed share of notional, so their weight in R depends on the
  // stop actually used; the breakeven bar is computed at the realised average.
  const costR = averageRisk ? costRoundTripPct / averageRisk : 0;
  const netWin = rewardRisk - costR;
  const netLoss = 1 + costR;
  return {
    setup,
    label: GAP_SETUP_LABELS[setup],
    trades: own.length,
    wins: wins.length,
    winRatePct: own.length ? round((wins.length / own.length) * 100, 1) : null,
    breakevenWinRatePct: netWin > 0 ? round((netLoss / (netWin + netLoss)) * 100, 1)! : 100,
    averageR: rs.length ? round(rs.reduce((sum, value) => sum + value, 0) / rs.length, 3) : null,
    medianR: round(median(rs), 3),
    totalR: rs.length ? round(rs.reduce((sum, value) => sum + value, 0), 3) : null,
    totalRExcludingBest: sortedR.length > 1 ? round(sortedR.slice(1).reduce((sum, value) => sum + value, 0), 3) : null,
    averageNetReturnPct: own.length ? round(own.reduce((sum, trade) => sum + trade.netReturnPct, 0) / own.length, 3) : null,
    targetHits: own.filter((trade) => trade.exitReason === "target").length,
    stopHits: own.filter((trade) => trade.exitReason === "stop").length,
    timeStops: own.filter((trade) => trade.exitReason === "time_stop" || trade.exitReason === "session_end").length,
    medianMaxAdversePct: round(median(own.map((trade) => trade.maxAdversePct)), 3),
    worstMaxAdversePct: own.length ? round(Math.min(...own.map((trade) => trade.maxAdversePct)), 3) : null,
    averageRiskPct: round(averageRisk, 3),
  };
}

export type GapEquityPoint = { date: string; trades: number; dailyReturnPct: number; equity: number };

export type GapPortfolio = {
  riskPerTradePct: number;
  /** Cap on how many of a day's setups are taken, oldest-symbol-first. */
  maxTradesPerDay: number;
  sessions: number;
  tradingDays: number;
  totalReturnPct: number;
  averageDailyReturnPct: number;
  medianDailyReturnPct: number;
  bestDayPct: number | null;
  worstDayPct: number | null;
  maxDrawdownPct: number;
  winningDays: number;
  losingDays: number;
  flatDays: number;
  equityCurve: GapEquityPoint[];
};

/**
 * Compounds the trades into an account curve at fixed fractional risk.
 *
 * Trades on the same date are treated as concurrent positions sized off the same
 * starting equity, which is what actually happens when several symbols gap on
 * one morning — sizing each off the running intraday balance would pretend the
 * first trade closed before the second opened.
 */
export function buildGapPortfolio(trades: GapTrade[], riskPerTradePct: number, maxTradesPerDay: number): GapPortfolio {
  const byDate = new Map<string, GapTrade[]>();
  for (const trade of trades) {
    if (!byDate.has(trade.date)) byDate.set(trade.date, []);
    byDate.get(trade.date)!.push(trade);
  }
  const dates = [...byDate.keys()].sort();
  const riskFraction = riskPerTradePct / 100;
  let equity = 1;
  let peak = 1;
  let maxDrawdownPct = 0;
  const equityCurve: GapEquityPoint[] = [];

  for (const date of dates) {
    const taken = byDate.get(date)!
      .sort((left, right) => left.symbol.localeCompare(right.symbol))
      .slice(0, maxTradesPerDay);
    const dayR = taken.reduce((sum, trade) => sum + trade.rMultiple, 0);
    const dailyReturnPct = dayR * riskFraction * 100;
    equity *= 1 + dayR * riskFraction;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (1 - equity / peak) * 100);
    equityCurve.push({ date, trades: taken.length, dailyReturnPct: round(dailyReturnPct, 4)!, equity: round(equity, 6)! });
  }

  const daily = equityCurve.map((point) => point.dailyReturnPct);
  return {
    riskPerTradePct,
    maxTradesPerDay,
    sessions: trades.length,
    tradingDays: dates.length,
    totalReturnPct: round((equity - 1) * 100, 4)!,
    // The average is taken over days the strategy actually traded. A calendar
    // average would be a different, smaller number and both are reported by the
    // caller, because which one is meant is exactly where these claims go wrong.
    averageDailyReturnPct: daily.length ? round(daily.reduce((sum, value) => sum + value, 0) / daily.length, 4)! : 0,
    medianDailyReturnPct: round(median(daily), 4) ?? 0,
    bestDayPct: daily.length ? round(Math.max(...daily), 4) : null,
    worstDayPct: daily.length ? round(Math.min(...daily), 4) : null,
    maxDrawdownPct: round(maxDrawdownPct, 4)!,
    winningDays: daily.filter((value) => value > 0).length,
    losingDays: daily.filter((value) => value < 0).length,
    flatDays: daily.filter((value) => value === 0).length,
    equityCurve,
  };
}
