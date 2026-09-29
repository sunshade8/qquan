/**
 * Minute bars into coarser bars.
 *
 * Massive charges a request rather than a bar, so the 급등주 loader downloads
 * one-minute aggregates once and derives every other resolution here. Buckets
 * are aligned to the hour — a 3-minute bar always starts at :00, :03, :06 — so
 * the grid matches the one the live runner rebuilds from Toss's minute candles.
 * Pure: imported by the Node test runner.
 */

import type { IntradayBar } from "./relay-engine.ts";

export function rollUp(minutes: IntradayBar[], step: number): IntradayBar[] {
  if (step <= 1) return minutes;
  const buckets = new Map<string, IntradayBar>();
  for (const bar of minutes) {
    const total = Number(bar.time.slice(0, 2)) * 60 + Number(bar.time.slice(3));
    const start = total - (total % step);
    const time = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
    const key = `${bar.date} ${time}`;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { date: bar.date, time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
      continue;
    }
    existing.high = Math.max(existing.high, bar.high);
    existing.low = Math.min(existing.low, bar.low);
    existing.close = bar.close;
    existing.volume += bar.volume;
  }
  return [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date) || left.time.localeCompare(right.time));
}

/** Strict buckets shared by same-day research and live execution; missing minutes are not candles. */
export function rollUpComplete(minutes: IntradayBar[], step: number): IntradayBar[] {
  const unique = [...new Map(minutes.map(bar => [`${bar.date}|${bar.time}`, bar])).values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  const expected = new Map<string, Set<number>>();
  for (const bar of unique) {
    const minute = Number(bar.time.slice(0, 2)) * 60 + Number(bar.time.slice(3));
    const start = minute - minute % step;
    const key = `${bar.date}|${start}`;
    const seen = expected.get(key) ?? new Set<number>(); seen.add(minute); expected.set(key, seen);
  }
  return rollUp(unique, step).filter(bar => {
    const start = Number(bar.time.slice(0, 2)) * 60 + Number(bar.time.slice(3));
    return expected.get(`${bar.date}|${start}`)?.size === step;
  });
}
