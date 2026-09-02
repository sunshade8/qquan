/**
 * Cross-sectional screening and pooled conditional statistics.
 *
 * Both halves answer questions the per-symbol tools cannot: "which symbols look
 * like X right now" (screen) and "across a whole universe, what follows X"
 * (pooled study). Everything here is pure over already-loaded daily bars so it
 * is unit-testable without touching the network.
 */

import {
  annualizedVolatility, drawdownSeries, histogram, mean, median, rsi, round, sharpe, sma, standardDeviation,
  type Bar,
} from "./quant.ts";

export type ScreenMetric =
  | "return" | "rsi14" | "volatility" | "volume_ratio" | "dollar_volume" | "drawdown"
  | "sma_distance" | "sharpe" | "gap" | "range" | "close" | "max_up_day" | "max_down_day" | "positive_day_rate";

export const SCREEN_METRIC_LABELS: Record<ScreenMetric, string> = {
  return: "기간 수익률 (%)",
  rsi14: "RSI(14)",
  volatility: "연환산 변동성 (%)",
  volume_ratio: "거래량 / 20일 평균 (배)",
  dollar_volume: "20일 평균 거래대금 (백만$)",
  drawdown: "기간 고점 대비 낙폭 (%)",
  sma_distance: "SMA 대비 이격 (%)",
  sharpe: "샤프 (기간)",
  gap: "당일 시가 갭 (%)",
  range: "당일 변동폭 (%)",
  close: "종가",
  max_up_day: "기간 최대 상승일 (%)",
  max_down_day: "기간 최대 하락일 (%)",
  positive_day_rate: "상승 마감 비율 (%)",
};

/** Metrics whose `period` is a lookback in sessions rather than an indicator length. */
const LOOKBACK_METRICS = new Set<ScreenMetric>(["return", "volatility", "sharpe", "drawdown", "sharpe", "max_up_day", "max_down_day", "positive_day_rate"]);

export const SCREEN_METRICS = Object.keys(SCREEN_METRIC_LABELS) as ScreenMetric[];

function defaultPeriod(metric: ScreenMetric) {
  if (metric === "sma_distance") return 200;
  if (metric === "volume_ratio" || metric === "dollar_volume") return 20;
  if (metric === "rsi14") return 14;
  return 126; // ~6 months of sessions for the lookback family
}

function windowReturns(rows: Bar[], period: number) {
  const window = rows.slice(-Math.max(2, period + 1));
  return window.slice(1).map((row, index) => row.close / window[index].close - 1);
}

/**
 * One metric for one symbol, read at the latest bar. Returns null when the
 * history is too short for the requested period, so a symbol is dropped from a
 * screen rather than ranked on a fabricated value.
 */
export function metricValue(rows: Bar[], metric: ScreenMetric, period?: number): number | null {
  if (rows.length < 3) return null;
  const length = Math.max(2, Math.round(period ?? defaultPeriod(metric)));
  const closes = rows.map((row) => row.close);
  const latest = rows.at(-1)!;
  switch (metric) {
    case "close": return round(latest.close, 4);
    case "return": {
      if (rows.length <= length) return null;
      return round((latest.close / rows[rows.length - 1 - length].close - 1) * 100);
    }
    case "rsi14": {
      const value = rsi(closes, length).at(-1);
      return value === null || value === undefined ? null : round(value, 2);
    }
    case "volatility": {
      if (rows.length <= length) return null;
      return round(annualizedVolatility(windowReturns(rows, length)));
    }
    case "sharpe": {
      if (rows.length <= length) return null;
      return round(sharpe(windowReturns(rows, length)), 2);
    }
    case "volume_ratio": {
      const average = sma(rows.map((row) => row.volume), length).at(-2);
      return average ? round(latest.volume / average, 2) : null;
    }
    case "dollar_volume": {
      const window = rows.slice(-length);
      if (window.length < length) return null;
      return round(mean(window.map((row) => row.close * row.volume))! / 1_000_000, 1);
    }
    case "drawdown": {
      if (rows.length <= length) return null;
      const value = drawdownSeries(closes.slice(-length - 1)).at(-1);
      return value === null || value === undefined ? null : round(value);
    }
    case "sma_distance": {
      const average = sma(closes, length).at(-1);
      return average ? round((latest.close / average - 1) * 100) : null;
    }
    case "gap": {
      const previous = rows.at(-2)!;
      return round((latest.open / previous.close - 1) * 100);
    }
    case "range": return latest.open ? round(((latest.high - latest.low) / latest.open) * 100) : null;
    case "max_up_day": {
      if (rows.length <= length) return null;
      return round(Math.max(...windowReturns(rows, length)) * 100);
    }
    case "max_down_day": {
      if (rows.length <= length) return null;
      return round(Math.min(...windowReturns(rows, length)) * 100);
    }
    case "positive_day_rate": {
      if (rows.length <= length) return null;
      const returns = windowReturns(rows, length);
      return round((returns.filter((value) => value > 0).length / returns.length) * 100, 1);
    }
    default: return null;
  }
}

