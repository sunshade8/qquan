/**
 * Deterministic quantitative helpers over daily OHLCV bars. No LLM involvement:
 * every number the agents quote should be traceable to one of these functions.
 */

export type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };
export type CloseRow = { date: string; close: number };

const TRADING_DAYS = 252;

export function round(value: number | null | undefined, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

export function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function standardDeviation(values: number[]) {
  if (values.length < 2) return null;
  const average = mean(values)!;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

export function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

export function correlation(left: number[], right: number[]) {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = mean(left)!;
  const rightMean = mean(right)!;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator ? covariance / denominator : null;
}

export function dailyReturns(rows: CloseRow[]) {
  return rows.slice(1).map((row, index) => row.close / rows[index].close - 1);
}

export function sma(values: number[], period: number): Array<number | null> {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    return index >= period - 1 ? sum / period : null;
  });
}

export function ema(values: number[], period: number): Array<number | null> {
  const multiplier = 2 / (period + 1);
  let previous: number | null = null;
  return values.map((value, index) => {
    if (index < period - 1) return null;
    if (previous === null) {
      previous = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
      return previous;
    }
    previous = (value - previous) * multiplier + previous;
    return previous;
  });
}

export function rsi(closes: number[], period = 14): Array<number | null> {
  const output: Array<number | null> = closes.map(() => null);
  if (closes.length <= period) return output;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = closes[index] - closes[index - 1];
    if (delta >= 0) gain += delta; else loss -= delta;
  }
  gain /= period;
  loss /= period;
  output[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let index = period + 1; index < closes.length; index += 1) {
    const delta = closes[index] - closes[index - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
    output[index] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return output;
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9) {
  const fastLine = ema(closes, fast);
  const slowLine = ema(closes, slow);
  const line = closes.map((_, index) => fastLine[index] !== null && slowLine[index] !== null ? fastLine[index]! - slowLine[index]! : null);
  const valid = line.map((value) => value ?? 0);
  const firstValid = line.findIndex((value) => value !== null);
  const signalRaw = firstValid >= 0 ? ema(valid.slice(firstValid), signalPeriod) : [];
  const signal = line.map((_, index) => index >= firstValid && firstValid >= 0 ? signalRaw[index - firstValid] ?? null : null);
  const histogram = line.map((value, index) => value !== null && signal[index] !== null ? value - signal[index]! : null);
  return { line, signal, histogram };
}

export function bollinger(closes: number[], period = 20, width = 2) {
  const middle = sma(closes, period);
  const upper: Array<number | null> = [];
  const lower: Array<number | null> = [];
  for (let index = 0; index < closes.length; index += 1) {
    if (middle[index] === null) { upper.push(null); lower.push(null); continue; }
    const window = closes.slice(index - period + 1, index + 1);
    const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - middle[index]!) ** 2, 0) / period);
    upper.push(middle[index]! + width * deviation);
    lower.push(middle[index]! - width * deviation);
  }
  return { middle, upper, lower };
}

export function atr(rows: Bar[], period = 14): Array<number | null> {
  const trueRanges = rows.map((row, index) => index === 0 ? row.high - row.low : Math.max(row.high - row.low, Math.abs(row.high - rows[index - 1].close), Math.abs(row.low - rows[index - 1].close)));
  return sma(trueRanges, period);
}

export function drawdownSeries(closes: number[]) {
  let peak = -Infinity;
  return closes.map((close) => {
    peak = Math.max(peak, close);
    return (close / peak - 1) * 100;
  });
}

export function maxDrawdown(closes: number[]) {
  const series = drawdownSeries(closes);
  return series.length ? Math.min(...series) : null;
}

export function annualizedVolatility(returns: number[]) {
  const deviation = standardDeviation(returns);
  return deviation === null ? null : deviation * Math.sqrt(TRADING_DAYS) * 100;
}

export function sharpe(returns: number[], riskFreeAnnual = 0) {
  const deviation = standardDeviation(returns);
  const average = mean(returns);
  if (deviation === null || average === null || deviation === 0) return null;
  return ((average - riskFreeAnnual / TRADING_DAYS) / deviation) * Math.sqrt(TRADING_DAYS);
}

