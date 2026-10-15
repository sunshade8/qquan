/**
 * "Was there anything to trade here?" — pure measurement helpers, no models, no I/O.
 *
 *  - labelMoves: for every minute t, enter at the NEXT bar's open and ask whether the move
 *    reached +k × round-trip cost before it reached −m × round-trip cost, within a holding
 *    cap that never crosses the day boundary. The same pass returns what the trade would
 *    actually have returned, so the label and the realised outcome cannot disagree.
 *  - moveFeatures: the ten DSL features at three scales (30 × 1m, 24 × 1h, 10 × 1d) plus the
 *    time of day, all from bars closed by t.
 *  - walkForward: a shallow classification tree on the label (Gini), trained on an expanding window;
 *    leaves whose TRAINING mean after-cost outcome is positive are traded on the next block only
 *    (purged at the seam), at least four folds.
 *
 * scripts/research/ct-ceiling.ts runs the grid; the CT designer's contrast tool (stage 3)
 * reuses these functions instead of re-deriving them.
 */
import { sessions as calendar } from "./ct-calendar-data.ts";
import { easternParts, easternWallTimeToEpoch } from "./market-clock.ts";
import { ctStockSession } from "./ct-sessions.ts";
import { buildHigherSeries, higherCount, type CTHigherSeries } from "./ct-timeframes.ts";
import type { CTBar } from "./ct-engine.ts";
import type { CTMarket } from "./ct-spec.ts";

const DAY_MS = 86_400_000;

/* ----------------------------------------------------------------- day grid */

export type DayInfo = {
  /** Day id per bar (UTC day for crypto, NYSE session ordinal for stocks); -1 = outside a session. */
  key: Int32Array;
  /** End of the bar's day in ms (UTC midnight, or the session close). */
  endMs: Float64Array;
  /** Start of the bar's day in ms (UTC midnight, or the session open). */
  startMs: Float64Array;
};
let ordinalCache: Map<string, number> | null = null;
function ordinalOf(date: string) {
  if (!ordinalCache) ordinalCache = new Map(Object.keys(calendar).sort().map((d, i) => [d, i]));
  return ordinalCache.get(date);
}
export function dayInfo(bars: CTBar[], market: CTMarket): DayInfo {
  const n = bars.length,
    key = new Int32Array(n).fill(-1),
    endMs = new Float64Array(n),
    startMs = new Float64Array(n);
  if (market === "crypto") {
    for (let i = 0; i < n; i++) {
      const d = Math.floor(bars[i].startMs / DAY_MS);
      key[i] = d;
      startMs[i] = d * DAY_MS;
      endMs[i] = (d + 1) * DAY_MS;
    }
    return { key, endMs, startMs };
  }
  let open = 0,
    close = 0,
    ord = -1;
  for (let i = 0; i < n; i++) {
    const s = bars[i].startMs;
    if (ord < 0 || s < open || s >= close) {
      const date = easternParts(s).date;
      const session = ctStockSession(date);
      const o = ordinalOf(date);
      if (!session || o === undefined) {
        ord = -1;
        continue;
      }
      open = easternWallTimeToEpoch(date, session.open);
      close = easternWallTimeToEpoch(date, session.close);
      ord = o;
      if (s < open || s >= close) {
        ord = -1;
        continue;
      }
    }
    key[i] = ord;
    startMs[i] = open;
    endMs[i] = close;
  }
  return { key, endMs, startMs };
}
/** Index of the last bar whose close is at least one minute before the day ends (the engine's final tradable bar). */
export function dayLastIndex(bars: CTBar[], day: DayInfo) {
  const n = bars.length,
    last = new Int32Array(n).fill(-1);
  let current = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (day.key[i] < 0) {
      current = -1;
      continue;
    }
    if (i === n - 1 || day.key[i + 1] !== day.key[i]) current = -1;
    if (current < 0 && bars[i].endMs <= day.endMs[i] - 60_000) current = i;
    last[i] = current;
  }
  return last;
}

/* ------------------------------------------------------------------- labels */