export type ScreenFilter = { metric: ScreenMetric; period?: number; op: "gt" | "lt" | "gte" | "lte"; value: number };
export type ScreenRank = { metric: ScreenMetric; period?: number; direction: "desc" | "asc" };
export type ScreenCandidate = { symbol: string; name: string; rows: Bar[] };

export type ScreenRow = {
  symbol: string;
  name: string;
  latestDate: string;
  close: number;
  values: Record<string, number | null>;
  rankValue: number;
};

export type ScreenResult = {
  rankLabel: string;
  columns: Array<{ key: string; label: string }>;
  rows: ScreenRow[];
  excluded: Array<{ symbol: string; reason: string }>;
};

function columnKey(metric: ScreenMetric, period?: number) {
  const resolved = Math.round(period ?? defaultPeriod(metric));
  return LOOKBACK_METRICS.has(metric) || metric === "sma_distance" || metric === "rsi14" || metric === "volume_ratio" || metric === "dollar_volume"
    ? `${metric}_${resolved}`
    : metric;
}

function columnLabel(metric: ScreenMetric, period?: number) {
  const resolved = Math.round(period ?? defaultPeriod(metric));
  const base = SCREEN_METRIC_LABELS[metric];
  if (metric === "return") return `${resolved}일 수익률 (%)`;
  if (metric === "volatility") return `${resolved}일 변동성 (%)`;
  if (metric === "sharpe") return `${resolved}일 샤프`;
  if (metric === "drawdown") return `${resolved}일 고점 대비 낙폭 (%)`;
  if (metric === "sma_distance") return `SMA(${resolved}) 이격 (%)`;
  if (metric === "rsi14") return `RSI(${resolved})`;
  if (metric === "max_up_day" || metric === "max_down_day" || metric === "positive_day_rate") return `${resolved}일 ${base}`;
  return base;
}

function passes(value: number | null, filter: ScreenFilter) {
  if (value === null) return false;
  if (filter.op === "gt") return value > filter.value;
  if (filter.op === "lt") return value < filter.value;
  if (filter.op === "gte") return value >= filter.value;
  return value <= filter.value;
}

/**
 * Ranks candidates by one metric after applying every filter. A candidate whose
 * rank metric is undefined is excluded with a reason instead of sorting last,
 * so a short history never masquerades as a weak score.
 */
