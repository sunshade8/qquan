/** Pure Massive aggregate parsing, kept separate from the Worker-bound client. */

export type MassiveAggregate = {
  t?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
};

export type MassiveIntradayPoint = {
  timestamp: number;
  date: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MassiveInterval = "1m" | "5m" | "15m" | "60m";

export const MASSIVE_AGGREGATE_INTERVALS: Record<MassiveInterval, { multiplier: number; timespan: "minute" }> = {
  "1m": { multiplier: 1, timespan: "minute" },
  "5m": { multiplier: 5, timespan: "minute" },
  "15m": { multiplier: 15, timespan: "minute" },
  "60m": { multiplier: 60, timespan: "minute" },
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

/** Massive aggregate timestamps are Unix milliseconds and are grouped by ET. */
export function parseMassiveAggregates(
  aggregates: MassiveAggregate[],
  from: string,
  to: string,
  session: "all" | "regular" = "all",
): MassiveIntradayPoint[] {
  const byTimestamp = new Map<number, MassiveIntradayPoint>();
  for (const aggregate of aggregates) {
    const timestamp = typeof aggregate.t === "number" && Number.isFinite(aggregate.t) ? Math.floor(aggregate.t / 1000) : NaN;
    if (!Number.isFinite(timestamp) || ![aggregate.o, aggregate.h, aggregate.l, aggregate.c].every((value) => typeof value === "number" && Number.isFinite(value))) continue;
    const eastern = newYorkDateTime(timestamp);
    if (eastern.date < from || eastern.date > to || (session === "regular" && !isRegularSession(eastern.time))) continue;
    byTimestamp.set(timestamp, {
      timestamp,
      date: eastern.date,
      time: eastern.time,
      open: aggregate.o as number,
      high: aggregate.h as number,
      low: aggregate.l as number,
      close: aggregate.c as number,
      volume: typeof aggregate.v === "number" && Number.isFinite(aggregate.v) ? aggregate.v : 0,
    });
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}