export const MOVE_REASON = { invalid: 0, stop: 1, target: 2, time: 3, day_end: 4 } as const;
export type MoveOptions = {
  /** Round-trip cost, percent of the notional. */
  costPct: number;
  /** Target = +k × cost, stop = −m × cost. */
  k: number;
  m: number;
  /** Holding cap in bars; Infinity = until the day's final tradable bar. Never crosses the day boundary. */
  holdBars: number;
};
export type MoveLabels = {
  /** 1 target first, 0 otherwise, -1 not a valid entry (gap, last minutes of the day, outside a session). */
  label: Int8Array;
  /** Gross return of the trade as filled by the exit rule (entry = next open), percent. */
  grossPct: Float32Array;
  /** Index of the bar the trade exits on. */
  exitIndex: Int32Array;
  reason: Uint8Array;
  /**
   * Optional per-row outcomes for execution models whose cost depends on the exit (lib/ct-execution.ts): the realised net
   * at 1× and 2× leg costs, and whether the order filled at all (0 = no position: net 0, not a trade). Absent, the
   * walk-forward uses grossPct − costPct (and − 2 × costPct) and every valid row is a fill.
   */
  netPct?: Float32Array;
  net2Pct?: Float32Array;
  filled?: Uint8Array;
};
export function labelMoves(bars: CTBar[], day: DayInfo, o: MoveOptions): MoveLabels {
  const n = bars.length,
    label = new Int8Array(n).fill(-1),
    grossPct = new Float32Array(n),
    exitIndex = new Int32Array(n).fill(-1),
    reason = new Uint8Array(n),
    last = dayLastIndex(bars, day),
    up = (o.k * o.costPct) / 100,
    down = (o.m * o.costPct) / 100;
  for (let i = 0; i + 1 < n; i++) {
    const e = i + 1;
    if (day.key[i] < 0 || day.key[e] !== day.key[i] || bars[e].startMs !== bars[i].endMs) continue;
    const dayLast = last[e];
    if (dayLast < e) continue;
    const entry = bars[e].open,
      stop = entry * (1 - down),
      target = entry * (1 + up),
      end = Math.min(dayLast, o.holdBars === Infinity ? dayLast : e + o.holdBars - 1);
    let exit = -1,
      price = 0,
      why: number = MOVE_REASON.invalid;
    for (let j = e; j <= end; j++) {
      const b = bars[j];
      if (j > e && b.startMs !== bars[j - 1].endMs) break;
      // Ambiguous bar: stop first. An adverse gap fills at the open (ctExit).
      if (b.low <= stop) {
        exit = j;
        price = Math.min(stop, b.open);
        why = MOVE_REASON.stop;
        break;
      }
      if (b.high >= target) {
        exit = j;
        price = b.open >= target ? b.open : target;
        why = MOVE_REASON.target;
        break;
      }
      if (j === end) {
        exit = j;
        price = b.close;
        why = end === dayLast && (o.holdBars === Infinity || e + o.holdBars - 1 >= dayLast) ? MOVE_REASON.day_end : MOVE_REASON.time;
      }
    }
    if (exit < 0) continue;
    label[i] = why === MOVE_REASON.target ? 1 : 0;
    grossPct[i] = (price / entry - 1) * 100;
    exitIndex[i] = exit;
    reason[i] = why;
  }
  return { label, grossPct, exitIndex, reason };
}

/* ----------------------------------------------------------------- features */

export const MOVE_FEATURES = [
  "return_pct",
  "sma_distance_pct",
  "range_pct",
  "volume_ratio",
  "contraction_ratio",
  "prior_high_distance_pct",
  "prior_low_distance_pct",
  "range_position",
  "swing_high_distance_pct",
  "swing_low_distance_pct",
] as const;
export type MoveFeature = (typeof MOVE_FEATURES)[number];

/**
 * DSL feature values at every bar of one series, lookback L (L prior bars + the current one),
 * the same formulas as ctFeature. `valid(t)` says whether the window t-L..t may be used.
 */