export function screenUniverse(candidates: ScreenCandidate[], rank: ScreenRank, filters: ScreenFilter[], limit = 15): ScreenResult {
  const requested = [rank, ...filters];
  const columns = [...new Map(requested.map((item) => [columnKey(item.metric, item.period), { key: columnKey(item.metric, item.period), label: columnLabel(item.metric, item.period) }])).values()];
  const excluded: Array<{ symbol: string; reason: string }> = [];
  const rankKey = columnKey(rank.metric, rank.period);
  const rows: ScreenRow[] = [];

  for (const candidate of candidates) {
    const values: Record<string, number | null> = {};
    for (const item of requested) values[columnKey(item.metric, item.period)] = metricValue(candidate.rows, item.metric, item.period);
    const rankValue = values[rankKey];
    if (rankValue === null || rankValue === undefined) {
      excluded.push({ symbol: candidate.symbol, reason: `${columnLabel(rank.metric, rank.period)} 계산에 필요한 거래일이 부족합니다 (${candidate.rows.length}일).` });
      continue;
    }
    const failed = filters.find((filter) => !passes(values[columnKey(filter.metric, filter.period)], filter));
    if (failed) {
      excluded.push({ symbol: candidate.symbol, reason: `필터 미충족: ${columnLabel(failed.metric, failed.period)} ${failed.op} ${failed.value} (실제 ${values[columnKey(failed.metric, failed.period)] ?? "—"})` });
      continue;
    }
    rows.push({ symbol: candidate.symbol, name: candidate.name, latestDate: candidate.rows.at(-1)!.date, close: round(candidate.rows.at(-1)!.close, 4)!, values, rankValue });
  }

  rows.sort((left, right) => rank.direction === "asc" ? left.rankValue - right.rankValue : right.rankValue - left.rankValue);
  return { rankLabel: columnLabel(rank.metric, rank.period), columns, rows: rows.slice(0, Math.max(1, limit)), excluded };
}

export type PooledCondition = { metric: ScreenMetric; period?: number; op: "gt" | "lt"; value: number };

export type PooledStats = {
  samples: number;
  positiveRatePct: number | null;
  averagePct: number | null;
  medianPct: number | null;
  stdDevPct: number | null;
  bestPct: number | null;
  worstPct: number | null;
};

export type PooledStudy = {
  condition: string;
  horizon: number;
  conditional: PooledStats;
  baseline: PooledStats;
  edge: { averageDiffPct: number | null; positiveRateDiffPct: number | null; tStat: number | null };
  perSymbol: Array<{ symbol: string; samples: number; averagePct: number | null; positiveRatePct: number | null }>;
  distribution: Array<{ from: number; to: number; count: number }>;
  symbolsWithSamples: number;
  symbolsScanned: number;
};

function summarize(values: number[]): PooledStats {
  return {
    samples: values.length,
    positiveRatePct: values.length ? round((values.filter((value) => value > 0).length / values.length) * 100, 1) : null,
    averagePct: round(mean(values)),
    medianPct: round(median(values)),
    stdDevPct: round(standardDeviation(values)),
    bestPct: values.length ? round(Math.max(...values)) : null,
    worstPct: values.length ? round(Math.min(...values)) : null,
  };
}

/**
 * The metric series evaluated at every bar, so a condition can be tested
 * historically rather than only at the latest bar like `metricValue` does.
 */
function metricSeries(rows: Bar[], metric: ScreenMetric, period?: number): Array<number | null> {
  const length = Math.max(2, Math.round(period ?? defaultPeriod(metric)));
  const closes = rows.map((row) => row.close);
  switch (metric) {
    case "rsi14": return rsi(closes, length);
    case "drawdown": return drawdownSeries(closes);
    case "close": return closes;
    case "return": return closes.map((close, index) => index >= length ? round((close / closes[index - length] - 1) * 100) : null);
    case "gap": return rows.map((row, index) => index ? round((row.open / rows[index - 1].close - 1) * 100) : null);
    case "range": return rows.map((row) => row.open ? round(((row.high - row.low) / row.open) * 100) : null);
    case "sma_distance": {
      const average = sma(closes, length);
      return closes.map((close, index) => average[index] ? round((close / average[index]! - 1) * 100) : null);
    }
    case "volume_ratio": {
      const average = sma(rows.map((row) => row.volume), length);
      return rows.map((row, index) => index && average[index - 1] ? round(row.volume / average[index - 1]!, 2) : null);
    }
    case "volatility": {
      const returns = closes.map((close, index) => index ? close / closes[index - 1] - 1 : null);
      return closes.map((_, index) => {
        if (index < length) return null;
        const window = returns.slice(index - length + 1, index + 1).filter((value): value is number => value !== null);
        return round(annualizedVolatility(window));
      });
    }
    default: return closes.map(() => null);
  }
}

