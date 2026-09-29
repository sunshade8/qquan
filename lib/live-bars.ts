/**
 * Live strategy-resolution bars built from Toss minute candles.
 *
 * The backtest decides on completed Massive bars, so the live runner has to put
 * the same question to the rule: a bar exists only once its five minutes are
 * over. Toss stamps a 1-minute candle with its *end* time (the candle covers
 * [timestamp − 1m, timestamp)), and a bucket is complete only when the clock has
 * passed its end — a still-forming bar would be exactly the lookahead the
 * backtest was fixed to forbid.
 *
 * Pure: imported by the Node test runner.
 */

import type { IntradayBar } from "./relay-engine.ts";
import { easternParts } from "./market-clock.ts";

export type MinuteCandle = { endMs: number; open: number; high: number; low: number; close: number; volume: number };

const MINUTE = 60_000;
export const BAR_MS = 5 * MINUTE;

type RawCandle = { timestamp?: string; openPrice?: string; highPrice?: string; lowPrice?: string; closePrice?: string; volume?: string };

export function parseTossCandle(raw: RawCandle): MinuteCandle | null {
  const endMs = Date.parse(raw.timestamp ?? "");
  const [open, high, low, close] = [raw.openPrice, raw.highPrice, raw.lowPrice, raw.closePrice].map(Number);
  if (!Number.isFinite(endMs) || ![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) return null;
  return { endMs, open, high, low, close, volume: Number(raw.volume) || 0 };
}

/** Start of the most recent 5-minute bar that has fully closed at `nowMs`. */
export type BarIntervalMinutes = 1 | 3 | 5;
export function latestCompleteBarStart(nowMs: number, step: BarIntervalMinutes = 5) {
  const size = step * MINUTE;
  return Math.floor(nowMs / size) * size - size;
}

/** Only fully elapsed, complete minute buckets. Duplicate minutes never inflate volume. */
export function aggregateMinuteCandles(candles: MinuteCandle[], nowMs: number, step: BarIntervalMinutes = 5): IntradayBar[] {
  const unique = new Map(candles.map(candle => [candle.endMs, candle]));
  const size = step * MINUTE;
  const buckets = new Map<number, MinuteCandle[]>();
  for (const candle of unique.values()) {
    if (candle.endMs % MINUTE || candle.endMs > nowMs) continue;
    if (![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) ||
        candle.low <= 0 || candle.volume < 0 || candle.high < Math.max(candle.open, candle.close) ||
        candle.low > Math.min(candle.open, candle.close)) continue;
    const start = Math.floor((candle.endMs - MINUTE) / size) * size;
    if (start + size > nowMs) continue;
    const list = buckets.get(start) ?? [];
    list.push(candle); buckets.set(start, list);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).flatMap(([start, list]) => {
    list.sort((a, b) => a.endMs - b.endMs);
    if (list.length !== step || list.some((c, index) => c.endMs !== start + (index + 1) * MINUTE)) return [];
    const et = easternParts(start);
    return [{ date: et.date, time: et.time, open: list[0].open,
      high: Math.max(...list.map(c => c.high)), low: Math.min(...list.map(c => c.low)),
      close: list.at(-1)!.close, volume: list.reduce((sum, c) => sum + c.volume, 0) }];
  });
}

export const aggregateFiveMinute = (candles: MinuteCandle[], nowMs: number) => aggregateMinuteCandles(candles, nowMs, 5);

/**
 * Low and high traded strictly after `fromMs`. Only candles that *began* after
 * it count: a candle straddling the fill carries prices from before the
 * position existed, and a stop must not fire on those.
 */
export function rangeAfter(candles: MinuteCandle[], fromMs: number, toMs: number) {
  const inside = candles.filter((candle) => candle.endMs - MINUTE >= fromMs && candle.endMs <= toMs);
  if (!inside.length) return null;
  return { low: Math.min(...inside.map((candle) => candle.low)), high: Math.max(...inside.map((candle) => candle.high)) };
}