export function seriesFeatures(
  bars: CTBar[],
  L: number,
  valid: (t: number) => boolean,
): Record<MoveFeature, Float32Array> {
  const n = bars.length;
  const out = Object.fromEntries(MOVE_FEATURES.map((f) => [f, new Float32Array(n).fill(NaN)])) as Record<MoveFeature, Float32Array>;
  const csum = new Float64Array(n + 1),
    vsum = new Float64Array(n + 1),
    rsum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    csum[i + 1] = csum[i] + b.close;
    vsum[i + 1] = vsum[i] + b.volume;
    rsum[i + 1] = rsum[i] + (b.high - b.low) / b.close;
  }
  // Rolling max(high) / min(low) of the L bars before t (monotonic deques over indexes).
  const hiQ = new Int32Array(n),
    loQ = new Int32Array(n);
  let hh = 0,
    ht = 0,
    lh = 0,
    lt = 0;
  const isSH = new Uint8Array(n),
    isSL = new Uint8Array(n);
  for (let j = 2; j + 2 < n; j++) {
    const b = bars[j];
    let high = true,
      low = true;
    for (const d of [-2, -1, 1, 2]) {
      if (!(bars[j + d].high < b.high)) high = false;
      if (!(bars[j + d].low > b.low)) low = false;
    }
    isSH[j] = high ? 1 : 0;
    isSL[j] = low ? 1 : 0;
  }
  let lastSH = -1,
    lastSL = -1;
  const cut = Math.floor(L / 2);
  for (let t = 0; t < n; t++) {
    // Window of prior bars is [t-L, t-1]; push bar t-1, drop anything older than t-L.
    if (t >= 1) {
      const p = t - 1;
      while (ht > hh && bars[hiQ[ht - 1]].high <= bars[p].high) ht--;
      hiQ[ht++] = p;
      while (lt > lh && bars[loQ[lt - 1]].low >= bars[p].low) lt--;
      loQ[lt++] = p;
    }
    while (ht > hh && hiQ[hh] < t - L) hh++;
    while (lt > lh && loQ[lh] < t - L) lh++;
    if (t - 2 >= 0) {
      if (isSH[t - 2]) lastSH = t - 2;
      if (isSL[t - 2]) lastSL = t - 2;
    }
    if (t < L || !valid(t)) continue;
    const cur = bars[t],
      high = bars[hiQ[hh]].high,
      low = bars[loQ[lh]].low;
    out.return_pct[t] = (cur.close / bars[t - L].close - 1) * 100;
    out.sma_distance_pct[t] = (cur.close / ((csum[t] - csum[t - L]) / L) - 1) * 100;
    out.range_pct[t] = (high / low - 1) * 100;
    out.volume_ratio[t] = cur.volume / ((vsum[t] - vsum[t - L]) / L);
    // prior = bars t-L .. t-1 ; first half = t-L .. t-L+cut-1, second half = rest.
    const secondN = L - cut,
      firstN = cut;
    out.contraction_ratio[t] =
      ((rsum[t] - rsum[t - L + cut]) / secondN) / Math.max(1e-12, (rsum[t - L + cut] - rsum[t - L]) / Math.max(1, firstN));
    out.prior_high_distance_pct[t] = (cur.close / high - 1) * 100;
    out.prior_low_distance_pct[t] = (cur.close / low - 1) * 100;
    out.range_position[t] = (cur.close - low) / Math.max(high - low, 1e-12);
    if (lastSH >= t - L + 2) out.swing_high_distance_pct[t] = (cur.close / bars[lastSH].high - 1) * 100;
    if (lastSL >= t - L + 2) out.swing_low_distance_pct[t] = (cur.close / bars[lastSL].low - 1) * 100;
  }
  return out;
}

export const MOVE_SCALES = [
  { id: "m1", minutes: 1, lookback: 30 },
  { id: "h1", minutes: 60, lookback: 24 },
  { id: "d1", minutes: 1440, lookback: 10 },
] as const;
export type MoveFeatureTable = { names: string[]; cols: Float32Array[] };

/** Contiguity of a base series: runStart[t] = first index of the unbroken run containing t. */
function runStarts(bars: CTBar[], day: DayInfo) {
  const rs = new Int32Array(bars.length);
  for (let i = 0; i < bars.length; i++)
    rs[i] = i > 0 && bars[i].startMs === bars[i - 1].endMs && day.key[i] === day.key[i - 1] && day.key[i] >= 0 ? rs[i - 1] : i;
  return rs;
}

/**
 * 31 columns aligned to the base bars: 10 DSL features × {30×1m, 24×1h, 10×1d} and the minute
 * of the day (since UTC midnight / the session open). Higher-scale values come from the last
 * bar COMPLETED by each minute's close; before the first window completes they are NaN.
 */
