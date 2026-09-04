/**
 * Opening-range / fair-value-gap intraday backtest on real minute bars.
 *
 * This is the first engine in the Lab that reads intraday *candles* rather than
 * closes, which is what a rule like "the body broke the opening range and left a
 * gap behind" actually needs. Three things it deliberately does the hard way:
 *
 * 1. A fair value gap is only known once the bar *after* the displacement bar has
 *    closed, so entries start one bar later. Marking a gap the moment the middle
 *    bar prints is look-ahead, and it is the single easiest way to manufacture an
 *    edge that does not exist.
 * 2. When one bar's range covers both the stop and the target, the stop wins. The
 *    bar does not say which came first, and the optimistic reading is what turns
 *    a losing rule into a winning backtest.
 * 3. Every run also scores an information-matched control that skips the gap
 *    requirement entirely. If the two score the same, the gap was decoration.
 */

import type { IntradayPoint } from "@/lib/market-data";

export type FvgVariant = "fvg_pullback" | "breakout_close";

export const FVG_VARIANT_LABELS: Record<FvgVariant, string> = {
  fvg_pullback: "FVG 되돌림 진입 (영상 원문 규칙)",
  breakout_close: "대조군 · FVG 조건 없이 돌파 확인봉 종가 진입",
};

export type FvgExitReason = "target" | "stop" | "window_end" | "session_end";

export type FvgTrade = {
  date: string;
  variant: FvgVariant;
  referenceHigh: number;
  referenceLow: number;
  breakoutTime: string;
  fvgBottom: number | null;
  fvgTop: number | null;
  confirmedTime: string;
  entryTime: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskPct: number;
  exitTime: string;
  exitPrice: number;
  exitReason: FvgExitReason;
  rMultiple: number;
  returnPct: number;
  barsHeld: number;
};

/** A session that produced a setup but never a fill, or no setup at all. */
export type FvgMiss = { date: string; variant: FvgVariant; reason: string };

export type FvgSessionScan = { trade: FvgTrade | null; miss: FvgMiss | null };

export type FvgOptions = {
  intervalMinutes: number;
  anchorMinutes: number;
  windowMinutes: number;
  rewardRisk: number;
  costBps: number;
  holdUntil: "window" | "session_close";
};

const RTH_OPEN_MINUTE = 9 * 60 + 30;
const RTH_CLOSE_MINUTE = 16 * 60;

function timeMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function round(value: number, digits = 4) {
  return Number(value.toFixed(digits));
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Regular-hours bars for one date, in order. Pre/post-market bars are dropped. */
export function regularSession(points: IntradayPoint[], date: string) {
  return points
    .filter((point) => point.date === date)
    .filter((point) => {
      const minute = timeMinutes(point.time);
      return minute >= RTH_OPEN_MINUTE && minute < RTH_CLOSE_MINUTE;
    })
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function sessionDates(points: IntradayPoint[]) {
  return [...new Set(points.map((point) => point.date))].sort();
}

/**
 * Walks one session for one variant and returns at most one trade — the rule is
 * "once a day", so the first valid setup is the one that counts.
 */
export function scanSession(points: IntradayPoint[], date: string, variant: FvgVariant, options: FvgOptions): FvgSessionScan {
  const { intervalMinutes, anchorMinutes, windowMinutes, rewardRisk, costBps, holdUntil } = options;
  const bars = regularSession(points, date);
  const miss = (reason: string): FvgSessionScan => ({ trade: null, miss: { date, variant, reason } });
  if (!bars.length) return miss("정규장 분봉 없음");
  if (timeMinutes(bars[0].time) !== RTH_OPEN_MINUTE) return miss(`09:30 시작 봉 없음 (첫 봉 ${bars[0].time})`);

  const anchorBars = Math.max(1, Math.round(anchorMinutes / intervalMinutes));
  if (bars.length <= anchorBars + 2) return miss("기준 캔들 이후 봉이 부족");

  const reference = bars.slice(0, anchorBars);
  const referenceHigh = Math.max(...reference.map((bar) => bar.high));
  const referenceLow = Math.min(...reference.map((bar) => bar.low));
  if (!(referenceHigh > referenceLow)) return miss("기준선 고저가 동일");

  const windowEndMinute = RTH_OPEN_MINUTE + windowMinutes;
  // Scanning stops at the window edge: a breakout at 11:05 is not this rule's trade.
  const lastScanIndex = bars.findLastIndex((bar) => timeMinutes(bar.time) < windowEndMinute);
  if (lastScanIndex < anchorBars) return miss("매매 창 안에 기준 캔들 이후 봉이 없음");

  for (let index = anchorBars; index <= lastScanIndex; index += 1) {
    const bar = bars[index];
    const previous = bars[index - 1];
    // Body breakout of the reference high by a bullish candle, and the first one:
    // the previous close still had to be inside the range.
    const bodyBroke = bar.close > referenceHigh && bar.close > bar.open && previous.close <= referenceHigh;
    if (!bodyBroke) continue;

    const confirmation = bars[index + 1];
    if (!confirmation) return miss("돌파 다음 봉이 없어 확정 불가");
    const stopPrice = previous.low;

    let fvgBottom: number | null = null;
    let fvgTop: number | null = null;
    let entryIndex: number;
    let entryPrice: number;

    if (variant === "fvg_pullback") {
      // Bullish FVG: the bar after the displacement never traded down to where the
      // bar before it traded up to. Known only now that `confirmation` has closed.
      if (!(confirmation.low > previous.high)) return miss("돌파와 함께 FVG가 형성되지 않음");
      fvgBottom = previous.high;
      fvgTop = confirmation.low;
      const zoneTop = fvgTop;
      // Entries start at index + 2: the gap was not confirmed before that.
      const touchIndex = bars.findIndex((candidate, position) => position >= index + 2 && candidate.low <= zoneTop);
      if (touchIndex === -1) return miss("FVG 확정 후 되돌림이 오지 않음");
      const touch = bars[touchIndex];
      // A resting limit at the top of the gap: filled at the open when the bar
      // already opens inside it, otherwise at the gap edge itself.
      entryIndex = touchIndex;
      entryPrice = Math.min(zoneTop, touch.open);
    } else {
      // Control: same breakout, same confirmation timing, no gap requirement.
      entryIndex = index + 1;
      entryPrice = confirmation.close;
    }

    if (!(entryPrice > stopPrice)) return miss("손절가가 진입가 이상 (무효 리스크)");
    const risk = entryPrice - stopPrice;
    const targetPrice = entryPrice + rewardRisk * risk;

    const lastHoldIndex = holdUntil === "window" ? lastScanIndex : bars.length - 1;
    if (entryIndex > lastHoldIndex) return miss("진입 시점이 보유 구간을 벗어남");

    let exitPrice = bars[lastHoldIndex].close;
    let exitTime = bars[lastHoldIndex].time;
    let exitReason: FvgExitReason = holdUntil === "window" ? "window_end" : "session_end";
    for (let position = entryIndex; position <= lastHoldIndex; position += 1) {
      const candidate = bars[position];
      // Stop first: a bar covering both levels does not say which printed first,
      // and assuming the target would be paying ourselves with missing data.
      if (candidate.low <= stopPrice) { exitPrice = stopPrice; exitTime = candidate.time; exitReason = "stop"; break; }
      if (candidate.high >= targetPrice) { exitPrice = targetPrice; exitTime = candidate.time; exitReason = "target"; break; }
    }

    const costPerShare = entryPrice * (costBps / 10_000) * 2; // round trip
    const netProceeds = exitPrice - costPerShare;
    return {
      trade: {
        date, variant, referenceHigh: round(referenceHigh), referenceLow: round(referenceLow),
        breakoutTime: bar.time, fvgBottom: fvgBottom === null ? null : round(fvgBottom), fvgTop: fvgTop === null ? null : round(fvgTop),
        confirmedTime: confirmation.time, entryTime: bars[entryIndex].time, entryPrice: round(entryPrice), stopPrice: round(stopPrice), targetPrice: round(targetPrice),
        riskPct: round((risk / entryPrice) * 100, 3),
        exitTime, exitPrice: round(exitPrice), exitReason,
        rMultiple: round((netProceeds - entryPrice) / risk, 3),
        returnPct: round((netProceeds / entryPrice - 1) * 100, 3),
        barsHeld: 1 + bars.findIndex((candidate) => candidate.time === exitTime) - entryIndex,
      },
      miss: null,
    };
  }
  return miss("매매 창 안에 기준선 몸통 돌파 없음");
}

export type FvgSummary = {
  variant: FvgVariant;
  label: string;
  sessions: number;
  trades: number;
  wins: number;
  winRatePct: number | null;
  breakevenWinRatePct: number;
  averageR: number | null;
  medianR: number | null;
  totalR: number | null;
  averageReturnPct: number | null;
  targetHits: number;
  stopHits: number;
  timeExits: number;
  bestR: number | null;
  worstR: number | null;
  /** Total R with the single best trade removed — a check on outlier dependence. */
  totalRExcludingBest: number | null;
  missReasons: Array<{ reason: string; sessions: number }>;
};

export function summarize(variant: FvgVariant, sessions: number, trades: FvgTrade[], misses: FvgMiss[], rewardRisk: number): FvgSummary {
  const rs = trades.map((trade) => trade.rMultiple);
  const wins = trades.filter((trade) => trade.rMultiple > 0);
  const sortedR = [...rs].sort((left, right) => right - left);
  const counts = new Map<string, number>();
  for (const item of misses) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return {
    variant,
    label: FVG_VARIANT_LABELS[variant],
    sessions,
    trades: trades.length,
    wins: wins.length,
    winRatePct: trades.length ? round((wins.length / trades.length) * 100, 1) : null,
    // Gross breakeven for the chosen reward:risk. Costs push the real bar higher.
    breakevenWinRatePct: round((1 / (1 + rewardRisk)) * 100, 1),
    averageR: rs.length ? round(mean(rs)!, 3) : null,
    medianR: rs.length ? round(median(rs)!, 3) : null,
    totalR: rs.length ? round(rs.reduce((sum, value) => sum + value, 0), 3) : null,
    averageReturnPct: trades.length ? round(mean(trades.map((trade) => trade.returnPct))!, 3) : null,
    targetHits: trades.filter((trade) => trade.exitReason === "target").length,
    stopHits: trades.filter((trade) => trade.exitReason === "stop").length,
    timeExits: trades.filter((trade) => trade.exitReason === "window_end" || trade.exitReason === "session_end").length,
    bestR: sortedR.length ? sortedR[0] : null,
    worstR: sortedR.length ? sortedR.at(-1)! : null,
    totalRExcludingBest: sortedR.length > 1 ? round(sortedR.slice(1).reduce((sum, value) => sum + value, 0), 3) : null,
    missReasons: [...counts.entries()].map(([reason, count]) => ({ reason, sessions: count })).sort((left, right) => right.sessions - left.sessions),
  };
}

export type FvgSymbolResult = {
  symbol: string;
  name: string;
  sessions: number;
  from: string | null;
  to: string | null;
  summaries: FvgSummary[];
  trades: FvgTrade[];
};

export function runFvgBacktest(symbol: string, name: string, points: IntradayPoint[], options: FvgOptions): FvgSymbolResult {
  const dates = sessionDates(points);
  const variants: FvgVariant[] = ["fvg_pullback", "breakout_close"];
  const trades: FvgTrade[] = [];
  const summaries = variants.map((variant) => {
    const variantTrades: FvgTrade[] = [];
    const misses: FvgMiss[] = [];
    for (const date of dates) {
      const scan = scanSession(points, date, variant, options);
      if (scan.trade) variantTrades.push(scan.trade);
      if (scan.miss) misses.push(scan.miss);
    }
    trades.push(...variantTrades);
    return summarize(variant, dates.length, variantTrades, misses, options.rewardRisk);
  });
  return { symbol, name, sessions: dates.length, from: dates[0] ?? null, to: dates.at(-1) ?? null, summaries, trades };
}
