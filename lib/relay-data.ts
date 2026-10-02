/**
 * Session bars for the relay backtest, at the resolution each rule reads.
 *
 * Every rule reads complete buckets built from one-minute aggregates on the
 * same grid as the live runner. Provider-native five-minute bars may contain
 * missing minutes, so they cannot stand in for this execution data.
 *
 * Massive Basic serves two years at five calls a minute, so the loader fetches
 * one calendar month per call, waits its turn on the shared pacer in
 * `lib/massive-pacer.ts`, and keeps every fetched session in D1. The first backtest over a long window is slow and says
 * so through `onProgress`; the second over the same window is a database read.
 *
 * Bars cover the whole 04:00–19:55 ET day because slots run in pre- and
 * after-market as well. Yahoo minute data is a fallback only for the last 7 days when
 * Massive is not configured or fails, and its bars are never cached — a cache
 * that silently mixes providers is not evidence of anything.
 */

import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { intradayBarCoverage, intradayBarDays } from "@/db/schema";
import { fetchMassiveIntradayWindow, massiveAvailableFrom, massiveConfigured, MassiveError } from "@/lib/massive";
import { fetchYahooIntradayWindow } from "@/lib/market-data";
import { easternParts, shiftDate } from "@/lib/market-clock";
import type { IntradayBar, SessionBars } from "@/lib/relay-engine";
import type { RelayDataSource } from "@/lib/relay-report";
import { missingIntradayRange } from "./intraday-coverage.ts";
import { paceMassive, sleep } from "./massive-pacer.ts";
import { rollUpComplete } from "./bar-rollup.ts";

type SourceInterval = "1m" | "5m";
const YAHOO_WINDOW_DAYS = 58;

export type LoadProgress = (message: string) => void;

/** The last session Massive's end-of-day plan can have: yesterday in New York. */
export function lastCompleteDate(now = Date.now()) {
  return shiftDate(easternParts(now).date, -1);
}

type Compact = [string, number, number, number, number, number];

