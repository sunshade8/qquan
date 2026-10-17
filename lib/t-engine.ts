import { ctFillPrice } from "./market-precision.ts";
import { ctStockSession } from "./t-sessions.ts";
import Decimal from "decimal.js";
import {
  ctSessionPolicy,
  CT_ATR_DEFAULT_LOOKBACK,
  CT_ENGINE_V1,
  ctAtrWindow,
  ctExitAtrConfig,
  ctExitUsesAtr,
  ctIsLevelFeature,
  ctIsManagedExit,
  ctIsPrevDayFeature,
  ctRowsNeeded,
  ctSpecSchema,
  type CTCondition,
  type CTContract,
  type CTManagedExit,
  type CTMarket,
  type CTSpec,
} from "./t-spec.ts";
import { buildHigherSeries, higherWindow, type CTHigherSeries } from "./t-timeframes.ts";
import { buildDayLevels, levelFeature, levelLines, type CTDayLevels } from "./t-levels.ts";
import { easternWallTimeToEpoch } from "./market-clock.ts";
import {
  ctForwardReturnPct,
  ctLegCosts,
  ctSimulateStopExit,
  ctThroughHit,
  ctTickOf,
  ctTickRound,
  emptyExecutionStats,
  type CTExecutionPolicy,
  type CTExecutionStats,
  type CTExitLeg,
} from "./t-limit-execution.ts";

export type CTBar = {
  startMs: number;
  endMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type CTSignal = {
  symbol: string;
  decidedAt: number;
  validUntil: number;
  reference: number;
  patternFrom: number;
  patternLow: number;
  resistance: number;
  support: number;
  stages: Array<{ index: number; at: number; values: number[] }>;
  references?: Array<{ feature: string; price: number; observedAt: number }>;
  /** ATR in price units at the decision time, for managed exits that use `atr` stops, targets or trails. */
  exitAtr?: number;
  swings: Array<{
    kind: "high" | "low";
    at: number;
    confirmedAt: number;
    price: number;
  }>;
};
export type CTTrade = {
  symbol: string;
  signal: CTSignal;
  entryAt: number;
  exitAt: number;
  entry: number;
  exit: number;
  quantity: number;
  fees: number;
  executionCost?: number;
  pnl: number;
  reason: string;
  specHash: string;
  compliant: boolean;
  /** Limit-order contracts only: how the exit filled (a resting target, a marketable/stop-limit sell, the emergency market sell) and the re-prices before it. */
  exitFill?: { leg: CTExitLeg | "marketable"; chases: number };
  /** Managed exits only: how the stop and target stood and moved. Absent for classic exits (results stay byte-identical). */
  management?: CTTradeManagement;
};
export type CTTradeManagement = {
  initialStop: number;
  target: number | null;
  initialRisk: number;
  /** Stop moves in order; `at` is the close of the bar after which the new level applies (from the next bar on). */
  moves: Array<{ at: number; from: number; to: number; source: "breakeven" | "trail" }>;
};
export type CTResult = {
  accountState?: {peakEquity:number;maxDrawdownPct:number};
  engine: string;
  status: "measured" | "no_trades" | "data_error";
  bars: number;
  trades: CTTrade[];
  tradeCount?: number;
  signals: number;
  missed: number;
  costs: number;
  feeCosts?: number;
  spreadSlippageCosts?: number;
  grossReturnPct?: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  payoff: number;
  expectancy: number;
  compliancePct: number;
  daily: Array<{ date: string; equity: number; returnPct: number }>;
  /** Mean of daily net returns (after every cost) over all evaluated days, no-trade days at 0. */
  meanDailyReturnPct?: number;
  positiveDayPct?: number;
  worstDayPct?: number;
  concentrationPct: number;
  maxMonthConcentrationPct: number;
  emptyDays: number;
  diagnostics: string[];
  blocked: Record<string, number>;
  /** Limit-order contracts only: fill rate, adverse selection and how exits filled. */
  execution?: CTExecutionStats;
};
export function validCTBar(b: CTBar) {
  return (
    [b.startMs, b.endMs, b.open, b.high, b.low, b.close, b.volume].every(
      Number.isFinite,
    ) &&
    b.endMs > b.startMs &&
    b.low > 0 &&
    b.volume > 0 &&
    b.high >= Math.max(b.open, b.close) &&
    b.low <= Math.min(b.open, b.close)
  );
}
const barsAtCache = new WeakMap<CTBar[], Map<number, CTBar[]>>();
/**
 * A candidate's bars over one-minute data (free bars, 2026-10-16): epoch-grid groups of `minutes` consecutive,
 * complete minutes — the same rule the local store uses for `minutes: N`, so a bar with a missing minute does not
 * exist. Stock data is regular-session only and 5/15 divide the 09:30 open. Bars that already have the size come back
 * unchanged (one-minute specs, and packages frozen on 5/15/60-minute data). Cached per input array.
 */
export function ctBarsAt(bars: CTBar[], minutes: number): CTBar[] {
  if (!bars.length) return bars;
  const base = (bars[0].endMs - bars[0].startMs) / 60_000;
  if (base === minutes) return bars;
  if (base !== 1) throw new Error(`${base}분 데이터로 ${minutes}분봉을 만들 수 없습니다`);
  let cached = barsAtCache.get(bars);
  if (!cached) barsAtCache.set(bars, (cached = new Map()));
  const hit = cached.get(minutes);
  if (hit) return hit;
  const size = minutes * 60_000,
    out: CTBar[] = [];
  for (let i = 0; i < bars.length; ) {
    const at = Math.floor(bars[i].startMs / size) * size;
    let j = i;
    while (j < bars.length && bars[j].startMs < at + size) j++;
    if (j - i === minutes && bars[i].startMs === at && bars.slice(i, j).every((b, k) => b.startMs === at + k * 60_000 && b.endMs === b.startMs + 60_000)) {
      let high = -Infinity,
        low = Infinity,
        volume = 0;
      for (let k = i; k < j; k++) {
        if (bars[k].high > high) high = bars[k].high;
        if (bars[k].low < low) low = bars[k].low;
        volume += bars[k].volume;
      }
      out.push({ startMs: at, endMs: at + size, open: bars[i].open, close: bars[j - 1].close, high, low, volume });
    }
    i = j;
  }
  cached.set(minutes, out);
  return out;
}
/** Every symbol's bars at `minutes` (see ctBarsAt). */
export function ctDataAt(data: Record<string, CTBar[]>, minutes: number): Record<string, CTBar[]> {
  return Object.fromEntries(Object.entries(data).map(([s, b]) => [s, ctBarsAt(b, minutes)]));
}
export function qualityCT(bars: CTBar[], minutes: number) {
  let invalid = 0,
    duplicate = 0,
    gaps = 0;
  const seen = new Set<number>();
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!validCTBar(b) || b.endMs - b.startMs !== minutes * 60_000) invalid++;
    if (seen.has(b.endMs)) duplicate++;
    seen.add(b.endMs);
    if (i && b.startMs !== bars[i - 1].endMs) gaps++;
  }
  return {
    bars: bars.length,
    invalid,
    duplicate,
    gaps,
    fromMs: bars[0]?.startMs ?? null,
    toMs: bars.at(-1)?.endMs ?? null,
  };
}
export function ctSwings(bars: CTBar[], nowMs: number, width = 2, checkGaps = true) {
  const result: CTSignal["swings"] = [];
  for (let i = width; i + width < bars.length; i++) {
    const confirmedAt = bars[i + width].endMs;
    if (confirmedAt > nowMs) break;
    const neighbors = bars.slice(i - width, i + width + 1);
    // Higher-timeframe windows are chain-checked as a whole (stock bars skip the overnight gap).
    if (checkGaps && neighbors.some((b, j) => j && b.startMs !== neighbors[j - 1].endMs))
      continue;
    if (neighbors.every((b, j) => j === width || b.high < bars[i].high))
      result.push({
        kind: "high",
        at: bars[i].startMs,
        confirmedAt,
        price: bars[i].high,
      });
    if (neighbors.every((b, j) => j === width || b.low > bars[i].low))
      result.push({
        kind: "low",
        at: bars[i].startMs,
        confirmedAt,
        price: bars[i].low,
      });
  }
  return result;
}
function higherBars(bars: CTBar[], factor: number, nowMs: number) {
  if (!bars.length) return [];
  if (factor === 1) return bars.filter((b) => b.endMs <= nowMs);
  const size = (bars[0].endMs - bars[0].startMs) * factor;
  const groups = new Map<number, CTBar[]>();
  for (const b of bars) {
    const at = Math.floor(b.startMs / size) * size;
    const rows = groups.get(at) ?? [];
    rows.push(b);
    groups.set(at, rows);
  }
  return [...groups].flatMap(([at, rows]) =>
    rows.length === factor &&
    at + size <= nowMs &&
    // Members are consecutive base bars; comparing with the higher size rejected every group.
    rows.every((b, i) => b.startMs === at + (i * size) / factor)
      ? [
          {
            startMs: at,
            endMs: at + size,
            open: rows[0].open,
            close: rows.at(-1)!.close,
            high: Math.max(...rows.map((b) => b.high)),
            low: Math.min(...rows.map((b) => b.low)),
            volume: rows.reduce((s, b) => s + b.volume, 0),
          },
        ]
      : [],
  );
}
/**
 * Closed base bars that can form a window of `count` rows of `timeframe` minutes ending `offset`
 * rows back: count + offset complete groups, plus one partial group at each end. Older bars
 * cannot change the result.
 */