export function sortino(returns: number[]) {
  const average = mean(returns);
  const downside = returns.filter((value) => value < 0);
  if (average === null || downside.length < 2) return null;
  const downsideDeviation = Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / returns.length);
  return downsideDeviation ? (average / downsideDeviation) * Math.sqrt(TRADING_DAYS) : null;
}

export function cagr(startClose: number, endClose: number, sessions: number) {
  if (sessions < 2 || startClose <= 0) return null;
  const years = sessions / TRADING_DAYS;
  return (Math.pow(endClose / startClose, 1 / years) - 1) * 100;
}

export function beta(assetReturns: number[], benchmarkReturns: number[]) {
  if (assetReturns.length !== benchmarkReturns.length || assetReturns.length < 3) return null;
  const assetMean = mean(assetReturns)!;
  const benchmarkMean = mean(benchmarkReturns)!;
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < assetReturns.length; index += 1) {
    covariance += (assetReturns[index] - assetMean) * (benchmarkReturns[index] - benchmarkMean);
    variance += (benchmarkReturns[index] - benchmarkMean) ** 2;
  }
  return variance ? covariance / variance : null;
}

export function summaryStats(rows: Bar[]) {
  if (rows.length < 2) return null;
  const closes = rows.map((row) => row.close);
  const returns = dailyReturns(rows);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const high = rows.reduce((best, row) => row.high > best.high ? row : best, rows[0]);
  const low = rows.reduce((best, row) => row.low < best.low ? row : best, rows[0]);
  return {
    from: first.date, to: last.date, sessions: rows.length,
    startClose: round(first.close, 4), endClose: round(last.close, 4),
    returnPct: round((last.close / first.close - 1) * 100),
    cagrPct: round(cagr(first.close, last.close, rows.length)),
    annualizedVolatilityPct: round(annualizedVolatility(returns)),
    sharpe: round(sharpe(returns), 2),
    sortino: round(sortino(returns), 2),
    maxDrawdownPct: round(maxDrawdown(closes)),
    bestDayPct: round(Math.max(...returns) * 100),
    worstDayPct: round(Math.min(...returns) * 100),
    upDayRatePct: round((returns.filter((value) => value > 0).length / returns.length) * 100, 1),
    periodHigh: { date: high.date, price: round(high.high, 4) },
    periodLow: { date: low.date, price: round(low.low, 4) },
    averageVolume: Math.round(rows.reduce((sum, row) => sum + row.volume, 0) / rows.length),
    var95DailyPct: round((percentile(returns, .05) ?? 0) * 100),
  };
}

/** Trailing returns measured back from the last bar. */
export function trailingReturns(rows: Bar[]): Record<string, number | null> {
  const last = rows.at(-1);
  if (!last) return {};
  const lookup = (sessions: number) => {
    const base = rows[rows.length - 1 - sessions];
    return base ? round((last.close / base.close - 1) * 100) : null;
  };
  const yearStart = rows.find((row) => row.date >= `${last.date.slice(0, 4)}-01-01`);
  return {
    "1W": lookup(5), "1M": lookup(21), "3M": lookup(63), "6M": lookup(126), "1Y": lookup(252),
    YTD: yearStart && yearStart !== last ? round((last.close / yearStart.close - 1) * 100) : null,
  };
}

export function alignSeries(series: Array<{ key: string; rows: CloseRow[] }>) {
  if (!series.length) return { dates: [], closes: {} as Record<string, number[]> };
  const maps = series.map((item) => new Map(item.rows.map((row) => [row.date, row.close])));
  const dates = series[0].rows.map((row) => row.date).filter((date) => maps.every((map) => map.has(date)));
  const closes: Record<string, number[]> = {};
  series.forEach((item, index) => { closes[item.key] = dates.map((date) => maps[index].get(date)!); });
  return { dates, closes };
}

export function normalizeTo100(values: number[]) {
  const base = values[0];
  return values.map((value) => (value / base) * 100);
}

export type EventFeature = "return1d" | "gap" | "range" | "volume20" | "rsi14" | "drawdown";
export type EventOperator = "gt" | "lt";

