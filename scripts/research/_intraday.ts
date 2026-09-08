/**
 * Session-level helpers for the intraday hypotheses.
 *
 * Every filter here is computed from information that existed before the bar it
 * gates. The relative-volume baseline is a median over *earlier* sessions only,
 * and VWAP accumulates from 09:30 forward, so neither can borrow a value the
 * morning did not have.
 */

import type { MassiveIntradayPoint } from "../../lib/massive-shapes.ts";

export const RTH_OPEN = "09:30";
export const RTH_CLOSE = "16:00";

export function minutesOf(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

/** Regular-hours bars for one session, in order. */
export function regularBars(points: MassiveIntradayPoint[]) {
  return points.filter((point) => point.time >= RTH_OPEN && point.time < RTH_CLOSE).sort((a, b) => a.timestamp - b.timestamp);
}

export type Session = {
  date: string;
  bars: MassiveIntradayPoint[];
  open: number;
  /** Volume in the first `anchorMinutes`, and its ratio to the median of prior sessions. */
  anchorVolume: number;
  relativeVolume: number | null;
};

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Groups points into regular-hours sessions and attaches a relative opening
 * volume computed from a rolling median of the prior `lookback` sessions.
 */
export function buildSessions(points: MassiveIntradayPoint[], anchorMinutes = 15, lookback = 20): Session[] {
  const byDate = new Map<string, MassiveIntradayPoint[]>();
  for (const point of points) {
    const list = byDate.get(point.date);
    if (list) list.push(point); else byDate.set(point.date, [point]);
  }
  const history: number[] = [];
  const sessions: Session[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const bars = regularBars(byDate.get(date)!);
    if (bars.length < 60 || bars[0].time !== RTH_OPEN) continue;
    const cutoff = minutesOf(RTH_OPEN) + anchorMinutes;
    const anchorVolume = bars.filter((bar) => minutesOf(bar.time) < cutoff).reduce((sum, bar) => sum + bar.volume, 0);
    const baseline = history.length >= lookback ? median(history.slice(-lookback)) : null;
    sessions.push({ date, bars, open: bars[0].open, anchorVolume, relativeVolume: baseline && baseline > 0 ? anchorVolume / baseline : null });
    if (anchorVolume > 0) history.push(anchorVolume);
  }
  return sessions;
}

/** Volume-weighted average price from the open, one value per bar, using typical price. */
export function vwapSeries(bars: MassiveIntradayPoint[]) {
  let volume = 0, notional = 0;
  return bars.map((bar) => {
    const typical = (bar.high + bar.low + bar.close) / 3;
    const size = bar.volume > 0 ? bar.volume : 0;
    volume += size;
    notional += typical * size;
    return volume > 0 ? notional / volume : bar.close;
  });
}