/**
 * Pools the forward returns that follow a condition across every symbol in a
 * universe, against the unconditional forward return of the same bars. Pooling
 * is what makes a rare per-symbol pattern testable: 3 occurrences on one ticker
 * prove nothing, 120 across 40 tickers are worth reading.
 *
 * The t-statistic is Welch's on the two means. Overlapping windows make the
 * effective sample smaller than `samples`, so it is a screening signal, not a
 * publishable p-value — callers should say so.
 */
export function pooledConditionalStudy(candidates: ScreenCandidate[], condition: PooledCondition, horizon: number, conditionLabel: string): PooledStudy {
  const forward: number[] = [];
  const baseline: number[] = [];
  const perSymbol: PooledStudy["perSymbol"] = [];
  const steps = Math.max(1, Math.round(horizon));

  for (const candidate of candidates) {
    const rows = candidate.rows;
    if (rows.length <= steps + 2) continue;
    const series = metricSeries(rows, condition.metric, condition.period);
    const hits: number[] = [];
    for (let index = 1; index < rows.length - steps; index += 1) {
      const value = series[index];
      const move = round((rows[index + steps].close / rows[index].close - 1) * 100)!;
      baseline.push(move);
      if (value === null || value === undefined) continue;
      if (condition.op === "gt" ? value > condition.value : value < condition.value) hits.push(move);
    }
    if (hits.length) {
      forward.push(...hits);
      perSymbol.push({ symbol: candidate.symbol, samples: hits.length, averagePct: round(mean(hits)), positiveRatePct: round((hits.filter((value) => value > 0).length / hits.length) * 100, 1) });
    }
  }

  const conditional = summarize(forward);
  const unconditional = summarize(baseline);
  const conditionalSd = standardDeviation(forward);
  const baselineSd = standardDeviation(baseline);
  const tStat = forward.length > 1 && baseline.length > 1 && conditionalSd !== null && baselineSd !== null
    ? round((mean(forward)! - mean(baseline)!) / Math.sqrt((conditionalSd ** 2) / forward.length + (baselineSd ** 2) / baseline.length), 2)
    : null;

  perSymbol.sort((left, right) => (right.averagePct ?? 0) - (left.averagePct ?? 0));
  return {
    condition: conditionLabel,
    horizon: steps,
    conditional,
    baseline: unconditional,
    edge: {
      averageDiffPct: conditional.averagePct !== null && unconditional.averagePct !== null ? round(conditional.averagePct - unconditional.averagePct) : null,
      positiveRateDiffPct: conditional.positiveRatePct !== null && unconditional.positiveRatePct !== null ? round(conditional.positiveRatePct - unconditional.positiveRatePct, 1) : null,
      tStat,
    },
    perSymbol,
    distribution: histogram(forward, 9),
    symbolsWithSamples: perSymbol.length,
    symbolsScanned: candidates.length,
  };
}

export type SweepCell = {
  threshold: number;
  horizon: number;
  samples: number;
  conditionalAvgPct: number | null;
  baselineAvgPct: number | null;
  edgePct: number | null;
  positiveRatePct: number | null;
  positiveRateDiffPct: number | null;
};

export type SweepResult = {
  metric: ScreenMetric;
  op: "gt" | "lt";
  period?: number;
  thresholds: number[];
  horizons: number[];
  cells: SweepCell[];
  robustness: {
    totalCells: number;
    cellsWithSamples: number;
    positiveEdgeCells: number;
    positiveEdgeRatePct: number | null;
    medianEdgePct: number | null;
    minEdgePct: number | null;
    maxEdgePct: number | null;
    signConsistent: boolean;
    strengthensWithExtremity: boolean | null;
  };
  symbolsScanned: number;
  symbolsWithSamples: number;
};

/**
 * Runs one condition across a grid of thresholds x horizons.
 *
 * A single cell ("RSI<30 gives +0.7% over 5 days") is exactly the shape a
 * cherry-picked result takes, and nothing in one run separates it from a real
 * effect. The grid shows the whole surface instead: a genuine effect survives
 * neighbouring thresholds and horizons and usually strengthens as the condition
 * gets more extreme, while a lucky cell sits alone among noise.
 *
 * Bars are walked once per symbol - the metric series and each horizon's forward
 * returns are computed a single time and reused across every threshold.
 */
