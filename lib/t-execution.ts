/**
 * Execution and direction for the ceiling measurement (docs/research/ct-ceiling-2026-10-15-execution.md). Pure, no I/O.
 * NOT part of the rule language or the live contract (taker, spot long): this only asks whether a limit-order (maker)
 * execution or a short side would have changed the "no edge after costs" answer of lib/ct-moves.ts.
 *
 * labelExecution mirrors labelMoves (same day grid, same holding cap, same "both in one bar = stop first" rule) and adds:
 *  - side       +1 long, −1 short (target/stop mirrored)
 *  - exec       "taker": enter at the next bar's open, exit at market (labelMoves exactly, for the long side)
 *               "maker": a limit at the decision bar's close P, good for the NEXT bar only; it fills when that bar trades
 *               (volume > 0) and touches P (low ≤ P long / high ≥ P short; "strict": strictly through). Fill price P.
 *               In the fill bar only the stop counts (prices beyond P came after the fill; a high may have come before).
 *               From the bar after: the target is a resting limit (maker fee, filled exactly at the target), the stop
 *               and the time / day-end exit are market orders (taker fee + impact).
 *  - leg costs  per leg: maker fee, or taker fee + one-way impact; netPct / net2Pct carry the 1× / 2× leg costs
 *  - funding    perpetuals only: a settlement s with entryBar.startMs < s ≤ exitBar.startMs was held; pnl −side × rate.
 * An order that did not fill is a valid row with label 0, net 0 and filled = 0 (it occupies the next bar only).
 */
import type { CTBar } from "./t-engine.ts";
import { dayLastIndex, MOVE_REASON, type DayInfo, type MoveLabels } from "./t-moves.ts";
import { ctThroughHit } from "./t-limit-execution.ts";

export const EXEC_REASON = { ...MOVE_REASON, unfilled: 5 } as const;

export type ExecutionOptions = {
  side: 1 | -1;
  exec: "taker" | "maker";
  makerFeePct: number;
  takerFeePct: number;
  /** One-way taker impact (spread + slippage), percent. Maker legs pay none. */
  impactPct: number;
  k: number;
  m: number;
  holdBars: number;
  /** Funding settlements (ms, sorted, floored to the minute) and rates (fraction, e.g. 0.0001). */
  funding?: { times: Float64Array; rates: Float64Array };
  /** Trade-through instead of touch for the maker entry and the maker target (sensitivity only). */
  strict?: boolean;
  /**
   * With `strict` and a tick size: the through-the-price fill rule of the limit-only contracts (lib/t-limit-execution.ts) —
   * the bar must trade at least `penetrationTicks` (minimum 1) ticks through the price. Without `tickSize`, strict stays the plain `<` / `>`.
   */
  penetrationTicks?: number;
  tickSize?: number;
};

/** Distance unit c of the label: taker 2 × (taker + impact); maker = maker entry + taker exit + impact (conservative). */
export function labelCostPct(o: Pick<ExecutionOptions, "exec" | "makerFeePct" | "takerFeePct" | "impactPct">) {
  return o.exec === "taker" ? 2 * (o.takerFeePct + o.impactPct) : o.makerFeePct + o.takerFeePct + o.impactPct;
}

export type ExecutionLabels = MoveLabels & { netPct: Float32Array; net2Pct: Float32Array; filled: Uint8Array; costPct: number; fundingPct: Float32Array };

