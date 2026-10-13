/**
 * Completed 60 / 240 / 1440-minute bars for ct-pattern-2 conditions, built once from the
 * one-minute bars and looked up by index. Nothing here peeks past `nowMs`: a bar exists only
 * when every one of its minutes is present, and `higherCount` counts bars closed by then.
 *
 * Grids (the only place the market matters):
 *  - crypto: UTC. 60/240-minute buckets start on the UTC hour grid, 1440 is the UTC day.
 *  - stock: the NYSE session. Buckets start at the session open (09:30 ET) and the last one
 *    ends at the session close, so an early-close day or a 390-minute session ends in a shorter
 *    final bar instead of a bar that never completes. 1440 is the whole regular session.
 *
 * Chaining (which bars a lookback window may span):
 *  - crypto: a bar follows the previous one only if it starts where the previous one ended.
 *  - stock: inside a session likewise; across sessions the next calendar session's first bar
 *    follows the previous session's last bar (overnight and weekends are bridged, a missing
 *    session is not), unless a split of that symbol happened in between. Raw prices on both
 *    sides of a split are not comparable, so the window must not cross it.
 */
import { ctStockSession } from "./ct-sessions.ts";
import { sessions as calendar } from "./ct-calendar-data.ts";
import { easternParts, easternWallTimeToEpoch } from "./market-clock.ts";
import type { CTBar } from "./ct-engine.ts";
import type { CTMarket } from "./ct-spec.ts";

export const CT_HIGHER_MINUTES = [60, 240, 1440] as const;
export const isHigherMinutes = (n: number) => (CT_HIGHER_MINUTES as readonly number[]).includes(n);

/** Raw-price discontinuities. A window never spans one; sessions on or after the date are a new chain. */
export const CT_STOCK_SPLITS: Record<string, string[]> = {
  NVDA: ["2021-07-20", "2024-06-10"],
};

export type CTHigherSeries = {
  minutes: number;
  bars: CTBar[];
  /** brokenPrefix[k] = number of i < k with bars[i] not chained to bars[i - 1]. */
  brokenPrefix: Int32Array;
};

let sessionDates: string[] | null = null;
let sessionOrdinal: Map<string, number> | null = null;
function ordinals() {
  if (!sessionDates) {
    sessionDates = Object.keys(calendar).sort();
    sessionOrdinal = new Map(sessionDates.map((d, i) => [d, i]));
  }
  return sessionOrdinal!;
}

type Session = { date: string; openMs: number; closeMs: number; ord: number };
function sessionAt(startMs: number): Session | null {
  const date = easternParts(startMs).date;
  const s = ctStockSession(date);
  const ord = ordinals().get(date);
  if (!s || ord === undefined) return null;
  return { date, openMs: easternWallTimeToEpoch(date, s.open), closeMs: easternWallTimeToEpoch(date, s.close), ord };
}