export const EVENT_FEATURE_LABELS: Record<EventFeature, string> = {
  return1d: "일간 수익률 (%)", gap: "시가 갭 (%)", range: "일중 변동폭 (%)", volume20: "20일 평균 대비 거래량 (배)", rsi14: "RSI(14)", drawdown: "고점 대비 낙폭 (%)",
};

export function featureSeries(rows: Bar[], feature: EventFeature): Array<number | null> {
  const closes = rows.map((row) => row.close);
  if (feature === "rsi14") return rsi(closes, 14);
  if (feature === "drawdown") return drawdownSeries(closes);
  const volumeAverage = sma(rows.map((row) => row.volume), 20);
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    if (!previous) return null;
    if (feature === "return1d") return (row.close / previous.close - 1) * 100;
    if (feature === "gap") return (row.open / previous.close - 1) * 100;
    if (feature === "range") return ((row.high - row.low) / row.open) * 100;
    const average = volumeAverage[index - 1];
    return average ? row.volume / average : null;
  });
}

export function eventStudy(rows: Bar[], feature: EventFeature, operator: EventOperator, threshold: number, horizon: number) {
  const values = featureSeries(rows, feature);
  const occurrences: Array<{ date: string; value: number; forwardReturnPct: number; close: number }> = [];
  for (let index = 1; index < rows.length - horizon; index += 1) {
    const value = values[index];
    if (value === null) continue;
    const hit = operator === "gt" ? value > threshold : value < threshold;
    if (!hit) continue;
    occurrences.push({ date: rows[index].date, value: round(value)!, forwardReturnPct: round((rows[index + horizon].close / rows[index].close - 1) * 100)!, close: round(rows[index].close, 4)! });
  }
  const forward = occurrences.map((item) => item.forwardReturnPct);
  const baseline = rows.slice(0, rows.length - horizon).map((row, index) => (rows[index + horizon].close / row.close - 1) * 100);
  return {
    feature, operator, threshold, horizon,
    occurrences: occurrences.length,
    positiveRatePct: forward.length ? round((forward.filter((value) => value > 0).length / forward.length) * 100, 1) : null,
    averagePct: round(mean(forward)), medianPct: round(median(forward)),
    bestPct: forward.length ? round(Math.max(...forward)) : null, worstPct: forward.length ? round(Math.min(...forward)) : null,
    stdDevPct: round(standardDeviation(forward)),
    baselineAveragePct: round(mean(baseline)), baselinePositiveRatePct: baseline.length ? round((baseline.filter((value) => value > 0).length / baseline.length) * 100, 1) : null,
    events: occurrences.slice(-12).reverse(),
    distribution: histogram(forward, 9),
  };
}

export function histogram(values: number[], buckets = 9) {
  if (values.length < 2) return [];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const width = (high - low) / buckets || 1;
  const bins = Array.from({ length: buckets }, (_, index) => ({ from: round(low + index * width, 2)!, to: round(low + (index + 1) * width, 2)!, count: 0 }));
  for (const value of values) bins[Math.min(buckets - 1, Math.floor((value - low) / width))].count += 1;
  return bins;
}

export function seasonality(rows: Bar[]) {
  const monthly = new Map<string, number[]>();
  const weekday = new Map<number, number[]>();
  const monthNames = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];
  const weekdayNames = ["일", "월", "화", "수", "목", "금", "토"];
  let monthStart = rows[0];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = rows[index - 1];
    const day = new Date(`${row.date}T00:00:00Z`).getUTCDay();
    (weekday.get(day) ?? weekday.set(day, []).get(day)!).push((row.close / previous.close - 1) * 100);
    if (row.date.slice(0, 7) !== previous.date.slice(0, 7)) {
      const key = previous.date.slice(5, 7);
      (monthly.get(key) ?? monthly.set(key, []).get(key)!).push((previous.close / monthStart.close - 1) * 100);
      monthStart = previous;
    }
  }
  return {
    monthly: monthNames.map((name, index) => {
      const values = monthly.get(String(index + 1).padStart(2, "0")) ?? [];
      return { label: name, samples: values.length, averagePct: round(mean(values)), medianPct: round(median(values)), positiveRatePct: values.length ? round((values.filter((value) => value > 0).length / values.length) * 100, 1) : null };
    }),
    weekday: [1, 2, 3, 4, 5].map((day) => {
      const values = weekday.get(day) ?? [];
      return { label: weekdayNames[day], samples: values.length, averagePct: round(mean(values)), positiveRatePct: values.length ? round((values.filter((value) => value > 0).length / values.length) * 100, 1) : null };
    }),
    years: new Set(rows.map((row) => row.date.slice(0, 4))).size,
  };
}

