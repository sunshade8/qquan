/**
 * Intraday bars for the 급등주 pool, at every resolution a rule may ask for.
 *
 * Two things make this its own loader rather than a reuse of
 * `lib/relay-data.ts`, and both are about not corrupting evidence:
 *
 * 1. **Raw prices.** The relay cache stores split-adjusted bars, which is right
 *    for a fixed large-cap universe and wrong here: a surge name's history gets
 *    rewritten by a reverse split it had not done yet, so the entry price,
 *    the share count and the affordability check would all be fiction. These
 *    rows are `adjusted=false` and are kept under their own interval keys
 *    (`1m-raw`, `3m-raw`, `5m-raw`) so the two caches can never be confused.
 *
 * 2. **One download, three resolutions.** Massive charges a request, not a bar:
 *    a month of one-minute aggregates costs exactly what a month of five-minute
 *    aggregates costs, and 1m→3m→5m is arithmetic. So the loader asks for
 *    minutes once and rolls them up, and a rule can read whichever resolution
 *    its thesis needs. A surge that resolves in eight minutes is invisible on a
 *    five-minute chart.
 *
 * Bars are trimmed to the tradable span on write, which is also what keeps a
 * year of sessions inside one isolate's memory.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { intradayBarCoverage, intradayBarDays } from "@/db/schema";
import { massiveApiKey, massivePlan, MassiveError } from "./massive.ts";
import { paceMassive, sleep } from "./massive-pacer.ts";
import { shiftDate } from "./market-clock.ts";
import type { IntradayBar } from "./relay-engine.ts";
import { intervalMinutes, SURGE_DAY_FROM, SURGE_DAY_TO, SURGE_INTERVALS, type SurgeInterval } from "./surge-spec.ts";
import { missingIntradayRange } from "./intraday-coverage.ts";
import { rollUp } from "./bar-rollup.ts";

const BASE = "https://api.massive.com";
const PROVIDER = "Massive/raw";

/** Cache key for a resolution. `-raw` keeps these rows apart from the relay's adjusted bars. */
export const rawInterval = (interval: SurgeInterval) => `${interval}-raw`;

type Compact = [string, number, number, number, number, number];
type Aggregate = { t: number; o: number; h: number; l: number; c: number; v: number };

const etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function toEasternBar(point: Aggregate): { date: string; time: string } {
  const parts = etParts.formatToParts(new Date(point.t));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${pick("year")}-${pick("month")}-${pick("day")}`, time: `${pick("hour")}:${pick("minute")}` };
}

async function fetchMinutes(symbol: string, from: string, to: string): Promise<IntradayBar[]> {
  const apiKey = massiveApiKey();
  if (!apiKey) throw new MassiveError("not_configured", "MASSIVE_API_KEY가 연결되지 않았습니다.", 503);
  const url = new URL(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${from}/${to}`, BASE);
  url.searchParams.set("adjusted", "false");
  url.searchParams.set("sort", "asc");
  url.searchParams.set("limit", "50000");

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new MassiveError("upstream", `${symbol} 1분봉에 연결하지 못했습니다.`);
  }
  const payload = await response.json().catch(() => ({})) as { results?: Aggregate[]; next_url?: string | null; error?: string; message?: string };
  if (response.status === 401) throw new MassiveError("auth", "Massive API 키 인증에 실패했습니다.", 401);
  if (response.status === 403) throw new MassiveError("plan_locked", `Massive ${massivePlan()} 이 ${from} 1분봉을 제공하지 않습니다.`, 403);
  if (response.status === 429) throw new MassiveError("rate_limit", "Massive 분당 호출 한도를 초과했습니다.", 429);
  if (response.status === 404) throw new MassiveError("not_found", `${symbol} 1분봉이 없습니다.`, 404);
  if (!response.ok) throw new MassiveError("upstream", `${symbol} 1분봉 조회 실패: ${payload.error ?? payload.message ?? response.status}`);

  const bars: IntradayBar[] = [];
  for (const point of payload.results ?? []) {
    const { date, time } = toEasternBar(point);
    if (date < from || date > to || time < SURGE_DAY_FROM || time > SURGE_DAY_TO) continue;
    if (![point.o, point.h, point.l, point.c, point.v].every(Number.isFinite)) continue;
    bars.push({ date, time, open: point.o, high: point.h, low: point.l, close: point.c, volume: point.v });
  }
  return bars.sort((left, right) => left.date.localeCompare(right.date) || left.time.localeCompare(right.time));
}

const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

async function writeInterval(symbol: string, interval: SurgeInterval, bars: IntradayBar[]) {
  const key = rawInterval(interval);
  const byDate = new Map<string, IntradayBar[]>();
  for (const bar of bars) {
    const list = byDate.get(bar.date) ?? [];
    list.push(bar);
    byDate.set(bar.date, list);
  }
  const rows = [...byDate.entries()].map(([date, list]) => ({
    id: `${symbol}|${key}|${date}`, symbol, interval: key, tradingDate: date, provider: PROVIDER,
    payload: JSON.stringify(list.map((bar): Compact => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume])),
  }));
  const db = getDb();
  for (let index = 0; index < rows.length; index += 15) {
    await db.insert(intradayBarDays).values(rows.slice(index, index + 15)).onConflictDoUpdate({
      target: intradayBarDays.id,
      set: { payload: sqlExcluded("payload"), provider: sqlExcluded("provider") },
    });
  }
  return byDate.size;
}

