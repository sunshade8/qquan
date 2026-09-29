/**
 * What a round trip in a surging small cap actually costs.
 *
 * `lib/symbol-liquidity.ts` carries measured half-spreads for seven names the
 * relay board trades and falls back to a large-cap assumption for everything
 * else. That fallback is the wrong default here and dangerously so: the top of
 * the day's gainer list is $1–$20 names where one cent of tick is 0.05%–1% of
 * the price, and a backtest that charges them NVDA's spread will manufacture an
 * edge that does not survive the first live fill.
 *
 * So this module prices the two frictions a surge name really has, from the
 * only two facts the daily bar gives us — price and dollar volume:
 *
 * - **Tick.** The book cannot be tighter than one cent. Crossing it costs half a
 *   cent per side, which is `0.5 / price` percent. At $1 that is 0.5% a side.
 * - **Depth.** Thinner names quote wider than the tick. The term below is
 *   0.25% a side at $10M traded and falls with the square root of dollar volume,
 *   so a $100M day prices at ~0.08% and a $1B day at ~0.025%.
 *
 * Both are **modelled assumptions, not measured quotes** — OHLCV contains no
 * bid, no ask and no queue. They are deliberately pessimistic, every strategy is
 * also replayed at twice these costs before it can be registered, and the
 * numbers here are the single place to correct once real fills exist.
 */

import { feePerSidePct, TOSS_US_EQUITY } from "./broker-costs.ts";
import { liquidityFor } from "./symbol-liquidity.ts";

/** One cent of tick, halved because each side crosses half the quoted spread. */
const TICK_USD = 0.01;
/** Half-spread at $10M of daily dollar volume, percent. Scales as 1/sqrt(volume). */
const DEPTH_AT_10M_PCT = 0.25;
const DEPTH_REFERENCE_USD = 10_000_000;
const MIN_HALF_SPREAD_PCT = 0.02;
const MAX_HALF_SPREAD_PCT = 1.5;

export function surgeHalfSpreadPct(price: number, dollarVolume: number) {
  if (!(price > 0)) return MAX_HALF_SPREAD_PCT;
  const tick = ((TICK_USD / 2) / price) * 100;
  const depth = dollarVolume > 0
    ? DEPTH_AT_10M_PCT / Math.sqrt(dollarVolume / DEPTH_REFERENCE_USD)
    : MAX_HALF_SPREAD_PCT;
  return Math.min(MAX_HALF_SPREAD_PCT, Math.max(MIN_HALF_SPREAD_PCT, tick + depth));
}

/**
 * Commission plus the spread crossed, one side. A name that `symbol-liquidity`
 * has an actual measured quote for uses that instead — a measurement always
 * beats a model.
 */
export function surgeCostPerSidePct(symbol: string, price: number, dollarVolume: number) {
  const measured = liquidityFor(symbol);
  return feePerSidePct() + (measured ? measured.halfSpreadPct : surgeHalfSpreadPct(price, dollarVolume));
}

export function surgeRoundTripPct(symbol: string, price: number, dollarVolume: number) {
  return surgeCostPerSidePct(symbol, price, dollarVolume) * 2 + TOSS_US_EQUITY.secSellFeePct;
}

/**
 * The stop distance below which the round trip eats the whole risk budget. A
 * rule whose stop is inside this is not a rule, it is a fee schedule.
 */
export function minimumViableStopPct(symbol: string, price: number, dollarVolume: number) {
  return Number((surgeRoundTripPct(symbol, price, dollarVolume) * 2).toFixed(4));
}

export const SURGE_COST_MODEL = {
  tickUsd: TICK_USD,
  depthAt10mPct: DEPTH_AT_10M_PCT,
  minHalfSpreadPct: MIN_HALF_SPREAD_PCT,
  maxHalfSpreadPct: MAX_HALF_SPREAD_PCT,
  note: "호가가 아닌 모형 가정입니다. 가격(틱)과 거래대금(깊이)만으로 한쪽 스프레드를 추정하며, 등록 전 비용 2배 재실행을 통과해야 합니다.",
} as const;
