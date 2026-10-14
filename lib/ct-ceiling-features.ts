/**
 * Research-only feature builders for the ceiling measurement (docs/research/ct-ceiling-2026-10-14-field.md).
 * NOT part of the rule language and not available to the designer: derivatives and exchange-gap columns exist here only to
 * ask whether the field is worth widening. Every column is computed for a DECISION time t (the close `endMs` of a
 * 1-minute bar) from values that were already published at t:
 *
 *   premium index (1m)   a bar is usable once it has closed: endMs ≤ t
 *   funding rate         the settlement with calcMs ≤ t
 *   metrics (5m)         `create_time` T is the START of the window the row describes ([T, T+5m), verified against futures klines),
 *                        so the row is usable only from T + 5 minutes
 *   Upbit–Binance gap    the three completed 1-minute closes of the same minute
 *
 * A missing value is NaN (never carried across a stale gap).
 */
import type { CTBar } from "./ct-engine.ts";
import { ctRng } from "./ct-trader-tools.ts";

const MIN = 60_000;
const WEEK_MIN = 7 * 24 * 60;

/** A regular grid: slot k covers time start + k·step; the value of a slot is NaN when nothing was published. */
export type Grid = { start: number; step: number; values: Float64Array };
export function toGrid(times: ArrayLike<number>, values: ArrayLike<number>, start: number, end: number, step: number): Grid {
  const n = Math.max(0, Math.floor((end - start) / step) + 1);
  const grid = new Float64Array(n).fill(NaN);
  for (let i = 0; i < times.length; i++) {
    const k = (times[i] - start) / step;
    if (Number.isInteger(k) && k >= 0 && k < n && Number.isFinite(values[i])) grid[k] = values[i];
  }
  return { start, step, values: grid };
}
const slotOf = (g: Grid, t: number) => Math.floor((t - g.start) / g.step);
const at = (g: Grid, k: number) => (k >= 0 && k < g.values.length ? g.values[k] : NaN);

/** Rolling mean/std z-score of each slot against the last `window` slots up to and including it (NaN if fewer than `minCount` valid). */
export function rollingZ(g: Grid, window: number, minCount: number): Float64Array {
  const n = g.values.length,
    z = new Float64Array(n).fill(NaN);
  const cnt = new Float64Array(n + 1),
    sum = new Float64Array(n + 1),
    sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = g.values[i],
      ok = Number.isFinite(v);
    cnt[i + 1] = cnt[i] + (ok ? 1 : 0);
    sum[i + 1] = sum[i] + (ok ? v : 0);
    sq[i + 1] = sq[i] + (ok ? v * v : 0);
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(g.values[i])) continue;
    const lo = Math.max(0, i + 1 - window),
      c = cnt[i + 1] - cnt[lo];
    if (c < minCount) continue;
    const mean = (sum[i + 1] - sum[lo]) / c,
      variance = Math.max(0, (sq[i + 1] - sq[lo]) / c - mean * mean);
    z[i] = variance > 1e-18 ? (g.values[i] - mean) / Math.sqrt(variance) : NaN;
  }
  return z;
}

export type DerivInput = {
  premium: { endMs: ArrayLike<number>; close: ArrayLike<number> };
  funding: { calcMs: ArrayLike<number>; rate: ArrayLike<number> };
  metrics: { startMs: ArrayLike<number>; openInterestValue: ArrayLike<number>; takerVolRatio: ArrayLike<number> };
};
export const DERIV_NAMES = ["funding_level", "funding_change", "premium_pct", "premium_chg15", "premium_chg60", "premium_z7d", "oi_chg60", "oi_chg240", "oi_z7d", "taker_ratio", "taker_ratio_1h"] as const;

