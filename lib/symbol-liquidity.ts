/**
 * Per-symbol trading cost.
 *
 * `lib/broker-costs.ts` carries one slippage number for a liquid large cap,
 * which is the right default for NVDA and badly wrong for the names an intraday
 * rule actually wants. Measured half-spreads differ by a factor of forty across
 * the candidate list, and on a rule that recycles capital three times a day the
 * spread — not the commission — decides whether the strategy clears its costs.
 *
 * Quotes below were sampled from the Toss orderbook on 2026-09-09 outside
 * regular hours, which is the pessimistic end: in-session spreads on these names
 * run roughly a third to a half of these. They are therefore a conservative
 * planning number, and `measuredAt` says when to distrust them.
 */

import { feePerSidePct, TOSS_US_EQUITY } from "./broker-costs.ts";

export type SymbolLiquidity = {
  symbol: string;
  /** Half the quoted bid-ask spread, percent — what one side of a round trip pays. */
  halfSpreadPct: number;
  /** Mean high-low range over the last 60 sessions, percent of close. */
  dailyRangePct: number;
  measuredAt: string;
};

const MEASURED: SymbolLiquidity[] = [
  { symbol: "NVDA", halfSpreadPct: 0.007, dailyRangePct: 3.2, measuredAt: "2026-09-09" },
  { symbol: "RKLB", halfSpreadPct: 0.038, dailyRangePct: 6.87, measuredAt: "2026-09-09" },
  { symbol: "SPCX", halfSpreadPct: 0.069, dailyRangePct: 6.98, measuredAt: "2026-09-09" },
  { symbol: "ASTS", halfSpreadPct: 0.264, dailyRangePct: 7.73, measuredAt: "2026-09-09" },
  { symbol: "ASTX", halfSpreadPct: 0.318, dailyRangePct: 15.74, measuredAt: "2026-09-09" },
  { symbol: "LUNR", halfSpreadPct: 0.445, dailyRangePct: 7.60, measuredAt: "2026-09-09" },
  { symbol: "PL", halfSpreadPct: 0.200, dailyRangePct: 6.91, measuredAt: "2026-09-09" },
];

const BY_SYMBOL = new Map(MEASURED.map((row) => [row.symbol, row]));

/** Unmeasured symbols fall back to the large-cap assumption, not to zero. */
const DEFAULT_HALF_SPREAD_PCT = TOSS_US_EQUITY.assumedSlippagePct / 2;

export function liquidityFor(symbol: string): SymbolLiquidity | null {
  return BY_SYMBOL.get(symbol.toUpperCase()) ?? null;
}

export function halfSpreadPct(symbol: string) {
  return liquidityFor(symbol)?.halfSpreadPct ?? DEFAULT_HALF_SPREAD_PCT;
}

/** Commission plus the spread actually crossed, for one side of a trade. */
export function costPerSidePct(symbol: string) {
  return feePerSidePct() + halfSpreadPct(symbol);
}

export function roundTripPctFor(symbol: string) {
  return costPerSidePct(symbol) * 2 + TOSS_US_EQUITY.secSellFeePct;
}

/**
 * Daily range divided by the round-trip cost — how many times over a normal
 * day's movement pays for one trade. This is the number that decides whether a
 * symbol is worth trading intraday at all, and it separates the candidates far
 * more sharply than the range alone does: ASTX has the widest range on the list
 * and one of the worst ratios.
 */
export function rangeToCostRatio(symbol: string) {
  const liquidity = liquidityFor(symbol);
  if (!liquidity) return null;
  return Number((liquidity.dailyRangePct / roundTripPctFor(symbol)).toFixed(1));
}

export function liquidityTable() {
  return MEASURED
    .map((row) => ({ ...row, roundTripPct: Number(roundTripPctFor(row.symbol).toFixed(4)), rangeToCost: rangeToCostRatio(row.symbol) }))
    .sort((left, right) => (right.rangeToCost ?? 0) - (left.rangeToCost ?? 0));
}