export function buildHigherSeries(
  base: CTBar[],
  minutes: number,
  market: CTMarket,
  symbol = "",
): CTHigherSeries {
  if (!isHigherMinutes(minutes)) throw new Error(`지원하지 않는 상위 시간대: ${minutes}`);
  const size = minutes * 60_000,
    out: CTBar[] = [],
    broken: number[] = [];
  const splits = market === "stock" ? (CT_STOCK_SPLITS[symbol] ?? []) : [];
  // Chain bookkeeping for the previous emitted bar (stock only).
  let prevSession = -1,
    prevBucket = -1,
    prevLast = false,
    prevDate = "";
  const pushBar = (bar: CTBar, chained: boolean) => {
    out.push(bar);
    broken.push(chained || out.length === 1 ? 0 : 1);
  };
  let group: CTBar[] = [],
    groupStart = -1,
    groupEnd = -1,
    groupSession: Session | null = null,
    groupBucket = 0;
  const flush = () => {
    if (!group.length) return;
    const minutesInGroup = (groupEnd - groupStart) / 60_000;
    let complete = group.length === minutesInGroup;
    for (let i = 1; complete && i < group.length; i++) complete = group[i].startMs === group[i - 1].endMs;
    if (complete) {
      const bar: CTBar = {
        startMs: groupStart,
        endMs: groupEnd,
        open: group[0].open,
        close: group[group.length - 1].close,
        high: Math.max(...group.map((b) => b.high)),
        low: Math.min(...group.map((b) => b.low)),
        volume: group.reduce((s, b) => s + b.volume, 0),
      };
      if (market === "crypto") {
        pushBar(bar, out.length > 0 && out[out.length - 1].endMs === bar.startMs);
      } else {
        const s = groupSession!;
        const last = groupEnd === s.closeMs;
        let chained = false;
        if (out.length) {
          if (prevSession === s.ord) chained = groupBucket === prevBucket + 1;
          else
            chained =
              prevSession + 1 === s.ord &&
              groupBucket === 0 &&
              prevLast &&
              !splits.some((d) => prevDate < d && s.date >= d);
        }
        pushBar(bar, chained);
        prevSession = s.ord;
        prevBucket = groupBucket;
        prevLast = last;
        prevDate = s.date;
      }
    }
    group = [];
  };
  let session: Session | null = null;
  for (const b of base) {
    let start: number, end: number, bucket = 0;
    if (market === "crypto") {
      start = Math.floor(b.startMs / size) * size;
      end = start + size;
    } else {
      if (!session || b.startMs < session.openMs || b.startMs >= session.closeMs) {
        session = sessionAt(b.startMs);
        if (!session || b.startMs < session.openMs || b.startMs >= session.closeMs) continue;
      }
      bucket = Math.floor((b.startMs - session.openMs) / size);
      start = session.openMs + bucket * size;
      end = Math.min(start + size, session.closeMs);
    }
    if (start !== groupStart) {
      flush();
      groupStart = start;
      groupEnd = end;
      groupSession = session;
      groupBucket = bucket;
    }
    group.push(b);
  }
  flush();
  const brokenPrefix = new Int32Array(out.length + 1);
  for (let i = 0; i < out.length; i++) brokenPrefix[i + 1] = brokenPrefix[i] + broken[i];
  return { minutes, bars: out, brokenPrefix };
}

/** How many bars of the series are closed by nowMs. */
export function higherCount(series: CTHigherSeries, nowMs: number) {
  let lo = 0,
    hi = series.bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series.bars[mid].endMs <= nowMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * lookback + 1 chained bars ending `offset` bars before the last bar closed by nowMs, or null
 * when the series is too short or the window spans a gap (missing minutes, missing session, split).
 */
export function higherWindow(series: CTHigherSeries, nowMs: number, lookback: number, offset: number) {
  const end = higherCount(series, nowMs) - offset,
    start = end - lookback - 1;
  if (start < 0 || end > series.bars.length) return null;
  if (series.brokenPrefix[end] - series.brokenPrefix[start + 1] > 0) return null;
  return series.bars.slice(start, end);
}

/**
 * The previous day's complete daily bar for a decision at `nowMs` (the close of a one-minute bar):
 * crypto — the UTC day that ends exactly where today starts; stocks — the session immediately before
 * today's in the NYSE calendar. A day with a missing minute is not a bar, a missing session is not
 * bridged, and a window never spans a split (raw prices on both sides are not comparable).
 */
export function prevDailyBar(series: CTHigherSeries, market: CTMarket, symbol: string, nowMs: number): CTBar | null {
  const DAY = 86_400_000;
  if (market === "crypto") {
    const dayStart = Math.floor((nowMs - 1) / DAY) * DAY,
      i = higherCount(series, dayStart) - 1;
    return i >= 0 && series.bars[i].endMs === dayStart ? series.bars[i] : null;
  }
  const today = sessionAt(nowMs - 1);
  if (!today) return null;
  const i = higherCount(series, today.openMs) - 1;
  if (i < 0) return null;
  const bar = series.bars[i],
    before = sessionAt(bar.startMs);
  if (!before || before.ord + 1 !== today.ord) return null;
  if ((CT_STOCK_SPLITS[symbol] ?? []).some((d) => before.date < d && today.date >= d)) return null;
  return bar;
}

/** Base one-minute bars a live caller must supply for a higher-timeframe window of (lookback + offset + 2) bars. */
export function higherWarmupMinutes(market: CTMarket, minutes: number, lookback: number, offset: number) {
  const bars = lookback + offset + 2;
  return market === "crypto" ? bars * minutes : Math.ceil((bars * minutes) / 390) * 390 + 390;
}