/** Sum of funding rates over settlements s with a < s ≤ b. */
export function fundingBetween(f: { times: Float64Array; rates: Float64Array }, a: number, b: number) {
  const first = upper(f.times, a),
    last = upper(f.times, b);
  let sum = 0;
  for (let i = first; i < last; i++) sum += f.rates[i];
  return sum;
}
/** First index with times[i] > t. */
function upper(times: Float64Array, t: number) {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function labelExecution(bars: CTBar[], day: DayInfo, o: ExecutionOptions): ExecutionLabels {
  const n = bars.length,
    label = new Int8Array(n).fill(-1),
    grossPct = new Float32Array(n),
    netPct = new Float32Array(n).fill(NaN),
    net2Pct = new Float32Array(n).fill(NaN),
    fundingPct = new Float32Array(n),
    filled = new Uint8Array(n),
    exitIndex = new Int32Array(n).fill(-1),
    reason = new Uint8Array(n),
    last = dayLastIndex(bars, day),
    costPct = labelCostPct(o),
    up = (o.k * costPct) / 100,
    down = (o.m * costPct) / 100,
    long = o.side === 1,
    maker = o.exec === "maker",
    takerLeg = o.takerFeePct + o.impactPct,
    entryLeg = maker ? o.makerFeePct : takerLeg;
  for (let i = 0; i + 1 < n; i++) {
    const e = i + 1;
    if (day.key[i] < 0 || day.key[e] !== day.key[i] || bars[e].startMs !== bars[i].endMs) continue;
    const dayLast = last[e];
    if (dayLast < e) continue;
    const entry = maker ? bars[i].close : bars[e].open;
    if (maker) {
      const b = bars[e];
      const touched = o.strict && o.tickSize
        ? ctThroughHit(long ? "buy" : "sell", entry, b, o.tickSize, o.penetrationTicks ?? 1)
        : long ? (o.strict ? b.low < entry : b.low <= entry) : o.strict ? b.high > entry : b.high >= entry;
      if (!(b.volume > 0 && touched)) {
        label[i] = 0;
        netPct[i] = 0;
        net2Pct[i] = 0;
        exitIndex[i] = e;
        reason[i] = EXEC_REASON.unfilled;
        continue;
      }
    }
    const stop = long ? entry * (1 - down) : entry * (1 + down),
      target = long ? entry * (1 + up) : entry * (1 - up),
      end = Math.min(dayLast, o.holdBars === Infinity ? dayLast : e + o.holdBars - 1);
    let exit = -1,
      price = 0,
      why: number = EXEC_REASON.invalid;
    for (let j = e; j <= end; j++) {
      const b = bars[j];
      if (j > e && b.startMs !== bars[j - 1].endMs) break;
      const fillBar = maker && j === e;
      if (long ? b.low <= stop : b.high >= stop) {
        exit = j;
        // In the fill bar the price moved continuously from P through the stop; later bars may gap through it.
        price = fillBar ? stop : long ? Math.min(stop, b.open) : Math.max(stop, b.open);
        why = EXEC_REASON.stop;
        break;
      }
      if (!fillBar) {
        const hit = maker
          ? o.strict && o.tickSize
            ? ctThroughHit(long ? "sell" : "buy", target, b, o.tickSize, o.penetrationTicks ?? 1)
            : long ? (o.strict ? b.high > target : b.high >= target) : o.strict ? b.low < target : b.low <= target
          : long ? b.high >= target : b.low <= target;
        if (hit) {
          exit = j;
          price = maker ? target : long ? (b.open >= target ? b.open : target) : b.open <= target ? b.open : target;
          why = EXEC_REASON.target;
          break;
        }
      }
      if (j === end) {
        exit = j;
        price = b.close;
        why = end === dayLast && (o.holdBars === Infinity || e + o.holdBars - 1 >= dayLast) ? EXEC_REASON.day_end : EXEC_REASON.time;
      }
    }
    if (exit < 0) continue;
    // Same float32 rounding as labelMoves + walkForward (gross stored as float32, then the cost subtracted).
    const gross = Math.fround(long ? (price / entry - 1) * 100 : (1 - price / entry) * 100);
    const exitLeg = maker && why === EXEC_REASON.target ? o.makerFeePct : takerLeg;
    const fund = o.funding ? -o.side * fundingBetween(o.funding, bars[e].startMs, bars[exit].startMs) * 100 || 0 : 0;
    label[i] = why === EXEC_REASON.target ? 1 : 0;
    grossPct[i] = gross;
    filled[i] = 1;
    fundingPct[i] = fund;
    netPct[i] = gross - (entryLeg + exitLeg) + fund;
    net2Pct[i] = gross - 2 * (entryLeg + exitLeg) + fund;
    exitIndex[i] = exit;
    reason[i] = why;
  }
  return { label, grossPct, exitIndex, reason, netPct, net2Pct, filled, costPct, fundingPct };
}

/**
 * Directional markout of a decision at bar i: side × (close[i+h] / close[i] − 1), basis points, or NaN when bars i..i+h
 * are not one unbroken run of the same day. For a maker order the fill price IS close[i], so this is the post-fill markout.
 */
export function markoutBp(bars: CTBar[], day: DayInfo, i: number, side: 1 | -1, h: number) {
  const j = i + h;
  if (j >= bars.length || day.key[j] !== day.key[i] || bars[j].endMs - bars[i].endMs !== h * 60_000) return NaN;
  return side * (bars[j].close / bars[i].close - 1) * 10_000;
}
