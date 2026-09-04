/** Pure Alpaca response parsing, kept separate from the Worker-bound client. */

export type AlpacaBar = {
  t?: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
};

export type AlpacaIntradayPoint = {
  timestamp: number;
  date: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type AlpacaInterval = "1m" | "5m" | "15m" | "60m";

export const ALPACA_TIMEFRAMES: Record<AlpacaInterval, string> = {
  "1m": "1Min",
  "5m": "5Min",
  "15m": "15Min",
  "60m": "1Hour",
};

export function newYorkDateTime(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp * 1000));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${pick("year")}-${pick("month")}-${pick("day")}`, time: `${pick("hour")}:${pick("minute")}` };
}

export function isRegularSession(time: string) {
  return time >= "09:30" && time < "16:00";
}

/**
 * Alpaca timestamps are UTC, while every intraday engine in QQuant groups bars
 * by the US market's Eastern date. Converting before filtering prevents the UTC
 * midnight boundary from splitting an after-hours session into the next day.
 */
export function parseAlpacaBars(
  bars: AlpacaBar[],
  from: string,
  to: string,
  session: "all" | "regular" = "all",
): AlpacaIntradayPoint[] {
  const byTimestamp = new Map<number, AlpacaIntradayPoint>();
  for (const bar of bars) {
    const timestamp = typeof bar.t === "string" ? Math.floor(new Date(bar.t).getTime() / 1000) : NaN;
    if (!Number.isFinite(timestamp) || ![bar.o, bar.h, bar.l, bar.c].every((value) => typeof value === "number" && Number.isFinite(value))) continue;
    const eastern = newYorkDateTime(timestamp);
    if (eastern.date < from || eastern.date > to || (session === "regular" && !isRegularSession(eastern.time))) continue;
    byTimestamp.set(timestamp, {
      timestamp,
      date: eastern.date,
      time: eastern.time,
      open: bar.o as number,
      high: bar.h as number,
      low: bar.l as number,
      close: bar.c as number,
      volume: typeof bar.v === "number" && Number.isFinite(bar.v) ? bar.v : 0,
    });
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}