function monthsBetween(from: string, to: string) {
  const months: Array<{ month: string; start: string; end: string }> = [];
  let cursor = `${from.slice(0, 7)}-01`;
  while (cursor <= to) {
    const next = new Date(`${cursor}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const end = shiftDate(next.toISOString().slice(0, 10), -1);
    months.push({ month: cursor.slice(0, 7), start: cursor, end });
    cursor = next.toISOString().slice(0, 10);
  }
  return months;
}

async function massiveMonth(symbol: string, from: string, to: string, onProgress: LoadProgress, interval: SourceInterval) {
  for (let attempt = 0; ; attempt += 1) {
    await paceMassive(`${symbol} ${from.slice(0, 7)}`, onProgress);
    try {
      return await fetchMassiveIntradayWindow(symbol, from, to, interval, { session: "all", maxPages: 3 });
    } catch (error) {
      if (error instanceof MassiveError && error.kind === "rate_limit" && attempt < 4) {
        onProgress(`Massive 한도 초과 — 20초 뒤 재시도 (${symbol} ${from.slice(0, 7)})`);
        await sleep(20_000);
        continue;
      }
      if (error instanceof MassiveError && error.kind === "not_found") return null;
      throw error;
    }
  }
}

/** drizzle's `excluded.` reference for upserts. */
const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

async function writeDays(symbol: string, days: Map<string, IntradayBar[]>, provider: string, interval: SourceInterval) {
  const db = getDb();
  const rows = [...days.entries()].map(([date, bars]) => ({
    id: `${symbol}|${interval}|${date}`, symbol, interval, tradingDate: date, provider,
    payload: JSON.stringify(bars.map((bar): Compact => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume])),
  }));
  // Six bound parameters a row; D1 caps a statement at 100.
  for (let index = 0; index < rows.length; index += 15) {
    const chunk = rows.slice(index, index + 15);
    await db.insert(intradayBarDays).values(chunk).onConflictDoUpdate({
      target: intradayBarDays.id,
      set: { payload: sqlExcluded("payload"), provider: sqlExcluded("provider") },
    });
  }
}

async function readDays(symbol: string, from: string, to: string, interval: SourceInterval) {
  const rows = await getDb().select().from(intradayBarDays)
    .where(and(eq(intradayBarDays.symbol, symbol), eq(intradayBarDays.interval, interval), gte(intradayBarDays.tradingDate, from), lte(intradayBarDays.tradingDate, to)))
    .orderBy(asc(intradayBarDays.tradingDate));
  const days = new Map<string, IntradayBar[]>();
  for (const row of rows) {
    if (row.provider !== "Massive") throw new Error(`${symbol}: 보유 캐시 출처 ${row.provider} 불일치`);
    const compact = JSON.parse(row.payload) as Compact[];
    days.set(row.tradingDate, compact.map(([time, open, high, low, close, volume]) => ({ date: row.tradingDate, time, open, high, low, close, volume })));
  }
  return days;
}

function groupByDate(points: Array<{ date: string; time: string; open: number; high: number; low: number; close: number; volume: number }>, from: string, to: string) {
  const days = new Map<string, IntradayBar[]>();
  for (const point of points) {
    if (point.date < from || point.date > to || point.time < "04:00" || point.time >= "20:00") continue;
    const bars = days.get(point.date) ?? [];
    bars.push({ date: point.date, time: point.time, open: point.open, high: point.high, low: point.low, close: point.close, volume: point.volume });
    days.set(point.date, bars);
  }
  for (const bars of days.values()) bars.sort((left, right) => left.time.localeCompare(right.time));
  return days;
}

/**
 * Bars for one symbol over [from, to]. Returns the per-day bars and a source
 * line for the report saying where they came from.
 */
async function loadSymbol(symbol: string, from: string, to: string, onProgress: LoadProgress, interval: SourceInterval): Promise<{ days: Map<string, IntradayBar[]>; source: RelayDataSource }> {
  const label = interval === "5m" ? "5분봉" : "1분봉";
  const today = lastCompleteDate();
  const end = to < today ? to : today;
  const source: RelayDataSource = { symbol, provider: "Massive", bars: 0, firstDate: "", lastDate: "", fallbackReason: null, cachedMonths: 0, fetchedMonths: 0 };
  const finish = (days: Map<string, IntradayBar[]>) => {
    const dates = [...days.keys()].sort();
    source.bars = [...days.values()].reduce((sum, bars) => sum + bars.length, 0);
    source.firstDate = dates[0] ?? "";
    source.lastDate = dates.at(-1) ?? "";
    return { days, source };
  };

  const yahoo = async (reason: string) => {
    if (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > (interval === "5m" ? YAHOO_WINDOW_DAYS : 7) * 86_400_000) {
      throw new Error(`${symbol}: ${reason} Yahoo ${label}은 최근 ${interval === "5m" ? YAHOO_WINDOW_DAYS : 7}일만 제공되어 이 기간을 대신할 수 없습니다.`);
    }
    onProgress(`${symbol} Yahoo Finance ${label} 조회 (대체 사유: ${reason})`);
    const points = await fetchYahooIntradayWindow(symbol, from, shiftDate(end, 1), interval);
    source.provider = "Yahoo Finance";
    source.fallbackReason = reason;
    return finish(groupByDate(points, from, end));
  };

  await ensureSchema();
  // Entitlements constrain new downloads, never already acquired history.
  const start = from;
  const months = monthsBetween(start, end);
  const coverage = await getDb().select().from(intradayBarCoverage).where(and(
    eq(intradayBarCoverage.symbol, symbol), eq(intradayBarCoverage.interval, interval),
    inArray(intradayBarCoverage.month, months.map((month) => month.month)),
  ));
  const byMonth = new Map(coverage.map((row) => [row.month, row]));

  for (const [index, month] of months.entries()) {
    const needFrom = month.start > start ? month.start : start;
    const needTo = month.end < end ? month.end : end;
    const cached = byMonth.get(month.month);
    const missing = missingIntradayRange(needFrom, needTo, cached);
    if (!missing) { source.cachedMonths = (source.cachedMonths ?? 0) + 1; continue; }

    if (!massiveConfigured()) {
      if (coverage.length) throw new Error(`${symbol}: 캐시는 보존했지만 ${missing.from}–${missing.to} 보충에 MASSIVE_API_KEY가 필요합니다.`);
      return yahoo("MASSIVE_API_KEY 미설정.");
    }
    const availableFrom = massiveAvailableFrom();
    if (missing.from < availableFrom) throw new Error(`${symbol}: 캐시 미확보 ${missing.from}–${missing.to}; 신규 다운로드는 ${availableFrom} 이후만 가능합니다. 보유 캐시는 보존됩니다.`);

    onProgress(`${symbol} ${month.month} ${label} 다운로드 (${index + 1}/${months.length})`);
    let history;
    try {
      history = await massiveMonth(symbol, missing.from, missing.to, onProgress, interval);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Massive 분봉 조회 실패";
      if (index === 0) return yahoo(reason);
      throw new Error(`${symbol} ${month.month}: ${reason}`);
    }
    const days = groupByDate(history?.points ?? [], missing.from, missing.to);
    await writeDays(symbol, days, "Massive", interval);
    const coveredFrom = cached && cached.fromDate < missing.from ? cached.fromDate : missing.from;
    const coveredTo = cached && cached.toDate > missing.to ? cached.toDate : missing.to;
    const row = {
      id: `${symbol}|${interval}|${month.month}`, symbol, interval, month: month.month,
      fromDate: coveredFrom, toDate: coveredTo, complete: coveredFrom === month.start && coveredTo === month.end, fetchedAt: new Date(),
    };
    await getDb().insert(intradayBarCoverage).values(row).onConflictDoUpdate({
      target: intradayBarCoverage.id,
      set: { fromDate: row.fromDate, toDate: row.toDate, complete: row.complete, fetchedAt: row.fetchedAt },
    });
    source.fetchedMonths = (source.fetchedMonths ?? 0) + 1;
  }

  return finish(await readDays(symbol, start, end, interval));
}

/**
 * Sessions for the backtest: `warmupSessions` sessions before `from` (so rules
 * that read prior days have them) followed by every session in [from, to], at
 * the `step`-minute resolution. `bars` holds that resolution; a caller mixing
 * rules of different resolutions merges several loads with `mergeSessionSteps`.
 */
export async function loadRelaySessions(
  symbols: string[],
  from: string,
  to: string,
  warmupSessions: number,
  onProgress: LoadProgress,
  step: 1 | 3 | 5 = 5,
  sourceMinutes: 1 | 5 = 1,
): Promise<{ sessions: SessionBars[]; warmup: number; sources: RelayDataSource[]; warnings: string[] }> {
  const loadFrom = warmupSessions > 0 ? shiftDate(from, -Math.ceil(warmupSessions * 1.5) - 7) : from;
  const perSymbol = new Map<string, Map<string, IntradayBar[]>>();
  const sources: RelayDataSource[] = [];
  const warnings: string[] = [];
  if (sourceMinutes === 5 && step !== 5) throw new Error("원본 5분봉은 1분/3분 실행 데이터로 변환할 수 없습니다.");
  const interval: SourceInterval = `${sourceMinutes}m`;
  for (const symbol of symbols) {
    const { days, source } = await loadSymbol(symbol, loadFrom, to, onProgress, interval);
    if (sourceMinutes === 1) for (const [date, bars] of days) days.set(date, rollUpComplete(bars, step));
    perSymbol.set(symbol, days);
    sources.push(source);
    if (!days.size) warnings.push(`${symbol}: 기간 내 ${step}분봉이 없습니다. 이 종목을 쓰는 규칙은 신호를 내지 못합니다.`);
  }

  const dates = [...new Set([...perSymbol.values()].flatMap((days) => [...days.keys()]))].sort();
  const prior = dates.filter((date) => date < from).slice(-warmupSessions);
  const inRange = dates.filter((date) => date >= from && date <= to);
  if (warmupSessions > 0 && prior.length < warmupSessions) {
    warnings.push(`준비 세션이 ${warmupSessions}개 필요하지만 ${prior.length}개만 있어 첫 ${warmupSessions - prior.length}개 세션은 평가에서 빠집니다.`);
  }
  const sessions = [...(warmupSessions > 0 ? prior : []), ...inRange].map((date) => ({
    date,
    bars: Object.fromEntries(symbols.map((symbol) => [symbol, perSymbol.get(symbol)?.get(date) ?? []])),
  }));
  return { sessions: sessions.map(session => ({ ...session, barsByStep: { [step]: session.bars } })), warmup: warmupSessions > 0 ? prior.length : 0, sources, warnings };
}

/**
 * One session list for rules at several resolutions: each load's bars go under
 * its step, and `bars` stays the five-minute set when one was loaded.
 */
export function mergeSessionSteps(loads: Array<{ step: 1 | 3 | 5; sessions: SessionBars[] }>): SessionBars[] {
  const byDate = new Map<string, SessionBars>();
  for (const { step, sessions } of loads) {
    for (const session of sessions) {
      const merged = byDate.get(session.date) ?? { date: session.date, bars: {}, barsByStep: {} };
      merged.barsByStep![step] = session.bars;
      if (step === 5) merged.bars = session.bars;
      byDate.set(session.date, merged);
    }
  }
  // A day one resolution has and another lacks is a day with no bars at the other, not an error.
  for (const merged of byDate.values()) for (const { step } of loads) merged.barsByStep![step] ??= {};
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}