function windowTail(timeframe: number, count: number, offset: number, input: CTBar[], nowMs: number) {
  let end = input.length;
  while (end > 0 && input[end - 1].endMs > nowMs) end--;
  const bars = (count - 1 + offset + 3) * timeframe;
  return input.slice(Math.max(0, end - bars), end);
}
/** Completed 60/240/1440-minute series per timeframe for one symbol (ct-pattern-2). */
export type CTHigherSets = Map<number, CTHigherSeries>;
export type CTFeatureContext = { higher?: CTHigherSets; levels?: CTDayLevels; market?: CTMarket; symbol?: string };
/** Higher timeframes (>12 min) a spec reads: condition windows, ATR normalisers, the previous day, the exit's ATR. */
export function ctHigherTimeframes(spec: CTSpec): Set<number> {
  const out = new Set<number>();
  for (const stage of spec.stages)
    for (const c of stage.conditions) {
      if (c.timeframe > 12) out.add(c.timeframe);
      if (c.unit === "atr" && ctAtrWindow(c).timeframe > 12) out.add(ctAtrWindow(c).timeframe);
      if (ctIsPrevDayFeature(c.feature)) out.add(1440);
    }
  const atr = ctExitUsesAtr(spec.exit) ? ctExitAtrConfig(spec.exit) : null;
  if (atr && atr.timeframe > 12) out.add(atr.timeframe);
  return out;
}
/** Series a spec's higher-timeframe conditions need, built once from the symbol's one-minute bars. */
export function ctHigherSets(spec: CTSpec, bars: CTBar[], symbol: string): CTHigherSets {
  const sets: CTHigherSets = new Map();
  for (const timeframe of ctHigherTimeframes(spec)) sets.set(timeframe, buildHigherSeries(bars, timeframe, spec.market, symbol));
  return sets;
}
export const ctNeedsHigher = (spec: CTSpec) => ctHigherTimeframes(spec).size > 0;
export const ctNeedsLevels = (spec: CTSpec) => spec.stages.some((s) => s.conditions.some((c) => ctIsLevelFeature(c.feature)));
/** Day-level arrays a spec's level features need, built once from the symbol's one-minute bars. */
export function ctLevelSets(spec: CTSpec, bars: CTBar[]): CTDayLevels | undefined {
  return ctNeedsLevels(spec) ? buildDayLevels(bars, spec.market) : undefined;
}
function higherRows(condition: CTCondition, input: CTBar[], nowMs: number, ctx?: CTFeatureContext) {
  let series = ctx?.higher?.get(condition.timeframe);
  if (!series) {
    if (!ctx?.market) throw new Error("상위 시간대 조건에는 시장 정보가 필요합니다.");
    series = buildHigherSeries(input, condition.timeframe, ctx.market, ctx.symbol ?? "");
  }
  return higherWindow(series, nowMs, condition.lookback, condition.offset);
}
/**
 * `count` chained complete rows of `timeframe` minutes ending `offset` rows before the last row
 * closed by nowMs, or null when any is missing, invalid or not chained.
 */