export function sweepConditions(
  candidates: ScreenCandidate[],
  metric: ScreenMetric,
  op: "gt" | "lt",
  thresholds: number[],
  horizons: number[],
  period?: number,
): SweepResult {
  const sortedThresholds = [...new Set(thresholds)].sort((left, right) => left - right);
  const sortedHorizons = [...new Set(horizons.map((value) => Math.max(1, Math.round(value))))].sort((left, right) => left - right);
  const hits = new Map<string, number[]>();
  const baselines = new Map<number, number[]>();
  const symbolsWith = new Set<string>();
  for (const horizon of sortedHorizons) baselines.set(horizon, []);
  for (const threshold of sortedThresholds) for (const horizon of sortedHorizons) hits.set(`${threshold} ${horizon}`, []);

  for (const candidate of candidates) {
    const rows = candidate.rows;
    const series = metricSeries(rows, metric, period);
    for (const horizon of sortedHorizons) {
      if (rows.length <= horizon + 2) continue;
      const baseline = baselines.get(horizon)!;
      for (let index = 1; index < rows.length - horizon; index += 1) {
        const move = round((rows[index + horizon].close / rows[index].close - 1) * 100)!;
        baseline.push(move);
        const value = series[index];
        if (value === null || value === undefined) continue;
        for (const threshold of sortedThresholds) {
          if (op === "gt" ? value > threshold : value < threshold) {
            hits.get(`${threshold} ${horizon}`)!.push(move);
            symbolsWith.add(candidate.symbol);
          }
        }
      }
    }
  }

  const cells: SweepCell[] = [];
  for (const threshold of sortedThresholds) {
    for (const horizon of sortedHorizons) {
      const values = hits.get(`${threshold} ${horizon}`)!;
      const baseline = baselines.get(horizon)!;
      const conditionalAvg = round(mean(values));
      const baselineAvg = round(mean(baseline));
      const positiveRate = values.length ? round((values.filter((value) => value > 0).length / values.length) * 100, 1) : null;
      const baselineRate = baseline.length ? round((baseline.filter((value) => value > 0).length / baseline.length) * 100, 1) : null;
      cells.push({
        threshold, horizon, samples: values.length,
        conditionalAvgPct: conditionalAvg, baselineAvgPct: baselineAvg,
        edgePct: conditionalAvg !== null && baselineAvg !== null ? round(conditionalAvg - baselineAvg) : null,
        positiveRatePct: positiveRate,
        positiveRateDiffPct: positiveRate !== null && baselineRate !== null ? round(positiveRate - baselineRate, 1) : null,
      });
    }
  }

  const scored = cells.filter((cell) => cell.samples > 0 && cell.edgePct !== null);
  const edges = scored.map((cell) => cell.edgePct!);
  const positive = scored.filter((cell) => cell.edgePct! > 0);
  // "More extreme" means a larger threshold for `gt` and a smaller one for `lt`;
  // either way the edge should grow as the condition gets rarer if it is real.
  const midHorizon = sortedHorizons[Math.floor(sortedHorizons.length / 2)];
  const row = scored.filter((cell) => cell.horizon === midHorizon).sort((left, right) => op === "gt" ? left.threshold - right.threshold : right.threshold - left.threshold);
  const strengthens = row.length < 3 ? null : row.every((cell, index) => index === 0 || cell.edgePct! >= row[index - 1].edgePct! - 0.05);

  return {
    metric, op, period, thresholds: sortedThresholds, horizons: sortedHorizons, cells,
    robustness: {
      totalCells: cells.length,
      cellsWithSamples: scored.length,
      positiveEdgeCells: positive.length,
      positiveEdgeRatePct: scored.length ? round((positive.length / scored.length) * 100, 1) : null,
      medianEdgePct: round(median(edges)),
      minEdgePct: edges.length ? round(Math.min(...edges)) : null,
      maxEdgePct: edges.length ? round(Math.max(...edges)) : null,
      signConsistent: scored.length > 1 && (positive.length === scored.length || positive.length === 0),
      strengthensWithExtremity: strengthens,
    },
    symbolsScanned: candidates.length,
    symbolsWithSamples: symbolsWith.size,
  };
}
