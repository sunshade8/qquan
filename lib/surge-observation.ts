/**
 * What "this stock is surging (or crashing) today" means, point in time, ET.
 *
 * The owner's hypothesis is about the SAME day: names that are making a big
 * move today tend to move alike for the rest of today. So an event is not a
 * ranking computed after the close — it is the first completed regular-session
 * minute at which the move and the tape behind it were both already visible:
 *
 * - the minute's close is ≥ +10% (gainers) or ≤ −10% (losers) from the previous
 *   regular close,
 * - that close is a price a $1,000 account can trade ($1–$500),
 * - and at least $1M has traded in the regular session up to and including
 *   that minute — a +40% print on $30k of tape is one order, not a surge.
 *
 * The backtest replays Massive's one-minute bars through `observeSurgeDay`; the
 * live runner replays Toss's one-minute candles through the same function. A
 * daily high or low is never a signal: it only decides which names' minutes are
 * worth downloading (`observationUniverse` in `lib/surge-universe.ts`).
 */
import type { SurgeCandidate, SurgePool } from "./surge-spec.ts";
import type { IntradayBar } from "./relay-engine.ts";
import { isExcludedInstrument } from "./trade-slots.ts";

export const SURGE_OBSERVATION = {
  version: 2,
  /** Regular session only: extended-hours prints are too thin to define a surge. */
  from: "09:30",
  to: "16:00",
  changePct: 10,
  minPrice: 1,
  maxPrice: 500,
  /** Regular-session dollar volume through the observation minute. */
  minSessionDollarVolume: 1_000_000,
} as const;

const minuteOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export function minuteEnd(time: string, step = 1) {
  const value = minuteOf(time) + step;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/** The regular-session facts at the moment a move becomes an event. */
type Baseline = Pick<SurgeCandidate, "symbol" | "prevClose" | "priorDollarVolume">;

/**
 * Walks one day's completed one-minute bars in order and returns the first
 * minute that is an event, or null. Only bars at or before that minute are
 * read: the cumulative volume and the session open come from the tape so far.
 */
export function observeSurgeDay(baseline: Baseline, minutes: IntradayBar[], pool: SurgePool): SurgeCandidate | null {
  const policy = SURGE_OBSERVATION;
  if (isExcludedInstrument(baseline.symbol) || !(baseline.prevClose > 0)) return null;
  let sessionOpen: number | null = null;
  let dollarVolume = 0;
  let volume = 0;
  for (const bar of minutes) {
    if (bar.time < policy.from || bar.time >= policy.to) continue;
    if (![bar.open, bar.close, bar.volume].every(Number.isFinite) || !(bar.close > 0)) continue;
    sessionOpen ??= bar.open;
    dollarVolume += bar.close * bar.volume;
    volume += bar.volume;
    if (bar.close < policy.minPrice || bar.close > policy.maxPrice || dollarVolume < policy.minSessionDollarVolume) continue;
    const changePct = (bar.close / baseline.prevClose - 1) * 100;
    if (pool === "gainers" ? changePct < policy.changePct : changePct > -policy.changePct) continue;
    return {
      ...baseline,
      rank: 0,
      changePct: Number(changePct.toFixed(4)),
      dollarVolume: Math.round(dollarVolume),
      volume: Math.round(volume),
      rankedOn: bar.date,
      observedAt: minuteEnd(bar.time),
      observedPrice: bar.close,
      sessionOpen,
    };
  }
  return null;
}

/**
 * The events visible at `through` (an "HH:MM" clock, the close of the decision
 * bar). An event stays visible after a pullback — it happened — and a later
 * event can never change an earlier one. `rank` orders the visible events by
 * the size of the move at which each was first seen.
 */
export function observedCandidates(candidates: SurgeCandidate[], date: string, through: string, pool: SurgePool) {
  return candidates.filter(c => c.rankedOn === date && !!c.observedAt && c.observedAt <= through && (!c.availableAt || c.availableAt <= through) &&
    !isExcludedInstrument(c.symbol) && (pool === "gainers" ? c.changePct >= SURGE_OBSERVATION.changePct : c.changePct <= -SURGE_OBSERVATION.changePct))
    .sort((a, b) => (pool === "gainers" ? b.changePct - a.changePct : a.changePct - b.changePct) || a.symbol.localeCompare(b.symbol))
    .map((c, i) => ({ ...c, rank: i + 1 }));
}