/** Last index with times[i] ≤ t (times sorted), or -1. */
function lastAtOrBefore(times: ArrayLike<number>, t: number) {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The 11 derivative columns at the given decision times (ms, bar closes). */
export function derivColumns(decisionEnds: ArrayLike<number>, input: DerivInput): Float32Array[] {
  const n = decisionEnds.length,
    cols = DERIV_NAMES.map(() => new Float32Array(n).fill(NaN));
  const [fLevel, fChange, pPct, pC15, pC60, pZ, oC60, oC240, oZ, tRatio, t1h] = cols;
  if (!n) return cols;
  const first = decisionEnds[0],
    last = decisionEnds[n - 1];
  // 1-minute premium grid (bar close = end of the minute) and its 7-day z-score.
  const pGrid = toGrid(input.premium.endMs, input.premium.close, first - 8 * 24 * 60 * MIN, last, MIN);
  for (let i = 0; i < pGrid.values.length; i++) if (Number.isFinite(pGrid.values[i])) pGrid.values[i] *= 100;
  const pz = rollingZ(pGrid, WEEK_MIN, WEEK_MIN * 0.7);
  // 5-minute metrics: slot start T, usable from T + 5 minutes.
  // The grid origin must sit on the 5-minute lattice of the rows (create_time is a multiple of 5 minutes since the epoch).
  const mStart = Math.floor((first - 8 * 24 * 60 * MIN) / (5 * MIN)) * 5 * MIN;
  const oi = toGrid(input.metrics.startMs, input.metrics.openInterestValue, mStart, last, 5 * MIN);
  const taker = toGrid(input.metrics.startMs, input.metrics.takerVolRatio, mStart, last, 5 * MIN);
  const oz = rollingZ(oi, 7 * 24 * 12, 7 * 24 * 12 * 0.7);
  for (let i = 0; i < n; i++) {
    const t = decisionEnds[i];
    // funding: the latest settlement already made, at most 9 hours old
    const f = lastAtOrBefore(input.funding.calcMs, t);
    if (f >= 0 && t - input.funding.calcMs[f] <= 9 * 60 * MIN) {
      fLevel[i] = input.funding.rate[f];
      if (f >= 1) fChange[i] = input.funding.rate[f] - input.funding.rate[f - 1];
    }
    // premium: the minute that closes at t
    const ps = slotOf(pGrid, t),
      pv = at(pGrid, ps);
    if (Number.isFinite(pv)) {
      pPct[i] = pv;
      const p15 = at(pGrid, ps - 15),
        p60 = at(pGrid, ps - 60);
      if (Number.isFinite(p15)) pC15[i] = pv - p15;
      if (Number.isFinite(p60)) pC60[i] = pv - p60;
      pZ[i] = pz[ps] ?? NaN;
    }
    // metrics: the newest window that has completed by t (start ≤ t − 5 minutes)
    const k = Math.floor((t - 5 * MIN - oi.start) / oi.step),
      o = at(oi, k);
    if (Number.isFinite(o) && o > 0) {
      const o60 = at(oi, k - 12),
        o240 = at(oi, k - 48);
      if (Number.isFinite(o60) && o60 > 0) oC60[i] = (o / o60 - 1) * 100;
      if (Number.isFinite(o240) && o240 > 0) oC240[i] = (o / o240 - 1) * 100;
      oZ[i] = oz[k] ?? NaN;
    }
    const tr = at(taker, k);
    if (Number.isFinite(tr)) {
      tRatio[i] = tr;
      let s = 0,
        c = 0;
      for (let j = k - 11; j <= k; j++) {
        const v = at(taker, j);
        if (Number.isFinite(v)) {
          s += v;
          c++;
        }
      }
      if (c >= 10) t1h[i] = s / c;
    }
  }
  return cols;
}

export const GAP_NAMES = ["gap_pct", "gap_chg15", "gap_chg60", "gap_z7d", "lead1", "lead3", "lead5"] as const;
export type MinuteCloses = { endMs: ArrayLike<number>; close: ArrayLike<number> };
/**
 * Upbit–Binance gap and lead–lag at the decision times: gap = Upbit coin ÷ (Binance coin × Upbit KRW-USDT) − 1 (percent), from
 * the closes of the same completed minute; lead_k = Binance return over k minutes − Upbit return over k minutes (percentage points).
 */
export function gapColumns(decisionEnds: ArrayLike<number>, binance: MinuteCloses, upbit: MinuteCloses, usdtKrw: MinuteCloses): Float32Array[] {
  const n = decisionEnds.length,
    cols = GAP_NAMES.map(() => new Float32Array(n).fill(NaN));
  if (!n) return cols;
  const [g, c15, c60, gz, l1, l3, l5] = cols;
  const start = decisionEnds[0] - 8 * 24 * 60 * MIN,
    end = decisionEnds[n - 1];
  const B = toGrid(binance.endMs, binance.close, start, end, MIN),
    U = toGrid(upbit.endMs, upbit.close, start, end, MIN),
    K = toGrid(usdtKrw.endMs, usdtKrw.close, start, end, MIN);
  const gap = { start, step: MIN, values: new Float64Array(B.values.length).fill(NaN) } as Grid;
  for (let s = 0; s < gap.values.length; s++) {
    const b = B.values[s],
      u = U.values[s],
      k = K.values[s];
    if (b > 0 && u > 0 && k > 0) gap.values[s] = (u / (b * k) - 1) * 100;
  }
  const z = rollingZ(gap, WEEK_MIN, WEEK_MIN * 0.7);
  const ret = (grid: Grid, s: number, m: number) => {
    const now = at(grid, s),
      before = at(grid, s - m);
    return now > 0 && before > 0 ? (now / before - 1) * 100 : NaN;
  };
  for (let i = 0; i < n; i++) {
    const s = slotOf(gap, decisionEnds[i]),
      v = at(gap, s);
    if (!Number.isFinite(v)) continue;
    g[i] = v;
    const a = at(gap, s - 15),
      b = at(gap, s - 60);
    if (Number.isFinite(a)) c15[i] = v - a;
    if (Number.isFinite(b)) c60[i] = v - b;
    gz[i] = z[s] ?? NaN;
    for (const [col, m] of [[l1, 1], [l3, 3], [l5, 5]] as const) col[i] = ret(B, s, m) - ret(U, s, m);
  }
  return cols;
}

/**
 * Upbit publishes no candle for a minute without a trade. Rebuild a gapless 1-minute series: a missing minute is a flat bar
 * with zero volume at the previous close (a price that did not trade did not move). Minutes before the first candle are not filled.
 */
export function fillMinuteGrid(rows: Array<{ startMs: number; open: number; high: number; low: number; close: number; volume: number }>, startMs: number, endMs: number) {
  const bars: CTBar[] = [];
  let filled = 0,
    prev: number | null = null,
    r = 0;
  const sorted = [...rows].sort((a, b) => a.startMs - b.startMs);
  for (let t = startMs; t < endMs; t += MIN) {
    while (r < sorted.length && sorted[r].startMs < t) r++;
    if (r < sorted.length && sorted[r].startMs === t) {
      const c = sorted[r];
      bars.push({ startMs: t, endMs: t + MIN, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      prev = c.close;
    } else if (prev !== null) {
      bars.push({ startMs: t, endMs: t + MIN, open: prev, high: prev, low: prev, close: prev, volume: 0 });
      filled++;
    }
  }
  return { bars, filled };
}

/**
 * Round-trip cost percent from order-book samples of one venue and symbol: 2 × the fee per side + 2 × the p90 of the measured
 * one-way impact (buy and sell sides together) of the sampled notional. NaN samples are ignored.
 */
export function roundTripFromSamples(rows: Array<{ buy_bp: number | null; sell_bp: number | null }>, feePctPerSide: number) {
  const sides = rows.flatMap((r) => [r.buy_bp, r.sell_bp]).filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!sides.length) return { costPct: 2 * feePctPerSide, p90bp: null as number | null, samples: 0 };
  const p90 = sides[Math.floor(sides.length * 0.9)];
  return { costPct: 2 * feePctPerSide + (2 * p90) / 100, p90bp: p90, samples: rows.length };
}

/**
 * Day-block permutation of feature rows (the null of the permutation baseline): the days are shuffled with a seeded generator
 * and each day's feature rows (same minute position) are replaced by another day's; labels stay put. A row whose source
 * day has no row at that minute becomes NaN. Within-day autocorrelation of the features survives, their link to the labels does not.
 */
export function permuteDayBlocks(cols: Float32Array[], dayKey: Int32Array, startMs: Float64Array, dayStartMs: Float64Array, seed: number): Float32Array[] {
  const n = dayKey.length;
  const days = [...new Set(Array.from(dayKey).filter((k) => k >= 0))].sort((a, b) => a - b);
  const rowAt = new Map<number, Map<number, number>>();
  for (let i = 0; i < n; i++) {
    if (dayKey[i] < 0) continue;
    const m = Math.round((startMs[i] - dayStartMs[i]) / MIN);
    let day = rowAt.get(dayKey[i]);
    if (!day) rowAt.set(dayKey[i], (day = new Map()));
    day.set(m, i);
  }
  const rng = ctRng(seed);
  const order = [...days];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const source = new Map(days.map((d, k) => [d, order[k]]));
  const out = cols.map(() => new Float32Array(n).fill(NaN));
  for (let i = 0; i < n; i++) {
    if (dayKey[i] < 0) continue;
    const src = rowAt.get(source.get(dayKey[i])!)?.get(Math.round((startMs[i] - dayStartMs[i]) / MIN));
    if (src === undefined) continue;
    cols.forEach((c, f) => (out[f][i] = c[src]));
  }
  return out;
}
