/**
 * Day-trader levels for ct-pattern-3 conditions, built once per symbol from the base bars
 * (one-minute, or the contract's 5/15/60-minute bars) and read by index — the same arrays serve a replay's every minute and a live tick.
 *
 * "Day" is the trading day the decision bar belongs to: the UTC day for crypto (00:00 UTC =
 * 09:00 KST), the regular session for stocks. Every value at time t uses only bars closed by t
 * and only while the day is intact: the day's first bar must start exactly at the day start and
 * every bar since must chain without a gap, otherwise the value is null (a VWAP over a day with
 * missing minutes is not a VWAP). The previous day comes from the completed daily series.
 *
 *  - vwap        cumulative sum(typical price × volume) / sum(volume), typical = (high+low+close)/3
 *  - day open    the open of the day's first bar
 *  - day range   running high/low of the day including the decision bar
 *  - open range  high/low of the day's first `lookback` minutes; null until that many minutes are done
 */
import { dayInfo, type DayInfo } from "./t-moves.ts";
import { prevDailyBar, type CTHigherSeries } from "./t-timeframes.ts";
import { validCTBar, type CTBar } from "./t-engine.ts";
import type { CTCondition, CTMarket } from "./t-spec.ts";

export type CTDayLevels = {
  endMs: Float64Array;
  day: DayInfo;
  vwap: Float64Array;
  dayOpen: Float64Array;
  dayHigh: Float64Array;
  dayLow: Float64Array;
  /** 1 when every bar from the day start up to this one is present, valid and chained. */
  intact: Uint8Array;
  firstIdx: Int32Array;
  bars: CTBar[];
  openingRanges: Map<number, { high: number; low: number } | null>;
};

export function buildDayLevels(bars: CTBar[], market: CTMarket): CTDayLevels {
  const n = bars.length,
    day = dayInfo(bars, market),
    endMs = new Float64Array(n),
    vwap = new Float64Array(n).fill(NaN),
    dayOpen = new Float64Array(n).fill(NaN),
    dayHigh = new Float64Array(n).fill(NaN),
    dayLow = new Float64Array(n).fill(NaN),
    intact = new Uint8Array(n),
    firstIdx = new Int32Array(n).fill(-1);
  let cumPV = 0,
    cumV = 0,
    high = NaN,
    low = NaN,
    open = NaN,
    first = -1,
    ok = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    endMs[i] = b.endMs;
    if (day.key[i] < 0) {
      first = -1;
      ok = 0;
      continue;
    }
    if (first < 0 || day.key[i] !== day.key[i - 1]) {
      first = i;
      cumPV = 0;
      cumV = 0;
      high = b.high;
      low = b.low;
      open = b.open;
      ok = b.startMs === day.startMs[i] ? 1 : 0;
    } else ok = ok && b.startMs === bars[i - 1].endMs ? 1 : 0;
    if (!validCTBar(b)) ok = 0;
    cumPV += ((b.high + b.low + b.close) / 3) * b.volume;
    cumV += b.volume;
    high = Math.max(high, b.high);
    low = Math.min(low, b.low);
    firstIdx[i] = first;
    intact[i] = ok;
    dayOpen[i] = open;
    dayHigh[i] = high;
    dayLow[i] = low;
    if (cumV > 0) vwap[i] = cumPV / cumV;
  }
  return { endMs, day, vwap, dayOpen, dayHigh, dayLow, intact, firstIdx, bars, openingRanges: new Map() };
}