function windowRows(timeframe: number, count: number, offset: number, input: CTBar[], nowMs: number, ctx?: CTFeatureContext): CTBar[] | null {
  if (timeframe > 12) {
    let series = ctx?.higher?.get(timeframe);
    if (!series) {
      if (!ctx?.market) throw new Error("상위 시간대 조건에는 시장 정보가 필요합니다.");
      series = buildHigherSeries(input, timeframe, ctx.market, ctx.symbol ?? "");
    }
    const rows = higherWindow(series, nowMs, count - 1, offset);
    return rows && rows.every(validCTBar) ? rows : null;
  }
  const full = higherBars(windowTail(timeframe, count, offset, input, nowMs), timeframe, nowMs);
  const end = full.length - offset;
  const rows = full.slice(Math.max(0, end - count), end);
  if (rows.length !== count || rows.some((b, i) => !validCTBar(b) || (i > 0 && b.startMs !== rows[i - 1].endMs))) return null;
  return rows;
}
/** Mean true range of rows[1..]: `rows.length - 1` bars, each against its predecessor's close. */
function meanTrueRange(rows: CTBar[]) {
  let sum = 0;
  for (let i = 1; i < rows.length; i++) {
    const b = rows[i],
      pc = rows[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  return sum / (rows.length - 1);
}
/** ATR as percent of the last close over `lookback` bars of `timeframe`, at the decision time (offset 0). */
function atrPctAt(timeframe: number, lookback: number, input: CTBar[], nowMs: number, ctx?: CTFeatureContext) {
  const rows = windowRows(timeframe, lookback + 1, 0, input, nowMs, ctx);
  return rows ? (meanTrueRange(rows) / rows.at(-1)!.close) * 100 : null;
}
export function ctFeature(
  condition: CTCondition,
  input: CTBar[],
  nowMs: number,
  ctx?: CTFeatureContext,
): number | null {
  let raw: number | null;
  if (ctIsLevelFeature(condition.feature)) {
    if (!ctx?.market) throw new Error("레벨 피처에는 시장 정보가 필요합니다.");
    const levels = ctx.levels ?? buildDayLevels(input, ctx.market),
      daily = ctIsPrevDayFeature(condition.feature) ? (ctx.higher?.get(1440) ?? buildHigherSeries(input, 1440, ctx.market, ctx.symbol ?? "")) : undefined;
    raw = levelFeature(condition, levels, daily, ctx.market, ctx.symbol ?? "", nowMs);
  } else {
    const rows = windowRows(condition.timeframe, ctRowsNeeded(condition), condition.offset, input, nowMs, ctx);
    raw = rows ? featureFromRows(condition, rows, condition.timeframe <= 12) : null;
  }
  if (raw === null || condition.unit !== "atr") return raw;
  const w = ctAtrWindow(condition),
    atrPct = atrPctAt(w.timeframe, w.rows - 1, input, nowMs, ctx);
  return atrPct !== null && atrPct > 0 ? raw / atrPct : null;
}
/** The feature formulas over the window's chained bars (lookback + 1 for the classic ones). */
function featureFromRows(condition: CTCondition, rows: CTBar[], checkGaps: boolean): number | null {
  const current = rows.at(-1)!,
    prior = rows.slice(0, -1);
  if (condition.feature === "atr_pct") return (meanTrueRange(rows) / current.close) * 100;
  if (condition.feature === "atr_percentile") {
    // The last `lookback` ATR values (atrLookback bars each, as % of that bar's close); the share of the earlier ones at or below the current.
    const period = condition.atrLookback ?? CT_ATR_DEFAULT_LOOKBACK,
      atrs: number[] = [];
    for (let end = rows.length - condition.lookback; end < rows.length; end++)
      atrs.push(meanTrueRange(rows.slice(end - period, end + 1)) / rows[end].close);
    const now = atrs.at(-1)!,
      before = atrs.slice(0, -1);
    return before.filter((a) => a <= now).length / before.length;
  }
  const high = Math.max(...prior.map((b) => b.high)),
    low = Math.min(...prior.map((b) => b.low));
  const avg = (xs: number[]) => xs.reduce((s, n) => s + n, 0) / xs.length;
  switch (condition.feature) {
    case "return_pct":
      return (current.close / prior[0].close - 1) * 100;
    case "sma_distance_pct":
      return (current.close / avg(prior.map((b) => b.close)) - 1) * 100;
    case "range_pct":
      return (high / low - 1) * 100;
    case "volume_ratio":
      return current.volume / avg(prior.map((b) => b.volume));
    case "contraction_ratio": {
      const cut = Math.floor(prior.length / 2);
      return (
        avg(prior.slice(cut).map((b) => (b.high - b.low) / b.close)) /
        Math.max(
          1e-12,
          avg(prior.slice(0, cut).map((b) => (b.high - b.low) / b.close)),
        )
      );
    }
    case "prior_high_distance_pct":
      return (current.close / high - 1) * 100;
    case "prior_low_distance_pct":
      return (current.close / low - 1) * 100;
    case "range_position":
      return (current.close - low) / Math.max(high - low, 1e-12);
    case "swing_high_distance_pct":
    case "swing_low_distance_pct": {
      const kind =
        condition.feature === "swing_high_distance_pct" ? "high" : "low";
      const swing = ctSwings(rows, current.endMs, 2, checkGaps)
        .filter((s) => s.kind === kind)
        .at(-1);
      return swing ? (current.close / swing.price - 1) * 100 : null;
    }
  }
  return null;
}
function ctReference(condition: CTCondition, input: CTBar[], now: number, ctx?: CTFeatureContext) {
  let rows: CTBar[];
  if (condition.timeframe > 12) {
    const window = higherRows(condition, input, now, ctx);
    if (!window) return null;
    rows = window;
  } else {
    const full = higherBars(
        windowTail(condition.timeframe, condition.lookback + 1, condition.offset, input, now),
        condition.timeframe,
        now,
      ),
      end = full.length - condition.offset;
    rows = full.slice(Math.max(0, end - condition.lookback - 1), end);
  }
  const prior = rows.slice(0, -1);
  if (rows.length !== condition.lookback + 1) return null;
  if (condition.feature === "prior_high_distance_pct")
    return Math.max(...prior.map((b) => b.high));
  if (condition.feature === "prior_low_distance_pct")
    return Math.min(...prior.map((b) => b.low));
  if (condition.feature === "sma_distance_pct")
    return prior.reduce((sum, b) => sum + b.close, 0) / prior.length;
  if (condition.feature.startsWith("swing_")) {
    const kind =
      condition.feature === "swing_high_distance_pct" ? "high" : "low";
    return (
      ctSwings(rows, now, 2, condition.timeframe <= 12)
        .filter((s) => s.kind === kind)
        .at(-1)?.price ?? null
    );
  }
  return null;
}
/**
 * Base bars the detector can read: the deepest condition window (plus one higher-bar
 * alignment group), every stage gap, and the 120-bar swing/20-bar reference views.
 * Capped at the historical 1,800 so results match the previous fixed window exactly.
 */
export function ctHistoryBars(spec: CTSpec) {
  // 60/240/1440-minute conditions read their own completed-bar series, not this window.
  const windows = spec.stages.flatMap((s) =>
    s.conditions.flatMap((c) => [
      ...(c.timeframe <= 12 ? [(ctRowsNeeded(c) - 1 + c.offset + 3) * c.timeframe] : []),
      ...(c.unit === "atr" && ctAtrWindow(c).timeframe <= 12 ? [(ctAtrWindow(c).rows + 2) * ctAtrWindow(c).timeframe] : []),
    ]),
  );
  const atr = ctExitUsesAtr(spec.exit) ? ctExitAtrConfig(spec.exit) : null;
  if (atr && atr.timeframe <= 12) windows.push((atr.lookback + 3) * atr.timeframe);
  const need = Math.max(0, ...windows);
  const gaps = spec.stages.reduce((sum, s) => sum + s.maxGapBars, 0);
  return Math.min(1800, Math.max(121, need + gaps + 2));
}
/**
 * Feature values per condition, keyed by the closing time of the bar they were read at.
 * A value depends only on bars closed by then, so a replay can reuse it while later
 * bars rescan earlier stages.
 */
export type CTFeatureCache = Map<CTCondition, Map<number, number | null>>;
/** One causal detector shared by historical replay and the trading runner. No models. */
export function detectCT(
  spec: CTSpec,
  symbol: string,
  input: CTBar[],
  nowMs: number,
  cache?: CTFeatureCache,
  higher?: CTHigherSets,
  levelSet?: CTDayLevels,
): CTSignal | null {
  // Higher-timeframe series and day levels: supplied by a replay, otherwise built from the full input.
  let sets = higher,
    levels = levelSet;
  const ctx = (): CTFeatureContext => ({
    higher: (sets ??= ctNeedsHigher(spec) ? ctHigherSets(spec, input, symbol) : new Map()),
    levels: (levels ??= ctLevelSets(spec, input)),
    market: spec.market,
    symbol,
  });
  const needCtx = ctNeedsHigher(spec) || ctNeedsLevels(spec);
  const feature = (c: CTCondition, bars: CTBar[], at: number) => {
    const compute = () => ctFeature(c, bars, at, needCtx ? ctx() : undefined);
    if (!cache) return compute();
    let byTime = cache.get(c);
    if (!byTime) cache.set(c, (byTime = new Map()));
    let value = byTime.get(at);
    if (value === undefined) byTime.set(at, (value = compute()));
    return value;
  };
  let end = input.length;
  while (end > 0 && input[end - 1].endMs > nowMs) end--;
  // Inputs are time-ordered, so the closed tail is the last window of the trimmed input.
  const bars = input
    .slice(Math.max(0, end - ctHistoryBars(spec)), end)
    .filter((b) => b.endMs <= nowMs);
  const last = bars.at(-1);
  if (!last || !spec.symbols.includes(symbol) || !validCTBar(last)) return null;
  const matches: CTSignal["stages"] = [];
  let cursor = bars.length - 1;
  for (let phase = spec.stages.length - 1; phase >= 0; phase--) {
    const stage = spec.stages[phase];
    const lower =
      phase === spec.stages.length - 1
        ? cursor
        : Math.max(0, cursor - spec.stages[phase + 1].maxGapBars + 1);
    let found = false;
    for (let i = cursor; i >= lower; i--) {
      // Features read only bars closed by bars[i].endMs, so no prefix copy is needed.
      const values = stage.conditions.map((c) =>
        feature(c, bars, bars[i].endMs),
      );
      if (
        values.every(
          (v, j) =>
            v !== null &&
            (stage.conditions[j].op === "gte"
              ? v >= stage.conditions[j].value
              : v <= stage.conditions[j].value),
        )
      ) {
        matches.unshift({
          index: i,
          at: bars[i].endMs,
          values: values as number[],
        });
        cursor = i - 1;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  const pattern = bars.slice(matches[0].index);
  if (pattern.some((b, i) => i && b.startMs !== pattern[i - 1].endMs))
    return null;
  const previous = bars.slice(Math.max(0, bars.length - 21), -1);
  // Managed exits with ATR stops/targets/trails need the ATR at the decision; without it the rule cannot size or exit.
  let exitAtr: number | undefined;
  if (ctExitUsesAtr(spec.exit)) {
    const cfg = ctExitAtrConfig(spec.exit)!,
      rows = windowRows(cfg.timeframe, cfg.lookback + 1, 0, bars, last.endMs, needCtx ? ctx() : undefined);
    if (!rows) return null;
    exitAtr = meanTrueRange(rows);
    if (!(exitAtr > 0)) return null;
  }
  return {
    symbol,
    decidedAt: last.endMs,
    validUntil: last.endMs + spec.minutes * 60_000,
    reference: last.close,
    patternFrom: pattern[0].startMs,
    patternLow: Math.min(...pattern.map((b) => b.low)),
    resistance: Math.max(...previous.map((b) => b.high)),
    support: Math.min(...previous.map((b) => b.low)),
    stages: matches,
    references: matches.flatMap((m, i) =>
      spec.stages[i].conditions.flatMap((c) => {
        if (ctIsLevelFeature(c.feature)) {
          const x = ctx();
          return levelLines(c, x.levels!, ctIsPrevDayFeature(c.feature) ? x.higher?.get(1440) : undefined, spec.market, symbol, m.at).map((l) => ({
            feature: l.feature,
            price: l.price,
            observedAt: m.at,
          }));
        }
        if (c.feature === "atr_pct" || c.feature === "atr_percentile") return [];
        const price = ctReference(c, bars.slice(0, m.index + 1), m.at, c.timeframe > 12 ? ctx() : undefined);
        return price === null
          ? []
          : [{ feature: c.feature, price, observedAt: m.at }];
      }),
    ),
    ...(exitAtr !== undefined ? { exitAtr } : {}),
    swings: ctSwings(bars.slice(-120), last.endMs),
  };
}
export function ctExit(
  spec: CTSpec,
  signal: CTSignal,
  entry: number,
  entryAt: number,
  bar: CTBar,
) {
  // Classic exits only; a managed exit has state and goes through ctExitStep.
  if (ctIsManagedExit(spec.exit)) throw new Error("ctExit은 고정 손절·목표 구조 전용입니다. 관리형 청산은 ctExitStep을 사용하세요.");
  const exit = spec.exit;
  const stop = Math.max(
    entry * (1 - exit.stopPct / 100),
    exit.invalidation === "last_stage_low" ? signal.patternLow : 0,
  );
  const target = entry * (1 + exit.targetPct / 100);
  // A gap through the stop fills at the adverse open. Ambiguous bars are stop-first.
  if (bar.low <= stop)
    return { price: Math.min(stop, bar.open), reason: "stop" };
  if (bar.high >= target)
    return { price: bar.open >= target ? bar.open : target, reason: "target" };
  if (bar.endMs - entryAt >= exit.maxHoldBars * spec.minutes * 60_000)
    return { price: bar.close, reason: "time" };
  return null;
}
/* ------------------------------------------------------------ exit management */

/**
 * The exit as one normalised plan, whichever shape the spec uses. Classic exits (stopPct/targetPct)
 * become a pct stop + pct target and keep their historical reason names; managed exits (ct-pattern-3)
 * carry breakeven / trail / time stop. Everything that exits a position goes through this plan.
 */
export type CTExitPlan = {
  managed: boolean;
  stop: CTManagedExit["stop"];
  /** Classic `invalidation: last_stage_low`: the stop is never below the pattern low. */
  invalidationLow: boolean;
  target: CTManagedExit["target"] | null;
  breakeven: CTManagedExit["breakeven"] | null;
  trail: CTManagedExit["trail"] | null;
  timeStop: CTManagedExit["timeStop"] | null;
  maxHoldBars: number;
};
export function ctExitPlan(spec: Pick<CTSpec, "exit">): CTExitPlan {
  const e = spec.exit;
  if (!ctIsManagedExit(e))
    return {
      managed: false,
      stop: { type: "pct", value: e.stopPct },
      invalidationLow: e.invalidation === "last_stage_low",
      target: { type: "pct", value: e.targetPct },
      breakeven: null,
      trail: null,
      timeStop: null,
      maxHoldBars: e.maxHoldBars,
    };
  return {
    managed: true,
    stop: e.stop,
    invalidationLow: false,
    target: e.target ?? null,
    breakeven: e.breakeven ?? null,
    trail: e.trail ?? null,
    timeStop: e.timeStop ?? null,
    maxHoldBars: e.maxHoldBars,
  };
}
/** What an open position remembers between bars. Plain numbers: it is stored with live trades and rebuilt from bars. */
export type CTPosition = {
  entry: number;
  entryAt: number;
  initialStop: number;
  /** entry − initial stop, price units, always > 0. */
  initialRisk: number;
  stopLevel: number;
  stopSource: "initial" | "breakeven" | "trail";
  targetLevel: number | null;
  /** Highest high of the bars already processed (the current bar is added after it is judged). */
  highestHigh: number;
  breakevenArmed: boolean;
  trailArmed: boolean;
  /** Bars processed so far (the entry bar is the first). */
  bars: number;
  /** Lows of the last five bars and the latest confirmed swing low since entry (swing_low trails only). */
  lows: number[];
  swingLow: number | null;
  moves: CTTradeManagement["moves"];
};
/** The stop distance as percent of the entry: what sizing risks per trade. */
export const ctRiskPct = (position: Pick<CTPosition, "entry" | "initialRisk">) => (position.initialRisk / position.entry) * 100;
const MAX_STOP_PCT = 15;
/**
 * The position at the fill, or null when the rule has no valid stop for this signal (a pattern/swing
 * low at or above the entry, no confirmed swing, no ATR, a stop farther than 15%). `stopScale` widens
 * or narrows the initial stop distance — the gate's ±10% stop stress.
 */
export function ctOpenPosition(
  spec: Pick<CTSpec, "exit">,
  signal: CTSignal,
  entry: number,
  entryAt: number,
  options: { stopScale?: number } = {},
): CTPosition | null {
  const plan = ctExitPlan(spec);
  let stop: number | null;
  switch (plan.stop.type) {
    case "pct":
      stop = entry * (1 - plan.stop.value / 100);
      break;
    case "atr":
      stop = signal.exitAtr ? entry - plan.stop.value * signal.exitAtr : null;
      break;
    case "pattern_low":
      stop = signal.patternLow * (1 - plan.stop.value / 100);
      break;
    case "swing_low": {
      const swing = signal.swings.filter((s) => s.kind === "low").at(-1);
      stop = swing ? swing.price * (1 - plan.stop.value / 100) : null;
      break;
    }
  }
  if (stop === null || !Number.isFinite(stop)) return null;
  if (plan.invalidationLow) stop = Math.max(stop, signal.patternLow);
  if (options.stopScale !== undefined && options.stopScale !== 1) stop = entry - (entry - stop) * options.stopScale;
  const initialRisk = entry - stop;
  if (!(initialRisk > 0) || (plan.managed && (initialRisk / entry) * 100 > MAX_STOP_PCT + 1e-9)) return null;
  let targetLevel: number | null = null;
  if (plan.target) {
    if (plan.target.type === "pct") targetLevel = entry * (1 + plan.target.value / 100);
    else if (plan.target.type === "r") targetLevel = entry + plan.target.value * initialRisk;
    else if (signal.exitAtr) targetLevel = entry + plan.target.value * signal.exitAtr;
    else return null;
  }
  return {
    entry,
    entryAt,
    initialStop: stop,
    initialRisk,
    stopLevel: stop,
    stopSource: "initial",
    targetLevel,
    highestHigh: entry,
    breakevenArmed: false,
    trailArmed: false,
    bars: 0,
    lows: [],
    swingLow: null,
    moves: [],
  };
}
export type CTExitHit = { price: number; reason: string };
/**
 * Judge one bar for an open position and advance its state: THE exit function — replayCT, the
 * paper/live runner and the design tools all call it, so a backtest and a live trade cannot
 * disagree about the stop.
 *
 * Inside the bar the order is conservative: the stop that stood before the bar is checked first
 * (a gap through it fills at the open), then the target, then the time stop, the holding limit and
 * the day-end exit the caller passes as `forced`. Only when the position survives the bar are
 * highestHigh, breakeven and the trail updated from that bar's high — so a raised stop applies
 * from the NEXT bar and one bar can never both raise the stop and be stopped by it.
 * Pure: the input position is not modified.
 */
export function ctExitStep(
  spec: Pick<CTSpec, "exit" | "minutes">,
  signal: CTSignal,
  position: CTPosition,
  bar: CTBar,
  forced: CTExitHit | null = null,
  /**
   * Limit-order contracts: the target is a resting sell limit, so it fills only when the bar trades through it (not in the
   * bar the entry filled in) and at its own price, never at a better open. Everything else is unchanged.
   */
  limit: { tick: number; penetrationTicks: number; fillBar: boolean } | null = null,
): { position: CTPosition; exit: CTExitHit | null } {
  const plan = ctExitPlan(spec),
    p = position;
  if (bar.low <= p.stopLevel)
    return { position: p, exit: { price: Math.min(p.stopLevel, bar.open), reason: p.stopSource === "initial" ? "stop" : p.stopSource } };
  if (limit) {
    if (p.targetLevel !== null && !limit.fillBar && ctThroughHit("sell", p.targetLevel, bar, limit.tick, limit.penetrationTicks))
      return { position: p, exit: { price: ctTickRound(p.targetLevel, limit.tick, "up"), reason: "target" } };
  } else if (p.targetLevel !== null && bar.high >= p.targetLevel)
    return { position: p, exit: { price: bar.open >= p.targetLevel ? bar.open : p.targetLevel, reason: "target" } };
  const barNo = p.bars + 1;
  if (plan.timeStop && barNo === plan.timeStop.bars && (bar.close - p.entry) / p.initialRisk < plan.timeStop.minR)
    return { position: p, exit: { price: bar.close, reason: "time_stop" } };
  if (bar.endMs - p.entryAt >= plan.maxHoldBars * spec.minutes * 60_000)
    return { position: p, exit: { price: bar.close, reason: plan.managed ? "max_hold" : "time" } };
  if (forced) return { position: p, exit: forced };
  const highestHigh = Math.max(p.highestHigh, bar.high),
    rMax = (highestHigh - p.entry) / p.initialRisk;
  const next: CTPosition = { ...p, highestHigh, bars: barNo };
  const lift = (level: number, source: "breakeven" | "trail") => {
    if (!(level > next.stopLevel)) return;
    next.moves = [...next.moves, { at: bar.endMs, from: next.stopLevel, to: level, source }];
    next.stopLevel = level;
    next.stopSource = source;
  };
  if (plan.breakeven && !next.breakevenArmed && rMax >= plan.breakeven.triggerR) {
    next.breakevenArmed = true;
    lift(p.entry * (1 + (plan.breakeven.offsetPct ?? 0) / 100), "breakeven");
  }
  if (plan.trail) {
    if (plan.trail.type === "swing_low") {
      next.lows = [...p.lows, bar.low].slice(-5);
      // A swing low is confirmed two bars later: the middle of five strictly lowest.
      if (next.lows.length === 5 && next.lows.every((l, i) => i === 2 || l > next.lows[2])) next.swingLow = next.lows[2];
    }
    if (!next.trailArmed && rMax >= plan.trail.activateR) next.trailArmed = true;
    if (next.trailArmed) {
      const t = plan.trail;
      const level =
        t.type === "pct"
          ? highestHigh * (1 - t.value / 100)
          : t.type === "atr"
            ? signal.exitAtr
              ? highestHigh - t.value * signal.exitAtr
              : null
            : next.swingLow !== null
              ? next.swingLow * (1 - t.value / 100)
              : null;
      if (level !== null) lift(level, "trail");
    }
  }
  return { position: next, exit: null };
}
/**
 * A position rebuilt from nothing but the rule, the signal, the fill and the bars since entry —
 * what a restarted runner can do instead of trusting a stored state. Equal to stepping live.
 */
export function ctRebuildPosition(
  spec: Pick<CTSpec, "exit" | "minutes">,
  signal: CTSignal,
  entry: number,
  entryAt: number,
  bars: CTBar[],
  options: { stopScale?: number } = {},
) {
  let position = ctOpenPosition(spec, signal, entry, entryAt, options);
  if (!position) return { position: null, exit: null as CTExitHit | null, exitBar: null as CTBar | null };
  for (const bar of bars) {
    const step = ctExitStep(spec, signal, position, bar);
    position = step.position;
    if (step.exit) return { position, exit: step.exit, exitBar: bar };
  }
  return { position, exit: null as CTExitHit | null, exitBar: null as CTBar | null };
}
export function ctQuantity(
  spec: CTSpec,
  contract: CTContract,
  cash: number,
  equity: number,
  price: number,
  volume: number,
  /** Stop distance, percent of the entry, for managed exits (classic exits use spec.exit.stopPct). */
  stopPct?: number,
) {
  const risk = stopPct ?? (ctIsManagedExit(spec.exit) ? NaN : spec.exit.stopPct);
  if (
    ![cash, equity, price, volume].every(Number.isFinite) ||
    !(risk > 0) ||
    cash <= 0 ||
    equity <= 0 ||
    price <= 0 ||
    volume <= 0
  )
    return 0;
  const quantity = Decimal.min(
    new Decimal(cash)
      .mul(0.99)
      .div(
        new Decimal(price).mul(
          new Decimal(1).plus(new Decimal(contract.costs.feePct).div(100)),
        ),
      ),
    new Decimal(equity).mul(spec.sizing.allocationPct).div(100).div(price),
    new Decimal(equity)
      .mul(spec.sizing.riskPct)
      .div(risk)
      .div(price),
    new Decimal(volume).mul(spec.sizing.participationPct).div(100),
  ).toDecimalPlaces(contract.costs.quantityDecimals, Decimal.ROUND_DOWN);
  return quantity.mul(price).gte(contract.costs.minimumOrder)
    ? quantity.toNumber()
    : 0;
}
const dateFormats = {
  crypto: new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }),
  stock: new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }),
};
const stockClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function ctDate(ms: number, market: CTContract["market"], timezone?:string) {
  if(timezone === "UTC") return new Date(ms).toISOString().slice(0,10);
  return dateFormats[market].format(new Date(ms));
}
/** True when a bar of `barMinutes` closing at `ms` is the session's last tradable bar (it closes one bar before the bell). */
export function ctSessionClosing(ms: number, barMinutes = 1) {
  const session = ctStockSession(ctDate(ms, "stock"));
  if (!session) return true;
  const [hour, minute] = session.close.split(":").map(Number),
    time = stockClock.format(new Date(ms)).split(":").map(Number);
  return time[0] * 60 + time[1] >= hour * 60 + minute - barMinutes;
}
const DAY_MS = 86_400_000;
/** True when a bar of `barMinutes` closing at `ms` is the last tradable bar of its UTC day (one bar before 00:00 UTC = 09:00 KST). */
export function ctCryptoDayClosing(ms: number, barMinutes = 1) {
  return (((ms % DAY_MS) + DAY_MS) % DAY_MS) >= DAY_MS - barMinutes * 60_000;
}
/**
 * Whether the trading day ends with the bar closing at `ms`: the one rule backtest, paper and
 * live share. Stocks always close at the NYSE session end. Crypto closes at 00:00 UTC only for
 * ct-pattern-2 — ct-pattern-1 crypto is continuous and results saved under it must not move.
 * ct-pattern-2+ skips the day's final bar whatever its size (5/15/60-minute research, 2026-10-16);
 * ct-pattern-1 stock packages keep the historical one-minute rule.
 */
export function ctDayClosing(spec: Pick<CTSpec, "engine"> & Partial<Pick<CTSpec, "minutes">>, market: CTMarket, ms: number) {
  const bar = spec.engine === CT_ENGINE_V1 ? 1 : (spec.minutes ?? 1);
  if (market === "stock") return ctSessionClosing(ms, bar);
  return spec.engine !== CT_ENGINE_V1 && ctCryptoDayClosing(ms, bar);
}
/** End of the trading day containing the bar that closes at `ms`; null outside a session. */
export function ctDayEndMs(market: CTMarket, ms: number): number | null {
  if (market === "crypto") return (Math.floor((ms - 1) / DAY_MS) + 1) * DAY_MS;
  const date = ctDate(ms - 1, "stock");
  const session = ctStockSession(date);
  return session ? easternWallTimeToEpoch(date, session.close) : null;
}
/** Forced exit on the day's last bar: at that bar's close. Stocks keep the historical reason "session". */
export function ctForcedExit(spec: Pick<CTSpec, "engine"> & Partial<Pick<CTSpec, "minutes">>, market: CTMarket, bar: CTBar) {
  return ctDayClosing(spec, market, bar.endMs)
    ? { price: bar.close, reason: market === "stock" ? "session" : "day_end" }
    : null;
}
/** Start of the trading day containing the bar that closes at `ms` (UTC midnight, or the regular-session open); null outside a session. */
export function ctDayStartMs(market: CTMarket, ms: number): number | null {
  if (market === "crypto") return Math.floor((ms - 1) / DAY_MS) * DAY_MS;
  const date = ctDate(ms - 1, "stock"),
    session = ctStockSession(date);
  return session ? easternWallTimeToEpoch(date, session.open) : null;
}
/**
 * Whether the decision at `ms` (the signal bar's close) lies inside one of the entry windows:
 * minutes elapsed since the day start, fromMinute and toMinute both included. {0, 30} = the first
 * 30 minutes: decisions closing at minute 1 … 30.
 */
export function ctInEntryWindow(windows: Array<{ fromMinute: number; toMinute: number }>, market: CTMarket, ms: number) {
  const start = ctDayStartMs(market, ms);
  if (start === null) return false;
  const minute = (ms - start) / 60_000;
  return windows.some((w) => minute >= w.fromMinute && minute <= w.toMinute);
}
/**
 * New entries are refused on the day's last bar and, with noEntryBeforeDayEndMinutes, for that
 * many minutes before the day ends. `ms` is the decision time (the signal bar's close). ct-pattern-1
 * crypto has no day end, so nothing changes there.
 */
export function ctEntryBlocked(spec: Pick<CTSpec, "engine" | "entry"> & Partial<Pick<CTSpec, "minutes">>, market: CTMarket, ms: number, ignoreWindows = false) {
  if (ctDayClosing(spec, market, ms)) return true;
  if (!ignoreWindows && spec.entry.entryWindows?.length && !ctInEntryWindow(spec.entry.entryWindows, market, ms)) return true;
  const minutes = spec.entry.noEntryBeforeDayEndMinutes ?? 0;
  if (!minutes) return false;
  const end = ctDayEndMs(market, ms);
  return end !== null && ms >= end - minutes * 60_000;
}
/** Price impact per side (half spread + slippage), percent. replayCT fills with it. */
export function ctImpactPct(contract: Pick<CTContract, "costs">, multiplier = 1) {
  return (contract.costs.spreadPct / 2 + contract.costs.slippagePct) * multiplier;
}
/**
 * Net return of one long round trip after every contract cost, by the replay's own fill
 * and fee formulas (before quantity/tick rounding): buy at open × (1 + impact) plus fee,
 * sell at exit × (1 − impact) minus fee and sell tax.
 */
export function ctNetTradePct(
  contract: Pick<CTContract, "costs"> & Partial<Pick<CTContract, "execution">>,
  entryOpen: number,
  exitPrice: number,
  multiplier = 1,
) {
  if (contract.execution) {
    // Limit contract (conservative screen): the entry is a maker fill at its own price, every exit is priced as a taker.
    const impact = ctImpactPct(contract, multiplier) / 100,
      buyFee = (contract.execution.makerFeePct * multiplier) / 100,
      sellFee = ((contract.execution.takerFeePct + contract.costs.sellTaxPct) * multiplier) / 100;
    return ((exitPrice * (1 - impact) * (1 - sellFee)) / (entryOpen * (1 + buyFee)) - 1) * 100;
  }
  const impact = ctImpactPct(contract, multiplier) / 100,
    buyFee = (contract.costs.feePct * multiplier) / 100,
    sellFee = ((contract.costs.feePct + contract.costs.sellTaxPct) * multiplier) / 100;
  return ((exitPrice * (1 - impact) * (1 - sellFee)) / (entryOpen * (1 + impact) * (1 + buyFee)) - 1) * 100;
}
/** Round-trip cost with no price move, percent of the capital put in. */
export function ctRoundTripCostPct(contract: Pick<CTContract, "costs"> & Partial<Pick<CTContract, "execution">>, multiplier = 1) {
  return -ctNetTradePct(contract, 100, 100, multiplier);
}
/** The stop/target story of a managed trade, for records and charts. */
export function ctManagement(position: CTPosition): CTTradeManagement {
  return { initialStop: position.initialStop, target: position.targetLevel, initialRisk: position.initialRisk, moves: position.moves };
}
export function replayCT(
  specInput: CTSpec,
  data: Record<string, CTBar[]>,
  contract: CTContract,
  fromMs: number,
  toMs: number,
  hash: string,
  options: {
    costMultiplier?: number;
    delayBars?: number;
    deadline?: number;
    /** Scales the initial stop distance (the gate's ±10% stop stress for managed exits). */
    stopScale?: number;
    accountState?: {peakEquity:number;maxDrawdownPct:number};
    policy?: { observe:(at:number)=>void; signal:(symbol:string,at:number)=>CTSignal|null; exit:()=>boolean };
  } = {},
): CTResult {
  const spec = ctSpecSchema.parse(specInput),
    plan = ctExitPlan(spec),
    multiplier = options.costMultiplier ?? 1;
  // Limit-order contracts (lib/t-limit-execution.ts) simulate stop chases on the contract's one-minute rows.
  const limitPolicy: CTExecutionPolicy | null = contract.execution?.mode === "limit" ? contract.execution : null,
    oneMinute = data;
  // Free bars: the candidate trades its own bar over the contract's one-minute data.
  data = ctDataAt(data, spec.minutes);
  const result: CTResult = {
    engine: spec.engine,
    status: "no_trades",
    bars: 0,
    trades: [],
    signals: 0,
    missed: 0,
    costs: 0,
    netReturnPct: 0,
    maxDrawdownPct: options.accountState?.maxDrawdownPct ?? 0,
    winRatePct: 0,
    payoff: 0,
    expectancy: 0,
    compliancePct: 100,
    daily: [],
    concentrationPct: 0,
    maxMonthConcentrationPct: 0,
    emptyDays: 0,
    diagnostics: [],
    blocked: {},
  };
  if (
    Object.values(data).some(
      (b) =>
        qualityCT(b, spec.minutes).invalid ||
        qualityCT(b, spec.minutes).duplicate,
    )
  ) {
    result.status = "data_error";
    result.diagnostics.push("비정상·중복 데이터");
    return result;
  }
  const history = ctHistoryBars(spec);
  let cash = contract.capital,
    peak = options.accountState?.peakEquity ?? cash,
    lastExit = -Infinity,
    day = "",
    dayStart = cash;
  let held: {
    symbol: string;
    signal: CTSignal;
    entry: number;
    at: number;
    quantity: number;
    fee: number;
    entryImpact: number;
    checkedThrough: number;
    position: CTPosition;
    /** Limit contracts: the stop's sell order is still working (chased) until `fill.fillEndMs`. */
    exiting?: { fill: ExitFill; hit: CTExitHit };
  } | null = null;
  let pending: { symbol: string; signal: CTSignal; index: number; limit?: number; forward?: number } | null =
    null;
  type ExitFill = { price: number; leg: CTExitLeg | "marketable"; chases: number; fillEndMs: number };
  const stats = emptyExecutionStats(),
    filledForward: number[] = [],
    unfilledForward: number[] = [];
  const forwardBars = Math.min(60, spec.exit.maxHoldBars);
  const times = [
    ...new Set(
      spec.symbols.flatMap((s) =>
        (data[s] ?? [])
          .filter((b) => b.endMs > fromMs && b.endMs <= toMs)
          .map((b) => b.endMs),
      ),
    ),
  ].sort((a, b) => a - b);
  const indexes = Object.fromEntries(
    spec.symbols.map((s) => [
      s,
      new Map((data[s] ?? []).map((b, i) => [b.endMs, i])),
    ]),
  );
  const featureCaches = Object.fromEntries(
    spec.symbols.map((s) => [s, new Map() as CTFeatureCache]),
  );
  // Completed higher-timeframe bars are built once, from this replay's own range only: nothing
  // before fromMs (purged split) and nothing after toMs.
  const higherSets = Object.fromEntries(
    spec.symbols.map((s) => [
      s,
      ctNeedsHigher(spec)
        ? ctHigherSets(spec, (data[s] ?? []).filter((b) => b.startMs >= fromMs && b.endMs <= toMs), s)
        : undefined,
    ]),
  );
  const levelSets = Object.fromEntries(
    spec.symbols.map((s) => [
      s,
      ctLevelSets(spec, (data[s] ?? []).filter((b) => b.startMs >= fromMs && b.endMs <= toMs)),
    ]),
  );
  const firstInRange = Object.fromEntries(
    spec.symbols.map((s) => {
      const i = (data[s] ?? []).findIndex((b) => b.startMs >= fromMs);
      return [s, i < 0 ? Infinity : i];
    }),
  );
  const addBlock = (reason: string) => {
    result.blocked[reason] = (result.blocked[reason] ?? 0) + 1;
  };
  let marked = cash;
  const recordDay = () => {
    if (day)
      result.daily.push({
        date: day,
        equity: marked,
        returnPct: (marked / dayStart - 1) * 100,
      });
  };
  for (const time of times) {
    options.policy?.observe(time);
    if (options.deadline && Date.now() > options.deadline)
      throw new Error("CT 계산 시간 상한");
    const date = ctDate(time - 1, contract.market, contract.timezone);
    if (date !== day) {
      recordDay();
      day = date;
      dayStart = marked;
    }
    result.bars++;
    if (pending && !held && limitPolicy) {
      // Limit entry: a buy limit at the decision bar's close (rounded down to a tick) rests for entryTtlBars bars and
      // fills only when a bar trades through it. A delayed order (the gate's delay stress) is placed that many bars later.
      const i = indexes[pending.symbol].get(time),
        rows = data[pending.symbol],
        bar = i === undefined ? null : rows[i];
      if (bar && i! > pending.index) {
        const delay = options.delayBars ?? 0,
          signal = pending.signal,
          tick = ctTickOf(limitPolicy, pending.symbol),
          limit = pending.limit!,
          last = pending.index + delay + limitPolicy.entryTtlBars;
        const dayEnd = ctSessionPolicy(contract).freeBars ? ctDayEndMs(contract.market, bar.startMs + 1) : null;
        const drop = (reason: "data_gap" | "day_end" | "unfilled") => {
          result.missed++;
          addBlock(reason);
          if (reason === "unfilled") {
            stats.unfilled++;
            if (pending!.forward !== undefined && Number.isFinite(pending!.forward)) unfilledForward.push(pending!.forward);
          }
          pending = null;
        };
        if (bar.startMs !== rows[i! - 1].endMs) drop("data_gap");
        else if (i! > last) drop("unfilled");
        else if (i! >= pending.index + 1 + delay && ctThroughHit("buy", limit, bar, tick, limitPolicy.penetrationTicks)) {
          if (dayEnd !== null && bar.endMs > dayEnd - spec.minutes * 60_000) drop("day_end");
          else {
            const price = limit,
              feePct = ctLegCosts("entry", limitPolicy, 0, multiplier).feePct / 100;
            const position = ctOpenPosition(spec, signal, price, bar.startMs, { stopScale: options.stopScale });
            const q = position
              ? ctQuantity(spec, contract, cash, cash, price, Math.min(rows[pending.index].volume, bar.volume), plan.managed ? ctRiskPct(position) : undefined)
              : 0;
            if (
              q &&
              position &&
              (!plan.invalidationLow || price > signal.patternLow) &&
              Math.abs(price / signal.reference - 1) * 100 <= spec.entry.maxDeviationPct &&
              contract.costs.spreadPct * multiplier <= spec.entry.maxSpreadPct
            ) {
              held = { symbol: pending.symbol, signal, entry: price, at: bar.startMs, quantity: q, fee: q * price * feePct, entryImpact: 0, checkedThrough: bar.startMs, position };
              cash -= q * price + held.fee;
              stats.filled++;
              if (pending.forward !== undefined && Number.isFinite(pending.forward)) filledForward.push(pending.forward);
            } else {
              result.missed++;
              addBlock(!position && plan.managed ? "invalid_stop" : "liquidity_or_deviation");
            }
            pending = null;
          }
        }
      }
    }
    if (pending && !held && !limitPolicy) {
      const i = indexes[pending.symbol].get(time),
        rows = data[pending.symbol],
        bar = i === undefined ? null : rows[i];
      if (bar && i! >= pending.index + 1 + (options.delayBars ?? 0)) {
        const signal = pending.signal;
        // Free-bar contracts only: older contracts' saved stress results stay bit for bit (tests/ct-pattern-2-regression).
        const dayEnd = spec.engine !== CT_ENGINE_V1 && ctSessionPolicy(contract).freeBars ? ctDayEndMs(contract.market, bar.startMs + 1) : null;
        if (
          bar.startMs !==
          signal.decidedAt + (options.delayBars ?? 0) * spec.minutes * 60000
        ) {
          result.missed++;
          pending = null;
          addBlock("data_gap");
        } else if (dayEnd !== null && bar.endMs > dayEnd - spec.minutes * 60_000) {
          // A delayed entry (the gate's one-bar delay stress) that would open on the day's final bar, after the
          // closing bar, could never be force-closed that day and would carry past midnight: it is not taken.
          result.missed++;
          pending = null;
          addBlock("day_end");
        } else {
          const impact = ctImpactPct(contract, multiplier);
          const price = ctFillPrice(
              bar.open * (1 + impact / 100),
              contract.market,
              "buy",
              contract.currency,
            ),
            feePct = (contract.costs.feePct * multiplier) / 100;
          const position = ctOpenPosition(spec, signal, price, bar.startMs, { stopScale: options.stopScale });
          const q = position
            ? ctQuantity(
                spec,
                contract,
                cash,
                cash,
                price,
                Math.min(rows[pending.index].volume, bar.volume),
                plan.managed ? ctRiskPct(position) : undefined,
              )
            : 0;
          if (
            q &&
            position &&
            (!plan.invalidationLow || price > signal.patternLow) &&
            Math.abs(price / signal.reference - 1) * 100 <=
              spec.entry.maxDeviationPct &&
            contract.costs.spreadPct * multiplier <= spec.entry.maxSpreadPct
          ) {
            held = {
              symbol: pending.symbol,
              signal,
              entry: price,
              at: bar.startMs,
              quantity: q,
              fee: q * price * feePct,
              entryImpact: q * (price - bar.open),
              checkedThrough: bar.startMs,
              position,
            };
            cash -= q * price + held.fee;
          } else {
            result.missed++;
            addBlock(!position && plan.managed ? "invalid_stop" : "liquidity_or_deviation");
          }
          pending = null;
        }
      }
    }
    if (held) {
      const i = indexes[held.symbol].get(time),
        bar = i === undefined ? null : data[held.symbol][i];
      if (bar) {
        if (bar.startMs !== held.checkedThrough) {
          result.status = "data_error";
          result.diagnostics.push("보유 중 누락 봉 · 청산 검증 불가");
          return result;
        }
        held.checkedThrough = bar.endMs;
        const lowEquity =
          cash +
          held.quantity *
            bar.low *
            (1 -
              ((contract.costs.feePct + contract.costs.sellTaxPct) *
                multiplier) /
                100);
        result.maxDrawdownPct = Math.max(
          result.maxDrawdownPct,
          (1 - lowEquity / peak) * 100,
        );
        let step: ReturnType<typeof ctExitStep>;
        let exit: CTExitHit | null;
        if (limitPolicy && held.exiting) {
          // The stop's sell order is still being chased; the position stays open until it fills.
          step = { position: held.position, exit: null };
          exit = bar.endMs >= held.exiting.fill.fillEndMs ? held.exiting.hit : null;
        } else {
          step = ctExitStep(
            spec,
            held.signal,
            held.position,
            bar,
            ctForcedExit(spec, contract.market, bar),
            limitPolicy ? { tick: ctTickOf(limitPolicy, held.symbol), penetrationTicks: limitPolicy.penetrationTicks, fillBar: bar.startMs === held.at } : null,
          );
          held.position = step.position;
          exit = step.exit ?? (options.policy?.exit() ? {price:bar.close,reason:"book_signal_expired"} : null);
        }
        let limitFill: ExitFill | null = null;
        if (limitPolicy && exit) {
          if (held.exiting) limitFill = held.exiting.fill;
          else if (exit.reason === "stop" || exit.reason === "breakeven" || exit.reason === "trail") {
            const sim = ctSimulateStopExit({
              rows: oneMinute[held.symbol] ?? [],
              triggerStartMs: bar.startMs,
              triggerPrice: exit.price,
              stopLevel: held.position.stopLevel,
              policy: limitPolicy,
              symbol: held.symbol,
            });
            // No one-minute rows to chase on: price it as an immediate marketable stop-limit.
            limitFill = sim
              ? { price: sim.price, leg: sim.leg === "taker" ? "marketable" : sim.leg, chases: sim.chases, fillEndMs: sim.chases === 0 ? bar.endMs : Math.max(bar.endMs, sim.fillEndMs) }
              : { price: exit.price, leg: "marketable", chases: 0, fillEndMs: bar.endMs };
            if (limitFill.fillEndMs > bar.endMs) {
              held.exiting = { fill: limitFill, hit: exit };
              exit = null;
            }
          } else limitFill = { price: exit.price, leg: exit.reason === "target" ? "maker" : "marketable", chases: 0, fillEndMs: bar.endMs };
        }
        if (exit && limitPolicy && limitFill) {
          const maker = limitFill.leg === "maker",
            costs = ctLegCosts(maker ? "maker" : "taker", limitPolicy, ctImpactPct(contract), multiplier),
            tick = ctTickOf(limitPolicy, held.symbol),
            price = maker
              ? ctTickRound(limitFill.price, tick, "up")
              : ctFillPrice(limitFill.price * (1 - costs.impactPct / 100), contract.market, "sell", contract.currency),
            fees = held.fee + (held.quantity * price * (costs.feePct + (contract.costs.sellTaxPct * multiplier))) / 100,
            pnl = (price - held.entry) * held.quantity - fees;
          cash += held.quantity * price - (fees - held.fee);
          result.trades.push({
            symbol: held.symbol,
            signal: held.signal,
            entryAt: held.at,
            exitAt: limitFill.fillEndMs,
            entry: held.entry,
            exit: price,
            quantity: held.quantity,
            fees,
            executionCost: held.entryImpact + held.quantity * (limitFill.price - price),
            pnl,
            reason: exit.reason,
            specHash: hash,
            compliant: true,
            exitFill: { leg: limitFill.leg, chases: limitFill.chases },
            ...(plan.managed ? { management: ctManagement(held.position) } : {}),
          });
          if (limitFill.leg === "emergency") stats.exits.emergency++;
          else if (limitFill.leg === "maker") stats.exits[exit.reason === "target" ? "target" : "stopMaker"]++;
          else if (exit.reason === "stop" || exit.reason === "breakeven" || exit.reason === "trail") stats.exits.stopTaker++;
          else stats.exits.other++;
          lastExit = time;
          held = null;
        } else if (exit) {
          const price = ctFillPrice(
            exit.price *
              (1 -
                ((contract.costs.spreadPct / 2 + contract.costs.slippagePct) *
                  multiplier) /
                  100),
            contract.market,
            "sell",
              contract.currency,
          );
          const fees =
            held.fee +
            (held.quantity *
              price *
              (contract.costs.feePct + contract.costs.sellTaxPct) *
              multiplier) /
              100;
          const pnl = (price - held.entry) * held.quantity - fees;
          cash += held.quantity * price - (fees - held.fee);
          result.trades.push({
            symbol: held.symbol,
            signal: held.signal,
            entryAt: held.at,
            exitAt: bar.endMs,
            entry: held.entry,
            exit: price,
            quantity: held.quantity,
            fees,
            executionCost:
              held.entryImpact + held.quantity * (exit.price - price),
            pnl,
            reason: exit.reason,
            specHash: hash,
            compliant: true,
            ...(plan.managed ? { management: ctManagement(held.position) } : {}),
          });
          lastExit = time;
          held = null;
        }
        marked = held
          ? cash +
            held.quantity *
              bar.close *
              (1 -
                ((contract.costs.feePct + contract.costs.sellTaxPct) *
                  multiplier) /
                  100)
          : cash;
      }
    } else marked = cash;
    peak = Math.max(peak, marked);
    result.maxDrawdownPct = Math.max(
      result.maxDrawdownPct,
      (1 - marked / peak) * 100,
    );
    if (
      !held &&
      !pending &&
      time - lastExit >= spec.sizing.cooldownBars * spec.minutes * 60000 &&
      marked >= dayStart * 0.97 &&
      result.maxDrawdownPct < 15 &&
      !ctEntryBlocked(spec, contract.market, time)
    ) {
      for (const symbol of spec.symbols) {
        const i = indexes[symbol].get(time);
        if (i === undefined) continue;
        // Purged split: pattern history and positions never cross the evaluation boundary.
        const rows = data[symbol].slice(
          Math.max(0, i - history, firstInRange[symbol]),
          i + 1,
        );
        const signal = options.policy ? options.policy.signal(symbol,time) : detectCT(spec, symbol, rows, time, featureCaches[symbol], higherSets[symbol], levelSets[symbol]);
        if (signal) {
          result.signals++;
          if (limitPolicy) {
            stats.signals++;
            const limit = ctTickRound(signal.reference, ctTickOf(limitPolicy, symbol), "down");
            pending = { symbol, signal, index: i, limit, forward: ctForwardReturnPct(data[symbol], i, limit, forwardBars) };
          } else pending = { symbol, signal, index: i };
          break;
        }
      }
    }
  }
  if (held) {
    result.diagnostics.push(
      "평가 경계의 미청산 포지션: 신규 구간으로 이월하지 않음",
    );
    const price = ctFillPrice(
      data[held.symbol].filter((b) => b.endMs <= toMs).at(-1)!.close *
        (1 -
          ((contract.costs.spreadPct / 2 + contract.costs.slippagePct) *
            multiplier) /
            100),
      contract.market,
      "sell",
              contract.currency,
    );
    const fees =
      held.fee +
      (held.quantity *
        price *
        (contract.costs.feePct + contract.costs.sellTaxPct) *
        multiplier) /
        100;
    cash += held.quantity * price - (fees - held.fee);
    result.trades.push({
      symbol: held.symbol,
      signal: held.signal,
      entryAt: held.at,
      exitAt: toMs,
      entry: held.entry,
      exit: price,
      quantity: held.quantity,
      fees,
      executionCost:
        held.entryImpact +
        held.quantity *
          (data[held.symbol].filter((b) => b.endMs <= toMs).at(-1)!.close -
            price),
      pnl: (price - held.entry) * held.quantity - fees,
      reason: "boundary",
      specHash: hash,
      compliant: true,
      ...(plan.managed ? { management: ctManagement(held.position) } : {}),
    });
    marked = cash;
  }
  recordDay();
  Object.assign(result, ctDailyStats(result));
  const wins = result.trades.filter((t) => t.pnl > 0),
    losses = result.trades.filter((t) => t.pnl <= 0);
  result.status = result.trades.length ? "measured" : "no_trades";
  result.netReturnPct = (cash / contract.capital - 1) * 100;
  result.feeCosts = result.trades.reduce((s, t) => s + t.fees, 0);
  result.spreadSlippageCosts = result.trades.reduce(
    (s, t) => s + (t.executionCost ?? 0),
    0,
  );
  result.costs = result.feeCosts + result.spreadSlippageCosts;
  result.grossReturnPct =
    result.netReturnPct + (result.costs / contract.capital) * 100;
  result.winRatePct = (wins.length / Math.max(1, result.trades.length)) * 100;
  result.expectancy =
    result.trades.reduce((s, t) => s + t.pnl, 0) /
    Math.max(1, result.trades.length);
  result.payoff =
    wins.reduce((s, t) => s + t.pnl, 0) /
    Math.max(1, wins.length) /
    Math.max(
      1e-9,
      -losses.reduce((s, t) => s + t.pnl, 0) / Math.max(1, losses.length),
    );
  const contribution = (key: (t: CTTrade) => string) => {
    const map = new Map<string, number>();
    for (const t of result.trades)
      map.set(key(t), (map.get(key(t)) ?? 0) + Math.max(0, t.pnl));
    return (
      (Math.max(0, ...map.values()) /
        Math.max(
          1e-9,
          [...map.values()].reduce((s, v) => s + v, 0),
        )) *
      100
    );
  };
  result.concentrationPct = contribution((t) => t.symbol);
  result.maxMonthConcentrationPct = contribution((t) =>
    ctDate(t.exitAt, contract.market, contract.timezone).slice(0, 7),
  );
  result.emptyDays = result.daily.filter(
    (d) =>
      !result.trades.some((t) => ctDate(t.exitAt, contract.market, contract.timezone) === d.date),
  ).length;
  if (result.status === "no_trades")
    result.diagnostics.push("신호/거래 표본 부족");
  if (result.costs > result.trades.reduce((s, t) => s + t.pnl + t.fees, 0))
    result.diagnostics.push("비용 잠식");
  if (result.concentrationPct > 80) result.diagnostics.push("종목 수익 집중");
  if (result.netReturnPct <= 0)
    result.diagnostics.push("비용 후 양의 엣지 미확인");
  if ((result.meanDailyReturnPct ?? 0) <= 0)
    result.diagnostics.push("일평균 비용 후 수익 0 이하");
  if (limitPolicy) {
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null),
      filledMean = mean(filledForward),
      unfilledMean = mean(unfilledForward);
    stats.fillRatePct = stats.filled + stats.unfilled ? (stats.filled / (stats.filled + stats.unfilled)) * 100 : 0;
    stats.filledForwardPct = filledMean;
    stats.unfilledForwardPct = unfilledMean;
    stats.adverseSelectionPct = filledMean !== null && unfilledMean !== null ? filledMean - unfilledMean : null;
    result.execution = stats;
    if (stats.unfilled)
      result.diagnostics.push(`지정가 미체결 ${stats.unfilled}건 · 체결률 ${stats.fillRatePct.toFixed(1)}%`);
    if (stats.exits.emergency) result.diagnostics.push(`비상 시장가 청산 ${stats.exits.emergency}건`);
    if (stats.adverseSelectionPct !== null && stats.adverseSelectionPct < 0)
      result.diagnostics.push(`역선택: 체결된 신호의 이후 수익이 미체결보다 ${(-stats.adverseSelectionPct).toFixed(3)}%p 낮음`);
  }
  if(options.accountState)result.accountState={peakEquity:peak,maxDrawdownPct:result.maxDrawdownPct};
  return result;
}
/**
 * Day-level view of a replay: what one evaluated day of trading returned after costs.
 * Results stored before these fields existed are derived from their daily equity rows.
 */