export type StrategyId = "sma_cross" | "momentum" | "rsi_reversal" | "breakout" | "buy_and_hold";

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  sma_cross: "이동평균 골든/데드크로스", momentum: "추세 추종 (종가 > SMA)", rsi_reversal: "RSI 평균회귀", breakout: "N일 신고가 돌파", buy_and_hold: "매수 후 보유",
};

export type StrategyParams = { fast?: number; slow?: number; period?: number; entry?: number; exit?: number; lookback?: number; exitLookback?: number };

function positionSignals(rows: Bar[], strategy: StrategyId, params: StrategyParams) {
  const closes = rows.map((row) => row.close);
  const signals: boolean[] = rows.map(() => false);
  if (strategy === "buy_and_hold") return rows.map(() => true);
  if (strategy === "sma_cross") {
    const fast = sma(closes, params.fast ?? 50);
    const slow = sma(closes, params.slow ?? 200);
    return rows.map((_, index) => fast[index] !== null && slow[index] !== null && fast[index]! > slow[index]!);
  }
  if (strategy === "momentum") {
    const trend = sma(closes, params.period ?? 200);
    return rows.map((row, index) => trend[index] !== null && row.close > trend[index]!);
  }
  if (strategy === "rsi_reversal") {
    const oscillator = rsi(closes, params.period ?? 14);
    const entry = params.entry ?? 30;
    const exit = params.exit ?? 55;
    let holding = false;
    return rows.map((_, index) => {
      const value = oscillator[index];
      if (value === null) return false;
      if (!holding && value < entry) holding = true;
      else if (holding && value > exit) holding = false;
      return holding;
    });
  }
  const lookback = params.lookback ?? 55;
  const exitLookback = params.exitLookback ?? 20;
  let holding = false;
  for (let index = 1; index < rows.length; index += 1) {
    const priorHighs = rows.slice(Math.max(0, index - lookback), index).map((row) => row.high);
    const priorLows = rows.slice(Math.max(0, index - exitLookback), index).map((row) => row.low);
    if (!holding && priorHighs.length >= lookback && rows[index].close > Math.max(...priorHighs)) holding = true;
    else if (holding && priorLows.length >= exitLookback && rows[index].close < Math.min(...priorLows)) holding = false;
    signals[index] = holding;
  }
  return signals;
}

/**
 * Long-only rule backtest. Signals are evaluated on the close and executed at the
 * next session's close, so no bar ever trades on information it could not have had.
 */