/** Index of the bar closing exactly at `ms`, or -1. */
export function levelIndex(levels: CTDayLevels, ms: number) {
  let lo = 0,
    hi = levels.endMs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1,
      v = levels.endMs[mid];
    if (v === ms) return mid;
    if (v < ms) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function openingRange(levels: CTDayLevels, i: number, minutes: number) {
  const first = levels.firstIdx[i];
  if (first < 0 || !levels.intact[i]) return null;
  // The range spans `minutes` minutes = that many base bars of one minute, fewer of 5/15/60 (the spec keeps it a multiple).
  const barMinutes = (levels.bars[first].endMs - levels.bars[first].startMs) / 60_000;
  if (minutes % barMinutes) return null;
  const count = minutes / barMinutes;
  if (i - first + 1 < count) return null;
  const key = first * 1000 + minutes;
  let range = levels.openingRanges.get(key);
  if (range === undefined) {
    let high = -Infinity,
      low = Infinity;
    for (let k = first; k < first + count; k++) {
      if (levels.bars[k].high > high) high = levels.bars[k].high;
      if (levels.bars[k].low < low) low = levels.bars[k].low;
    }
    levels.openingRanges.set(key, (range = { high, low }));
  }
  return range;
}

export type CTLevelLine = { feature: string; price: number };

/** Raw (percent or 0–1) value of a level feature at the bar closing at `nowMs`, or null. */
export function levelFeature(
  condition: Pick<CTCondition, "feature" | "lookback">,
  levels: CTDayLevels,
  daily: CTHigherSeries | undefined,
  market: CTMarket,
  symbol: string,
  nowMs: number,
): number | null {
  const i = levelIndex(levels, nowMs);
  if (i < 0) return null;
  const close = levels.bars[i].close;
  const prev = () => (condition.feature.startsWith("prev_day_") && daily ? prevDailyBar(daily, market, symbol, nowMs) : null);
  switch (condition.feature) {
    case "vwap_distance_pct":
      return levels.intact[i] && levels.vwap[i] > 0 ? (close / levels.vwap[i] - 1) * 100 : null;
    case "day_open_distance_pct":
      return levels.intact[i] ? (close / levels.dayOpen[i] - 1) * 100 : null;
    case "day_range_position":
      return levels.intact[i] ? (close - levels.dayLow[i]) / Math.max(levels.dayHigh[i] - levels.dayLow[i], 1e-12) : null;
    case "opening_range_position": {
      const r = openingRange(levels, i, condition.lookback);
      return r && r.high > r.low ? (close - r.low) / (r.high - r.low) : null;
    }
    case "prev_day_high_distance_pct": {
      const p = prev();
      return p ? (close / p.high - 1) * 100 : null;
    }
    case "prev_day_low_distance_pct": {
      const p = prev();
      return p ? (close / p.low - 1) * 100 : null;
    }
    case "prev_day_close_distance_pct": {
      const p = prev();
      return p ? (close / p.close - 1) * 100 : null;
    }
  }
  return null;
}

/** The price lines a level condition actually used, for the chart (observed at nowMs, no later information). */
export function levelLines(
  condition: Pick<CTCondition, "feature" | "lookback">,
  levels: CTDayLevels,
  daily: CTHigherSeries | undefined,
  market: CTMarket,
  symbol: string,
  nowMs: number,
): CTLevelLine[] {
  const i = levelIndex(levels, nowMs);
  if (i < 0 || levelFeature(condition, levels, daily, market, symbol, nowMs) === null) return [];
  const prev = daily ? prevDailyBar(daily, market, symbol, nowMs) : null;
  switch (condition.feature) {
    case "vwap_distance_pct":
      return [{ feature: "vwap", price: levels.vwap[i] }];
    case "day_open_distance_pct":
      return [{ feature: "day_open", price: levels.dayOpen[i] }];
    case "day_range_position":
      return [
        { feature: "day_high", price: levels.dayHigh[i] },
        { feature: "day_low", price: levels.dayLow[i] },
      ];
    case "opening_range_position": {
      const r = openingRange(levels, i, condition.lookback);
      return r
        ? [
            { feature: "opening_range_high", price: r.high },
            { feature: "opening_range_low", price: r.low },
          ]
        : [];
    }
    case "prev_day_high_distance_pct":
      return prev ? [{ feature: "prev_day_high", price: prev.high }] : [];
    case "prev_day_low_distance_pct":
      return prev ? [{ feature: "prev_day_low", price: prev.low }] : [];
    case "prev_day_close_distance_pct":
      return prev ? [{ feature: "prev_day_close", price: prev.close }] : [];
  }
  return [];
}
