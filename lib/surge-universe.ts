/**
 * Reconstructing "who could have been surging" on a day that already happened.
 *
 * Toss's `/api/v1/rankings` answers this for *now* only — no as-of parameter —
 * so it is the live feed, not the history. Massive's grouped-daily endpoint
 * (`/v2/aggs/grouped/locale/us/market/stocks/{date}`) returns one day's OHLCV for
 * every US ticker in one call, which is enough to say whose minutes could hold a
 * same-day event and must be downloaded. The event itself is decided from those
 * minutes (`lib/surge-observation.ts`); a daily bar is never a signal.
 *
 * The network call itself lives in `lib/surge-market.ts`; everything here is
 * pure so the filters can be tested without a key.
 *
 * Two facts about that endpoint shape everything below:
 *
 * - **Entitlement is exactly two years back**, rolling. 2024-09-23 answers today
 *   and 2024-09-18 returns 403. Anything older cannot be researched here.
 * - **Five calls a minute**, shared with every other Massive call.
 *
 * **Prices here are unadjusted, and that is the whole reason this comment
 * exists.** Split-adjusted history is computed backwards from today, so a stock
 * that reverse-split 9:1 six months after a session shows that session's $4.47
 * close as $40.23. Two things break at once: the number on screen is not the
 * price anyone could trade, and the tradability filters — the $1 floor, the
 * $500 ceiling, whole-share affordability on $1,000 — end up applied to a price
 * that did not exist yet, which is future information deciding the past. So the
 * loader asks for `adjusted=false`.
 *
 * The cost of that choice is handled rather than ignored: a split between the
 * previous close and the day makes a raw move meaningless (a 1:10 reverse split
 * reads as +900%). The splits from `/v3/reference/splits` are passed in and those
 * names are dropped for that day instead of becoming events.
 */

import { isExcludedInstrument } from "./trade-slots.ts";
import { SURGE_OBSERVATION } from "./surge-observation.ts";
import type { SurgeCandidate, SurgePool } from "./surge-spec.ts";

/** Massive's grouped-daily row, Polygon-shaped. The network call lives in `lib/surge-market.ts`. */
export type GroupedRow = { T?: string; o?: number; h?: number; l?: number; c?: number; v?: number; n?: number };

export type MarketRow = {
  symbol: string;
  high?: number;
  low?: number;
  open: number;
  close: number;
  volume: number;
  dollarVolume: number;
};

/**
 * Who is allowed into a pool at all, before any rule sees it. These are not
 * tuning knobs for the agent: a $0.30 ticker that "gained 80%" moved one tick,
 * and a name with $200k of volume cannot absorb a $1,000 order without being
 * the reason it moved.
 */
export const SURGE_FILTERS = {
  minPriceUsd: 1,
  maxPriceUsd: 500,
  minDollarVolumeUsd: 5_000_000,
  /** Nasdaq's own test symbols print real-looking 140% moves every day. */
  testTicker: /^(Z[A-Z]ZZT|ZBZX|ZBZZT|ZTEST|ZEXIT|ZIEXT|ZWZZT|ZXIET)$/,
  /** Five-letter tickers ending in W or U are warrants and units: wide, thin, and not the thesis. */
  derivativeSuffix: /^[A-Z]{4}[WU]$/,
} as const;

export function tradableTicker(symbol: string) {
  if (!symbol || symbol.length > 6) return false;
  if (!/^[A-Z][A-Z0-9]*$/.test(symbol)) return false;
  if (SURGE_FILTERS.testTicker.test(symbol)) return false;
  if (SURGE_FILTERS.derivativeSuffix.test(symbol)) return false;
  return true;
}

/** The market's session, filtered to names a $1,000 account could actually trade. */
export function toMarketRows(results: GroupedRow[], keepAllCloses = false): MarketRow[] {
  const rows: MarketRow[] = [];
  for (const row of results) {
    const symbol = row.T?.toUpperCase();
    if (!symbol || !tradableTicker(symbol)) continue;
    const close = row.c, open = row.o, volume = row.v;
    if (!Number.isFinite(close) || !Number.isFinite(open) || !Number.isFinite(volume)) continue;
    if (!keepAllCloses && (!(close! >= SURGE_FILTERS.minPriceUsd) || !(close! <= SURGE_FILTERS.maxPriceUsd))) continue;
    const dollarVolume = close! * volume!;
    if (!keepAllCloses && dollarVolume < SURGE_FILTERS.minDollarVolumeUsd) continue;
    if (!(close! > 0) || volume! < 0) continue;
    rows.push({ symbol, high: row.h, low: row.l, open: open!, close: close!, volume: volume!, dollarVolume });
  }
  return rows.sort((left, right) => left.symbol.localeCompare(right.symbol));
}

/** Compact wire form for the per-session close index kept in D1. */
export type CompactMarketRow = [string, number, number, number?, number?, number?];

export function compactMarket(rows: MarketRow[]): CompactMarketRow[] {
  return rows.map((row) => [row.symbol, Number(row.close.toFixed(4)), Math.round(row.volume), row.high ?? row.close, row.low ?? row.close, row.open]);
}

export function closeIndex(rows: CompactMarketRow[]) {
  return new Map(rows.map(([symbol, close]) => [symbol, close]));
}

export function expandMarket(rows: CompactMarketRow[]): MarketRow[] {
  return rows.map(([symbol, close, volume, high, low, open]) => ({
    symbol, close, high, low, open: open ?? close, volume, dollarVolume: close * volume,
  }));
}

/** The oldest session the grouped-daily entitlement will answer for. */
export function surgeHistoryFloor(reference = new Date().toISOString().slice(0, 10)) {
  const value = new Date(`${reference}T00:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() - 2);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

/**
 * Which names' minutes to download for a day — a download envelope, NEVER a
 * signal or a rank. A same-day event (`observeSurgeDay`) needs a minute close
 * ≥ +10% (or ≤ −10%) at $1–$500 with ≥ $1M of regular-session tape behind it,
 * so a name can only have one if its whole-day high (or low) reached that move,
 * its high reached $1, and high × volume — an upper bound on any regular-session
 * dollar volume — reached $1M. Every name that could have an event is kept;
 * whether it had one, and when, is decided later from its minutes alone.
 */
export function observationUniverse(date: string, day: MarketRow[], previous: CompactMarketRow[], splits: ReadonlySet<string>) {
  const policy = SURGE_OBSERVATION;
  const prior = new Map(previous.map(row => [row[0], row]));
  const pools: Record<SurgePool, SurgeCandidate[]> = { gainers: [], losers: [] };
  for (const row of day) {
    const base = prior.get(row.symbol);
    if (!base || !(base[1] > 0) || splits.has(row.symbol) || !tradableTicker(row.symbol) || isExcludedInstrument(row.symbol)) continue;
    if (!Number.isFinite(row.high) || !Number.isFinite(row.low)) throw new Error("당일 관측에는 전체 종목 원주가 고가·저가 이력이 필요합니다.");
    if (row.high! < policy.minPrice || row.low! > policy.maxPrice || row.high! * row.volume < policy.minSessionDollarVolume) continue;
    const candidate: SurgeCandidate = { symbol: row.symbol, rank: 0, changePct: 0, prevClose: base[1],
      priorDollarVolume: Math.round(base[1] * base[2]), dollarVolume: 0, volume: 0, rankedOn: date };
    if ((row.high! / base[1] - 1) * 100 >= policy.changePct) pools.gainers.push(candidate);
    if ((row.low! / base[1] - 1) * 100 <= -policy.changePct) pools.losers.push(candidate);
  }
  return pools;
}
