/**
 * Data loaders for the research scripts.
 *
 * `lib/price-cache.ts`, `lib/market-data.ts` and `lib/massive.ts` all import
 * `cloudflare:workers`, so a plain Node script cannot touch them. These loaders
 * hit the same upstreams directly and cache to disk, so a hypothesis can be
 * re-run without re-paying the Massive rate limit.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMassiveAggregates, MASSIVE_AGGREGATE_INTERVALS, type MassiveIntradayPoint, type MassiveInterval } from "../../lib/massive-shapes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache");
export const OUT = join(HERE, "out");
mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT, { recursive: true });

export type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };

function readCache<T>(name: string): T | null {
  const path = join(CACHE, name);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function writeCache(name: string, value: unknown) {
  writeFileSync(join(CACHE, name), JSON.stringify(value));
}

export function writeOut(name: string, value: unknown) {
  writeFileSync(join(OUT, name), JSON.stringify(value, null, 2));
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- daily bars

type YahooChart = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }>;
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
      };
    }>;
    error?: unknown;
  };
};

/**
 * Yahoo daily OHLCV, back-adjusted for splits and dividends. Yahoo already
 * split-adjusts the raw OHLC, so the only correction needed is the dividend
 * ratio `adjclose/close`, applied to all four prices so intraday ranges stay
 * proportional.
 */
export async function loadDaily(symbol: string, range = "11y"): Promise<Bar[]> {
  const name = `daily-${symbol}-${range}.json`;
  const cached = readCache<Bar[]>(name);
  if (cached?.length) return cached;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=div%2Csplit`;
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" } });
  if (!response.ok) throw new Error(`${symbol}: Yahoo ${response.status}`);
  const payload = await response.json() as YahooChart;
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const adj = result?.indicators?.adjclose?.[0]?.adjclose;
  if (!result?.timestamp || !quote?.close) throw new Error(`${symbol}: Yahoo returned no bars`);
  const bars: Bar[] = [];
  for (let index = 0; index < result.timestamp.length; index += 1) {
    const open = quote.open?.[index], high = quote.high?.[index], low = quote.low?.[index], close = quote.close?.[index];
    if ([open, high, low, close].some((value) => typeof value !== "number" || !Number.isFinite(value))) continue;
    const adjClose = adj?.[index];
    const ratio = typeof adjClose === "number" && Number.isFinite(adjClose) && close! > 0 ? adjClose / close! : 1;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(result.timestamp[index] * 1000));
    bars.push({
      date,
      open: open! * ratio,
      high: high! * ratio,
      low: low! * ratio,
      close: close! * ratio,
      volume: typeof quote.volume?.[index] === "number" ? quote.volume![index]! : 0,
    });
  }
  const unique = [...new Map(bars.map((bar) => [bar.date, bar])).values()].sort((a, b) => a.date < b.date ? -1 : 1);
  writeCache(name, unique);
  return unique;
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

// ------------------------------------------------------------- intraday bars

const MASSIVE_BASE = "https://api.massive.com";
let lastMassiveCall = 0;

function massiveKey() {
  const raw = readFileSync(join(HERE, "..", "..", ".dev.vars"), "utf8");
  const pick = (name: string) => raw.split("\n").find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
  const key = pick("MASSIVE_API_KEY") || pick("POLYGON_API_KEY");
  if (!key) throw new Error("MASSIVE_API_KEY missing from .dev.vars");
  return key;
}

/** Massive Basic allows 5 calls per minute; 13s spacing keeps a margin. */
async function throttle() {
  const wait = 13_000 - (Date.now() - lastMassiveCall);
  if (wait > 0) await sleep(wait);
  lastMassiveCall = Date.now();
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function fetchWindow(symbol: string, from: string, to: string, interval: MassiveInterval): Promise<MassiveIntradayPoint[]> {
  const aggregate = MASSIVE_AGGREGATE_INTERVALS[interval];
  let next: string | null = `${MASSIVE_BASE}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${aggregate.multiplier}/${aggregate.timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
  const points: MassiveIntradayPoint[] = [];
  let pages = 0;
  while (next && pages < 6) {
    pages += 1;
    await throttle();
    const response = await fetch(next, { headers: { accept: "application/json", authorization: `Bearer ${massiveKey()}` } });
    if (response.status === 429) { console.error("  rate limited, waiting 65s"); await sleep(65_000); pages -= 1; continue; }
    if (!response.ok) throw new Error(`${symbol} ${from}..${to}: Massive ${response.status} ${(await response.text()).slice(0, 200)}`);
    const payload = await response.json() as { results?: unknown[]; next_url?: string | null };
    points.push(...parseMassiveAggregates((payload.results ?? []) as never, from, to, "all"));
    next = payload.next_url ?? null;
  }
  return points;
}

/**
 * Intraday bars including pre/post market, cached per symbol+interval. The
 * window is split into ~120-day chunks so a single page never exceeds the
 * 50,000-bar limit.
 */
export async function loadIntraday(symbol: string, from: string, to: string, interval: MassiveInterval = "5m"): Promise<MassiveIntradayPoint[]> {
  const name = `intraday-${symbol}-${interval}-${from}-${to}.json`;
  const cached = readCache<MassiveIntradayPoint[]>(name);
  if (cached?.length) return cached;
  const chunks: Array<[string, string]> = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDays(cursor, 119) > to ? to : addDays(cursor, 119);
    chunks.push([cursor, end]);
    cursor = addDays(end, 1);
  }
  const all: MassiveIntradayPoint[] = [];
  for (const [start, end] of chunks) {
    const page = await fetchWindow(symbol, start, end, interval);
    console.error(`  ${symbol} ${start}..${end}: ${page.length} bars`);
    all.push(...page);
  }
  const unique = [...new Map(all.map((point) => [point.timestamp, point])).values()].sort((a, b) => a.timestamp - b.timestamp);
  writeCache(name, unique);
  return unique;
}

/** Groups intraday points into sessions keyed by New York calendar date. */
export function bySession(points: MassiveIntradayPoint[]) {
  const sessions = new Map<string, MassiveIntradayPoint[]>();
  for (const point of points) {
    const list = sessions.get(point.date);
    if (list) list.push(point); else sessions.set(point.date, [point]);
  }
  return [...sessions.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
}