export function backtestStrategy(rows: Bar[], strategy: StrategyId, params: StrategyParams = {}, costBps = 5) {
  if (rows.length < 30) return null;
  const signals = positionSignals(rows, strategy, params);
  const cost = costBps / 10_000;
  let equity = 1;
  let benchmark = 1;
  // Start in the state the rule prescribes on the first bar so buy-and-hold matches the benchmark exactly.
  let position = Boolean(signals[0]);
  let entryPrice = position ? rows[0].close : 0;
  let entryDate = position ? rows[0].date : "";
  const equityCurve: Array<{ date: string; strategy: number; benchmark: number }> = [{ date: rows[0].date, strategy: 100, benchmark: 100 }];
  const trades: Array<{ entryDate: string; exitDate: string; entryPrice: number; exitPrice: number; returnPct: number; sessions: number }> = [];
  const strategyReturns: number[] = [];
  let sessionsHeld = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const dailyReturn = rows[index].close / rows[index - 1].close - 1;
    benchmark *= 1 + dailyReturn;
    let periodReturn = position ? dailyReturn : 0;
    const target = signals[index - 1];
    if (target !== position) {
      periodReturn -= cost;
      if (target) { entryPrice = rows[index].close; entryDate = rows[index].date; sessionsHeld = 0; }
      else trades.push({ entryDate, exitDate: rows[index].date, entryPrice: round(entryPrice, 4)!, exitPrice: round(rows[index].close, 4)!, returnPct: round((rows[index].close / entryPrice - 1) * 100)!, sessions: sessionsHeld });
      position = target;
    }
    if (position) sessionsHeld += 1;
    equity *= 1 + periodReturn;
    strategyReturns.push(periodReturn);
    equityCurve.push({ date: rows[index].date, strategy: round(equity * 100, 3)!, benchmark: round(benchmark * 100, 3)! });
  }
  if (position) trades.push({ entryDate, exitDate: rows.at(-1)!.date, entryPrice: round(entryPrice, 4)!, exitPrice: round(rows.at(-1)!.close, 4)!, returnPct: round((rows.at(-1)!.close / entryPrice - 1) * 100)!, sessions: sessionsHeld });
  const benchmarkReturns = dailyReturns(rows);
  const wins = trades.filter((trade) => trade.returnPct > 0);
  return {
    strategy, params, costBps, from: rows[0].date, to: rows.at(-1)!.date, sessions: rows.length,
    metrics: {
      totalReturnPct: round((equity - 1) * 100), benchmarkReturnPct: round((benchmark - 1) * 100),
      cagrPct: round(cagr(1, equity, rows.length)), benchmarkCagrPct: round(cagr(1, benchmark, rows.length)),
      sharpe: round(sharpe(strategyReturns), 2), benchmarkSharpe: round(sharpe(benchmarkReturns), 2),
      maxDrawdownPct: round(maxDrawdown(equityCurve.map((point) => point.strategy))), benchmarkMaxDrawdownPct: round(maxDrawdown(rows.map((row) => row.close))),
      annualizedVolatilityPct: round(annualizedVolatility(strategyReturns)),
      trades: trades.length, winRatePct: trades.length ? round((wins.length / trades.length) * 100, 1) : null,
      averageTradePct: round(mean(trades.map((trade) => trade.returnPct))),
      exposurePct: round((signals.filter(Boolean).length / signals.length) * 100, 1),
    },
    equityCurve, trades: trades.slice(-30),
  };
}

export function riskProfile(rows: Bar[], benchmarkRows: Bar[] | null) {
  const stats = summaryStats(rows);
  if (!stats) return null;
  const returns = dailyReturns(rows);
  let assetBeta: number | null = null;
  let benchmarkCorrelation: number | null = null;
  if (benchmarkRows) {
    const aligned = alignSeries([{ key: "asset", rows }, { key: "bench", rows: benchmarkRows }]);
    const assetReturns = dailyReturns(aligned.dates.map((date, index) => ({ date, close: aligned.closes.asset[index] })));
    const benchReturns = dailyReturns(aligned.dates.map((date, index) => ({ date, close: aligned.closes.bench[index] })));
    assetBeta = beta(assetReturns, benchReturns);
    benchmarkCorrelation = correlation(assetReturns, benchReturns);
  }
  return {
    ...stats,
    beta: round(assetBeta, 2), benchmarkCorrelation: round(benchmarkCorrelation, 2),
    downsideDeviationPct: round((standardDeviation(returns.filter((value) => value < 0)) ?? 0) * Math.sqrt(TRADING_DAYS) * 100),
    cvar95DailyPct: round((mean(returns.filter((value) => value <= (percentile(returns, .05) ?? 0))) ?? 0) * 100),
  };
}

export function findLargestMoves(rows: Bar[], count = 3, direction: "down" | "up" = "down") {
  const moves = rows.slice(1).map((row, index) => ({ date: row.date, close: row.close, priorClose: rows[index].close, returnPct: (row.close / rows[index].close - 1) * 100 }));
  const sorted = direction === "down" ? moves.filter((row) => row.returnPct < 0).sort((a, b) => a.returnPct - b.returnPct) : moves.filter((row) => row.returnPct > 0).sort((a, b) => b.returnPct - a.returnPct);
  return sorted.slice(0, Math.max(1, count));
}