export function moveFeatures(bars: CTBar[], day: DayInfo, market: CTMarket, symbol = ""): MoveFeatureTable {
  const names: string[] = [],
    cols: Float32Array[] = [];
  const rs = runStarts(bars, day);
  const m1 = seriesFeatures(bars, MOVE_SCALES[0].lookback, (t) => rs[t] <= t - MOVE_SCALES[0].lookback);
  for (const f of MOVE_FEATURES) {
    names.push(`m1.${f}`);
    cols.push(m1[f]);
  }
  for (const scale of MOVE_SCALES.slice(1)) {
    const series: CTHigherSeries = buildHigherSeries(bars, scale.minutes, market, symbol);
    const sf = seriesFeatures(series.bars, scale.lookback, (t) => series.brokenPrefix[t + 1] - series.brokenPrefix[t - scale.lookback + 1] === 0);
    for (const f of MOVE_FEATURES) {
      const col = new Float32Array(bars.length).fill(NaN);
      let c = 0;
      for (let t = 0; t < bars.length; t++) {
        while (c < series.bars.length && series.bars[c].endMs <= bars[t].endMs) c++;
        if (c > 0) col[t] = sf[f][c - 1];
      }
      names.push(`${scale.id}.${f}`);
      cols.push(col);
    }
  }
  const tod = new Float32Array(bars.length);
  for (let t = 0; t < bars.length; t++) tod[t] = day.key[t] < 0 ? NaN : (bars[t].startMs - day.startMs[t]) / 60_000;
  names.push("minute_of_day");
  cols.push(tod);
  return { names, cols };
}
export { higherCount };

/* ------------------------------------------------------------------- trees */

export type TreeNode =
  | { leaf: true; n: number; label: number; net: number }
  | { leaf: false; feature: number; threshold: number; left: TreeNode; right: TreeNode };
type Hist = { n: Float64Array; pos: Float64Array };
const BINS = 32;

