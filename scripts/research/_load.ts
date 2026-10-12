/** Standalone research uses the same immutable local Parquet store as the app. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  localDailyRows,
  localStockPoints,
} from "../../lib/local-market-data.ts";
import type {
  MassiveIntradayPoint,
  MassiveInterval,
} from "../../lib/massive-shapes.ts";
export const OUT = join(
  process.env.QQUAN_DATA_DIR || join(homedir(), ".qquan"),
  "research/out",
);
mkdirSync(OUT, { recursive: true, mode: 0o700 });
export type Bar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export function writeOut(name: string, value: unknown) {
  writeFileSync(join(OUT, name), JSON.stringify(value, null, 2));
}
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export async function loadDaily(symbol: string, range = "11y"): Promise<Bar[]> {
  const match = /^(\d+)y$/.exec(range);
  if (!match) throw Error("Explicit calendar-year range required");
  const end = new Date();
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - Number(match[1]));
  return localDailyRows(
    symbol,
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10),
  );
}
export async function loadDailyMany(symbols: string[], range = "11y") {
  const out = new Map<string, Bar[]>();
  for (const symbol of symbols) {
    try {
      const bars = await loadDaily(symbol, range);
      if (bars.length > 200) out.set(symbol, bars);
      else console.error(`  skip ${symbol}: only ${bars.length} bars`);
    } catch (error) {
      console.error(`  skip ${symbol}: ${(error as Error).message}`);
    }
    await sleep(120);
  }
  return out;
}

export async function loadIntraday(
  symbol: string,
  from: string,
  to: string,
  interval: MassiveInterval = "5m",
): Promise<MassiveIntradayPoint[]> {
  return localStockPoints(symbol, from, to, interval, "all");
}
/** Groups intraday points into sessions keyed by New York calendar date. */
export function bySession(points: MassiveIntradayPoint[]) {
  const sessions = new Map<string, MassiveIntradayPoint[]>();
  for (const point of points) {
    const list = sessions.get(point.date);
    if (list) list.push(point);
    else sessions.set(point.date, [point]);
  }
  return [...sessions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