export function ctDailyStats(result: Pick<CTResult, "daily">) {
  const days = result.daily.map((d) => d.returnPct);
  return {
    meanDailyReturnPct: days.length
      ? days.reduce((s, n) => s + n, 0) / days.length
      : 0,
    positiveDayPct: days.length
      ? (days.filter((n) => n > 0).length / days.length) * 100
      : 0,
    worstDayPct: days.length ? Math.min(...days) : 0,
  };
}
/**
 * Stability across calendar quarters: mean daily net return after costs per quarter of the
 * evaluated days, and the share of quarters that are positive. Information for the designer and
 * the reviewers only — no gate reads it. Derived from the daily rows, so it exists for old results.
 */
export function ctStability(result: Pick<CTResult, "daily">) {
  const quarters = new Map<string, number[]>();
  for (const d of result.daily) {
    const quarter = `${d.date.slice(0, 4)}Q${Math.floor((Number(d.date.slice(5, 7)) - 1) / 3) + 1}`;
    quarters.set(quarter, [...(quarters.get(quarter) ?? []), d.returnPct]);
  }
  const rows = [...quarters]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([quarter, xs]) => ({
      quarter,
      days: xs.length,
      meanDailyReturnPct: Number((xs.reduce((s, n) => s + n, 0) / xs.length).toFixed(4)),
    }));
  return {
    quarters: rows,
    positiveQuarterPct: rows.length ? Number(((rows.filter((r) => r.meanDailyReturnPct > 0).length / rows.length) * 100).toFixed(1)) : 0,
  };
}
/** Daily mean net return, read from the result or derived for results saved before it. */
type CTDailyView = Pick<CTResult, "daily" | "netReturnPct" | "meanDailyReturnPct">;
export function ctMeanDaily(result: CTDailyView) {
  return result.meanDailyReturnPct ?? ctDailyStats(result).meanDailyReturnPct;
}
/** Positive after costs both in total and per evaluated day. */
export function ctNetPositive(result: CTDailyView) {
  return result.netReturnPct > 0 && ctMeanDaily(result) > 0;
}
export function ctGate(result: CTResult, contract: CTContract) {
  return [
    result.status !== "measured" && "측정된 거래 없음",
    (result.tradeCount ?? result.trades.length) < contract.policy.minTrades &&
      "거래 표본 부족",
    result.netReturnPct <= contract.policy.minNetReturnPct &&
      "비용 후 수익 기준 미달",
    ctMeanDaily(result) <= (contract.policy.minMeanDailyReturnPct ?? 0) &&
      "일평균 비용 후 수익 기준 미달",
    result.maxDrawdownPct > contract.policy.maxDrawdownPct && "낙폭 초과",
    result.compliancePct < contract.policy.minCompliancePct && "규칙 준수 미달",
    contract.symbols.length > 1 &&
      result.concentrationPct > contract.policy.maxSymbolConcentrationPct &&
      "종목 집중",
    result.maxMonthConcentrationPct > 80 && "시기 집중",
  ].filter(Boolean) as string[];
}
export function ctSummary(result: CTResult) {
  const { trades, ...summary } = result;
  return {
    ...ctDailyStats(result),
    ...summary,
    tradeCount: result.tradeCount ?? trades.length,
  };
}

/** Small state checkpoint; all executions are persisted separately by the replay tool. */
export function ctCheckpointResult(result: CTResult): CTResult {
  const rows = result.trades;
  const chosen = [
    ...rows.slice(0, 2),
    ...rows.filter((t) => t.pnl < 0).slice(0, 2),
    ...rows.filter((t) => t.pnl >= 0).slice(0, 2),
    ...rows.slice(-2),
  ];
  const trades = [
    ...new Map(chosen.map((t) => [`${t.symbol}:${t.entryAt}`, t])).values(),
  ].sort((a, b) => a.entryAt - b.entryAt);
  return { ...result, tradeCount: result.tradeCount ?? rows.length, trades };
}
