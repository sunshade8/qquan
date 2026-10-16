/**
 * Order-book math for the CT cost profile. Pure functions: the measurement script
 * (scripts/data/measure-orderbook.mjs) feeds public snapshots through them and stores the
 * result; lib/ct-costs.ts documents the p90 of what was stored.
 *
 * Impact is reported against the MID price, which is how replayCT charges a fill:
 * `spreadPct / 2 + slippagePct` per side (see ctImpactPct). A market buy of N quote units
 * walks the asks; the volume-weighted fill over mid is the whole per-side price impact.
 */
export type BookLevel = { price: number; size: number };
export type BookSnapshot = { bids: BookLevel[]; asks: BookLevel[] };

/** Volume-weighted fill of a market order for `notional` quote units; null if the book is too thin. */
export function walkBook(levels: BookLevel[], notional: number): number | null {
  let remaining = notional,
    base = 0;
  for (const { price, size } of levels) {
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(remaining, price * size);
    base += take / price;
    remaining -= take;
    if (remaining <= 1e-9) return notional / base;
  }
  return null;
}

export type BookImpact = {
  mid: number;
  spreadBp: number;
  /** Per-side impact versus mid, basis points; null when the visible book cannot absorb the order. */
  buyBp: number | null;
  sellBp: number | null;
};

export function bookImpact(book: BookSnapshot, notional: number): BookImpact | null {
  const bid = book.bids[0]?.price,
    ask = book.asks[0]?.price;
  if (!(bid > 0) || !(ask > 0) || bid >= ask) return null;
  const mid = (bid + ask) / 2,
    buy = walkBook(book.asks, notional),
    sell = walkBook(book.bids, notional);
  return {
    mid,
    spreadBp: ((ask - bid) / mid) * 1e4,
    buyBp: buy === null ? null : (buy / mid - 1) * 1e4,
    sellBp: sell === null ? null : (1 - sell / mid) * 1e4,
  };
}

/** Linear-interpolated quantile of an unsorted list. */
export function quantile(values: number[], q: number) {
  const xs = [...values].sort((a, b) => a - b);
  if (!xs.length) return NaN;
  const at = (xs.length - 1) * q,
    lo = Math.floor(at),
    hi = Math.ceil(at);
  return xs[lo] + (xs[hi] - xs[lo]) * (at - lo);
}