export type SurgeBarFetch = {
  symbol: string;
  from: string;
  to: string;
  cached: boolean;
  minuteBars: number;
  sessions: number;
};

/**
 * Bars for one symbol over one month, at all three resolutions.
 *
 * Coverage is tracked against the 1-minute key; the roll-ups are written in the
 * same transaction-ish pass, so a month marked covered has all three.
 */
export async function loadSurgeBars(
  symbol: string,
  from: string,
  to: string,
  onProgress: (message: string) => void = () => undefined,
): Promise<SurgeBarFetch> {
  await ensureSchema();
  const month = from.slice(0, 7);
  const db = getDb();
  const [coverage] = await db.select().from(intradayBarCoverage).where(and(
    eq(intradayBarCoverage.symbol, symbol),
    eq(intradayBarCoverage.interval, rawInterval("1m")),
    eq(intradayBarCoverage.month, month),
  ));
  const missing = missingIntradayRange(from, to, coverage);
  if (!missing) return { symbol, from, to, cached: true, minuteBars: 0, sessions: 0 };

  await paceMassive(`${symbol} ${month} 1분봉`, onProgress);
  onProgress(`Massive 1분봉 요청 · ${symbol} ${missing.from}~${missing.to} (원주가)`);
  let minutes: IntradayBar[];
  try {
    minutes = await fetchMinutes(symbol, missing.from, missing.to);
  } catch (error) {
    if (error instanceof MassiveError && error.kind === "rate_limit") {
      onProgress(`Massive 한도 초과 — 20초 뒤 재시도 (${symbol} ${month})`);
      await sleep(20_000);
      minutes = await fetchMinutes(symbol, missing.from, missing.to);
    } else if (error instanceof MassiveError && error.kind === "not_found") {
      minutes = [];
    } else {
      throw error;
    }
  }

  let sessions = 0;
  for (const interval of SURGE_INTERVALS) {
    sessions = Math.max(sessions, await writeInterval(symbol, interval, rollUp(minutes, intervalMinutes(interval))));
  }
  const coveredFrom = coverage && coverage.fromDate < missing.from ? coverage.fromDate : missing.from;
  const coveredTo = coverage && coverage.toDate > missing.to ? coverage.toDate : missing.to;
  const monthStart = `${month}-01`;
  const monthEnd = shiftDate(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10), -1);
  await db.insert(intradayBarCoverage).values({
    id: `${symbol}|${rawInterval("1m")}|${month}`, symbol, interval: rawInterval("1m"), month,
    fromDate: coveredFrom, toDate: coveredTo,
    complete: coveredFrom === monthStart && coveredTo === monthEnd,
    fetchedAt: new Date(),
  }).onConflictDoUpdate({
    target: intradayBarCoverage.id,
    set: { fromDate: coveredFrom, toDate: coveredTo, complete: coveredFrom === monthStart && coveredTo === monthEnd, fetchedAt: new Date() },
  });

  return { symbol, from: missing.from, to: missing.to, cached: false, minuteBars: minutes.length, sessions };
}

/** Bars for a set of symbol-days at one resolution, read straight from the cache. */
/**
 * D1 refuses a statement with more than 100 bound parameters ("too many SQL
 * variables"), so both IN-lists are split: 45 + 45 + the interval stays under it.
 */
const IN_LIST_CHUNK = 45;
const chunked = <T,>(items: T[]) =>
  Array.from({ length: Math.ceil(items.length / IN_LIST_CHUNK) }, (_, index) => items.slice(index * IN_LIST_CHUNK, (index + 1) * IN_LIST_CHUNK));

export async function readSurgeBars(interval: SurgeInterval, symbols: string[], dates: string[]) {
  if (!symbols.length || !dates.length) return [] as Array<{ symbol: string; date: string; bars: IntradayBar[] }>;
  const rows: Array<typeof intradayBarDays.$inferSelect> = [];
  for (const symbolChunk of chunked([...new Set(symbols)])) {
    for (const dateChunk of chunked([...new Set(dates)])) {
      rows.push(...await getDb().select().from(intradayBarDays).where(and(
        eq(intradayBarDays.interval, rawInterval(interval)),
        inArray(intradayBarDays.symbol, symbolChunk),
        inArray(intradayBarDays.tradingDate, dateChunk),
      )).orderBy(asc(intradayBarDays.tradingDate)));
    }
  }
  return rows.map((row) => ({
    symbol: row.symbol,
    date: row.tradingDate,
    bars: (JSON.parse(row.payload) as Compact[]).map(([time, open, high, low, close, volume]) => ({
      date: row.tradingDate, time, open, high, low, close, volume,
    })),
  }));
}

/** What the UI's data panel reports: how much raw intraday history exists, per resolution. */
export async function surgeBarInventory() {
  await ensureSchema();
  const rows = await getDb().select({
    interval: intradayBarDays.interval,
    symbols: sql<number>`count(distinct ${intradayBarDays.symbol})`,
    sessions: sql<number>`count(*)`,
    firstDate: sql<string>`min(${intradayBarDays.tradingDate})`,
    lastDate: sql<string>`max(${intradayBarDays.tradingDate})`,
  }).from(intradayBarDays)
    .where(inArray(intradayBarDays.interval, SURGE_INTERVALS.map(rawInterval)))
    .groupBy(intradayBarDays.interval);
  return rows;
}

export { SURGE_INTERVALS, rollUp };