/** Quantile cut points (BINS-1) of a column over the given rows. */
function edgesFor(col: Float32Array, rows: Int32Array) {
  const xs: number[] = [];
  const step = Math.max(1, Math.floor(rows.length / 60_000));
  for (let r = 0; r < rows.length; r += step) {
    const v = col[rows[r]];
    if (v === v) xs.push(v);
  }
  xs.sort((a, b) => a - b);
  const edges: number[] = [];
  for (let b = 1; b < BINS; b++) {
    const e = xs[Math.min(xs.length - 1, Math.floor((xs.length * b) / BINS))];
    if (e !== undefined && (!edges.length || e > edges[edges.length - 1])) edges.push(e);
  }
  return edges;
}
const binOf = (edges: number[], v: number) => {
  let lo = 0,
    hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v <= edges[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

export type TreeOptions = { depth: number; minLeaf: number };
/**
 * Depth-limited classification tree on the label (Gini), histogram splits over quantile bins.
 * Rows with any NaN feature must be removed by the caller. `net[r]` is the realised outcome of
 * row r, used only to report each leaf's mean.
 */
export function growTree(
  cols: Float32Array[],
  rows: Int32Array,
  label: Int8Array,
  net: Float32Array,
  o: TreeOptions,
): { root: TreeNode; candidateSplits: number } {
  const edges = cols.map((c) => edgesFor(c, rows));
  let candidateSplits = 0;
  const bins = cols.map((c, f) => {
    const arr = new Uint8Array(rows.length);
    for (let r = 0; r < rows.length; r++) arr[r] = binOf(edges[f], c[rows[r]]);
    return arr;
  });
  const gini = (n: number, pos: number) => (n ? 1 - (pos / n) ** 2 - ((n - pos) / n) ** 2 : 0) * n;
  const build = (idx: Int32Array, depth: number): TreeNode => {
    let pos = 0,
      sumNet = 0;
    for (let r = 0; r < idx.length; r++) {
      pos += label[rows[idx[r]]];
      sumNet += net[rows[idx[r]]];
    }
    const leaf: TreeNode = { leaf: true, n: idx.length, label: idx.length ? pos / idx.length : 0, net: idx.length ? sumNet / idx.length : 0 };
    if (depth >= o.depth || idx.length < 2 * o.minLeaf) return leaf;
    const parent = gini(idx.length, pos);
    let best: { f: number; b: number; gain: number } | null = null;
    for (let f = 0; f < cols.length; f++) {
      const hist: Hist = { n: new Float64Array(BINS), pos: new Float64Array(BINS) };
      const col = bins[f];
      for (let r = 0; r < idx.length; r++) {
        const bi = col[idx[r]];
        hist.n[bi]++;
        hist.pos[bi] += label[rows[idx[r]]];
      }
      let ln = 0,
        lp = 0;
      for (let b = 0; b < edges[f].length; b++) {
        ln += hist.n[b];
        lp += hist.pos[b];
        const rn = idx.length - ln;
        candidateSplits++;
        if (ln < o.minLeaf || rn < o.minLeaf) continue;
        const gain = parent - gini(ln, lp) - gini(rn, pos - lp);
        if (!best || gain > best.gain) best = { f, b, gain };
      }
    }
    if (!best || best.gain <= 1e-12) return leaf;
    const left: number[] = [],
      right: number[] = [];
    const col = bins[best.f];
    for (let r = 0; r < idx.length; r++) (col[idx[r]] <= best.b ? left : right).push(idx[r]);
    return {
      leaf: false,
      feature: best.f,
      threshold: edges[best.f][best.b],
      left: build(Int32Array.from(left), depth + 1),
      right: build(Int32Array.from(right), depth + 1),
    };
  };
  const root = build(Int32Array.from({ length: rows.length }, (_, i) => i), 0);
  return { root, candidateSplits };
}
/** Leaf id (path string) of a row, e.g. "LR". */
export function leafPath(root: TreeNode, cols: Float32Array[], row: number) {
  let node = root,
    path = "";
  while (!node.leaf) {
    const left = cols[node.feature][row] <= node.threshold;
    path += left ? "L" : "R";
    node = left ? node.left : node.right;
  }
  return path;
}
export function leaves(root: TreeNode, path = ""): Array<{ path: string; node: Extract<TreeNode, { leaf: true }> }> {
  return root.leaf ? [{ path, node: root }] : [...leaves(root.left, path + "L"), ...leaves(root.right, path + "R")];
}
export function describeLeaf(root: TreeNode, path: string, names: string[]) {
  const parts: string[] = [];
  let node = root;
  for (const step of path) {
    if (node.leaf) break;
    parts.push(`${names[node.feature]} ${step === "L" ? "≤" : ">"} ${Number(node.threshold.toPrecision(4))}`);
    node = step === "L" ? node.left : node.right;
  }
  return parts.join(" & ") || "(전체)";
}

/* ------------------------------------------------------------- walk forward */

export type Trade = { entry: number; exit: number; day: number; net: number; gross: number; side: number; filled: boolean; row: number };
export type FoldReport = {
  fold: number;
  trainRows: number;
  validRows: number;
  selectedLeaves: string[];
  /** Best leaf mean net outcome ON THE TRAINING rows (in-sample; what the fit could find at all), percent. */
  bestTrainLeafNetPct: number;
  trades: number;
  meanNetPct: number;
  /** Mean over validation days of the day's summed trade nets (percent of position notional; no-trade days = 0). */
  dailyMeanPct: number;
};
export type WalkForward = {
  folds: FoldReport[];
  trades: number;
  tradesPerDay: number;
  meanNetPct: number;
  meanNet2xPct: number;
  dailyMeanPct: number;
  dailyMean2xPct: number;
  dailyT: number;
  positiveFolds: number;
  /** Max over folds of the best in-sample leaf mean net outcome, percent: <0 means no leaf was profitable even in training. */
  bestTrainLeafNetPct: number;
  candidateSplits: number;
  validationDays: number;
  /** Per validation day: the day's summed trade net and the same trades under doubled costs (no-trade days are 0). */
  daily: Array<{ key: number; net: number; net2: number }>;
  /** Every selected validation signal in order, including orders that did not fill (filled = false, net 0). */
  signals: Trade[];
};

export type WalkForwardInput = {
  bars: CTBar[];
  day: DayInfo;
  labels: MoveLabels;
  features: MoveFeatureTable;
  costPct: number;
  folds?: number;
  depth?: number;
  /** Train on every Nth valid entry (adjacent minutes are nearly the same sample). */
  trainStride?: number;
  /**
   * One tree per side (e.g. [long, short]) on the same features and folds; `labels` is ignored when given. At a validation
   * minute where several sides' leaves are selected, the side whose selected leaf had the higher TRAINING mean net wins
   * (ties: the earlier side). Still one position at a time.
   */
  sides?: MoveLabels[];
  /** Prefixes for selectedLeaves when there are several sides (default "s0:", "s1:" …). */
  sideNames?: string[];
};

/**
 * Expanding-window walk-forward. The timeline is cut into folds+1 blocks of whole days; fold f
 * trains on blocks 0..f and is scored on block f+1 only. Training entries whose trade is still
 * open when the validation block starts are purged. A leaf is "selected" when its TRAINING mean
 * net outcome is positive; validation trades are then taken one at a time (no overlap).
 */
export function walkForward(input: WalkForwardInput): WalkForward {
  const { bars, day, features, costPct } = input,
    folds = input.folds ?? 4,
    depth = input.depth ?? 3,
    stride = input.trainStride ?? 1;
  const sides = input.sides ?? [input.labels];
  const prefix = (s: number) => (sides.length > 1 ? (input.sideNames?.[s] ?? `s${s}`) + ":" : "");
  const n = bars.length;
  const dayKeys = [...new Set(Array.from(day.key).filter((k) => k >= 0))].sort((a, b) => a - b);
  const blocks = folds + 1;
  const dayBlock = new Map<number, number>();
  dayKeys.forEach((k, i) => dayBlock.set(k, Math.min(blocks - 1, Math.floor((i * blocks) / dayKeys.length))));
  const nets = sides.map((labels) => {
    if (labels.netPct) return labels.netPct;
    const net = new Float32Array(n);
    for (let i = 0; i < n; i++) net[i] = labels.label[i] < 0 ? NaN : labels.grossPct[i] - costPct;
    return net;
  });
  const net2Of = (s: number, i: number) => {
    const labels = sides[s];
    return labels.net2Pct ? labels.net2Pct[i] : labels.grossPct[i] - 2 * costPct;
  };
  const filledOf = (s: number, i: number) => !sides[s].filled || sides[s].filled![i] === 1;
  // A missing swing just means "no swing in the window" and stays a (top-bin) value; any other NaN drops the row.
  const required = features.cols.filter((_, c) => !features.names[c].includes("swing_"));
  const featureOk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!sides.some((labels) => labels.label[i] >= 0)) continue;
    let ok = 1;
    for (const c of required) if (c[i] !== c[i]) { ok = 0; break; }
    featureOk[i] = ok;
  }
  const blockOf = new Int8Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (day.key[i] >= 0) blockOf[i] = dayBlock.get(day.key[i])!;
  const report: FoldReport[] = [];
  const all: Trade[] = [];
  let candidateSplits = 0,
    validationDays = 0;
  const dayTotals = new Map<number, { net: number; net2: number }>();
  for (let f = 0; f < folds; f++) {
    const validBlock = f + 1;
    let validStart = n;
    for (let i = 0; i < n; i++)
      if (blockOf[i] === validBlock) {
        validStart = i;
        break;
      }
    const foldDays = dayKeys.filter((k) => dayBlock.get(k) === validBlock);
    validationDays += foldDays.length;
    const valid: number[] = [];
    for (let i = 0; i < n; i++) if (featureOk[i] && day.key[i] >= 0 && blockOf[i] === validBlock) valid.push(i);
    let trainRowsTotal = 0;
    // Per side: its own training rows (purged on its own exits), tree, selected leaves.
    const fitted = sides.map((labels, s) => {
      const train: number[] = [];
      let seen = 0;
      for (let i = 0; i < n; i++) {
        if (!featureOk[i] || labels.label[i] < 0 || day.key[i] < 0) continue;
        // Purge: the trade must have closed before the validation block opens.
        if (blockOf[i] <= f && labels.exitIndex[i] < validStart && seen++ % stride === 0) train.push(i);
      }
      trainRowsTotal += train.length;
      const trainDays = new Set(train.map((i) => day.key[i])).size;
      const minLeaf = Math.max(20, Math.ceil(trainDays / stride));
      if (train.length < minLeaf * 4) return null;
      const grown = growTree(features.cols, Int32Array.from(train), labels.label, nets[s], { depth, minLeaf });
      candidateSplits += grown.candidateSplits;
      const treeLeaves = leaves(grown.root);
      const selected = new Map(treeLeaves.filter((l) => l.node.net > 0).map((l) => [l.path, l.node.net]));
      return { root: grown.root, treeLeaves, selected };
    });
    const sideValid = (s: number, i: number) => sides[s].label[i] >= 0;
    if (fitted.every((x) => x === null) || !valid.length) {
      report.push({ fold: f, trainRows: trainRowsTotal, validRows: valid.length, selectedLeaves: [], bestTrainLeafNetPct: NaN, trades: 0, meanNetPct: 0, dailyMeanPct: 0 });
      for (const k of foldDays) if (!dayTotals.has(k)) dayTotals.set(k, { net: 0, net2: 0 });
      continue;
    }
    const trades: Trade[] = [];
    let freeAt = -1;
    for (const i of valid) {
      if (i <= freeAt) continue;
      let pick = -1,
        pickNet = -Infinity;
      for (let s = 0; s < sides.length; s++) {
        const fit = fitted[s];
        if (!fit || !sideValid(s, i)) continue;
        const leafNet = fit.selected.get(leafPath(fit.root, features.cols, i));
        if (leafNet !== undefined && leafNet > pickNet) {
          pick = s;
          pickNet = leafNet;
        }
      }
      if (pick < 0) continue;
      const labels = sides[pick];
      trades.push({ entry: i + 1, exit: labels.exitIndex[i], day: day.key[i], net: nets[pick][i], gross: labels.grossPct[i], side: pick, filled: filledOf(pick, i), row: i });
      freeAt = labels.exitIndex[i];
    }
    for (const k of foldDays) if (!dayTotals.has(k)) dayTotals.set(k, { net: 0, net2: 0 });
    for (const t of trades) {
      const d = dayTotals.get(t.day)!;
      d.net += t.net;
      d.net2 += net2Of(t.side, t.row);
    }
    all.push(...trades);
    const fills = trades.filter((t) => t.filled);
    const foldDaily = foldDays.map((k) => dayTotals.get(k)!.net);
    report.push({
      fold: f,
      trainRows: trainRowsTotal,
      validRows: valid.length,
      selectedLeaves: fitted.flatMap((fit, s) => (fit ? [...fit.selected.keys()].map((p) => prefix(s) + describeLeaf(fit.root, p, features.names)) : [])),
      bestTrainLeafNetPct: Math.max(...fitted.flatMap((fit) => (fit ? fit.treeLeaves.map((l) => l.node.net) : []))),
      trades: fills.length,
      meanNetPct: fills.length ? fills.reduce((s, t) => s + t.net, 0) / fills.length : 0,
      dailyMeanPct: foldDaily.reduce((s, x) => s + x, 0) / Math.max(1, foldDaily.length),
    });
  }
  const daily = [...dayTotals.values()];
  const fills = all.filter((t) => t.filled);
  const dailyMean = daily.reduce((s, d) => s + d.net, 0) / Math.max(1, daily.length),
    dailyMean2 = daily.reduce((s, d) => s + d.net2, 0) / Math.max(1, daily.length),
    variance = daily.reduce((s, d) => s + (d.net - dailyMean) ** 2, 0) / Math.max(1, daily.length - 1);
  return {
    folds: report,
    trades: fills.length,
    tradesPerDay: fills.length / Math.max(1, validationDays),
    meanNetPct: fills.length ? fills.reduce((s, t) => s + t.net, 0) / fills.length : 0,
    meanNet2xPct: fills.length ? fills.reduce((s, t) => s + net2Of(t.side, t.row), 0) / fills.length : 0,
    dailyMeanPct: dailyMean,
    dailyMean2xPct: dailyMean2,
    dailyT: variance > 0 ? dailyMean / Math.sqrt(variance / daily.length) : 0,
    positiveFolds: report.filter((r) => r.dailyMeanPct > 0).length,
    bestTrainLeafNetPct: Math.max(...report.map((r) => r.bestTrainLeafNetPct).filter(Number.isFinite), -Infinity),
    candidateSplits,
    validationDays,
    daily: [...dayTotals.entries()].map(([key, d]) => ({ key, net: d.net, net2: d.net2 })).sort((a, b) => a.key - b.key),
    signals: all,
  };
}

/** Base rate of the label over valid entries: share positive and positives per day. */
export function baseRate(labels: MoveLabels, day: DayInfo, costPct: number) {
  let valid = 0,
    pos = 0,
    sumNet = 0;
  const days = new Set<number>();
  for (let i = 0; i < labels.label.length; i++) {
    if (labels.label[i] < 0) continue;
    valid++;
    pos += labels.label[i];
    sumNet += labels.grossPct[i] - costPct;
    days.add(day.key[i]);
  }
  return { valid, positiveShare: valid ? pos / valid : 0, positivesPerDay: pos / Math.max(1, days.size), unconditionalNetPct: valid ? sumNet / valid : 0, days: days.size };
}
