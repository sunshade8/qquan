import { localStockPoints } from "./local-market-data.ts";
/** Shared raw Parquet history; local-only. Existing SQL caches are preserved for migration. */

import { easternParts, shiftDate } from "@/lib/market-clock";
import type { IntradayBar, SessionBars } from "@/lib/relay-engine";
import type { RelayDataSource } from "@/lib/relay-report";
import { rollUpComplete } from "./bar-rollup.ts";

type SourceInterval = "1m" | "5m";

export type LoadProgress = (message: string) => void;

/** The last session Massive's end-of-day plan can have: yesterday in New York. */
export function lastCompleteDate(now = Date.now()) {
  return shiftDate(easternParts(now).date, -1);
}

function groupByDate(
  points: Array<{
    date: string;
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>,
  from: string,
  to: string,
) {
  const days = new Map<string, IntradayBar[]>();
  for (const point of points) {
    if (
      point.date < from ||
      point.date > to ||
      point.time < "04:00" ||
      point.time >= "20:00"
    )
      continue;
    const bars = days.get(point.date) ?? [];
    bars.push({
      date: point.date,
      time: point.time,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
      volume: point.volume,
    });
    days.set(point.date, bars);
  }
  for (const bars of days.values())
    bars.sort((left, right) => left.time.localeCompare(right.time));
  return days;
}

/**
 * Bars for one symbol over [from, to]. Returns the per-day bars and a source
 * line for the report saying where they came from.
 */
async function loadSymbol(
  symbol: string,
  from: string,
  to: string,
  onProgress: LoadProgress,
  interval: SourceInterval,
): Promise<{ days: Map<string, IntradayBar[]>; source: RelayDataSource }> {
  onProgress(`${symbol} 로컬 Parquet 조회 · 외부 과거 시세 요청 없음`);
  const points = await localStockPoints(symbol, from, to, interval);
  const days = groupByDate(points, from, to);
  return {
    days,
    source: {
      symbol,
      provider: "Massive",
      snapshot: points.snapshot,
      datasetVersion: points.datasetVersion,
      bars: points.length,
      firstDate: points[0]?.date ?? "",
      lastDate: points.at(-1)?.date ?? "",
      fallbackReason: null,
      cachedMonths: new Set(points.map((p) => p.date.slice(0, 7))).size,
      fetchedMonths: 0,
    },
  };
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
): Promise<{
  sessions: SessionBars[];
  warmup: number;
  sources: RelayDataSource[];
  warnings: string[];
}> {
  const loadFrom =
    warmupSessions > 0
      ? shiftDate(from, -Math.ceil(warmupSessions * 1.5) - 7)
      : from;
  const perSymbol = new Map<string, Map<string, IntradayBar[]>>();
  const sources: RelayDataSource[] = [];
  const warnings: string[] = [];
  if (sourceMinutes === 5 && step !== 5)
    throw new Error("원본 5분봉은 1분/3분 실행 데이터로 변환할 수 없습니다.");
  const interval: SourceInterval = `${sourceMinutes}m`;
  for (const symbol of symbols) {
    const { days, source } = await loadSymbol(
      symbol,
      loadFrom,
      to,
      onProgress,
      interval,
    );
    if (sourceMinutes === 1)
      for (const [date, bars] of days)
        days.set(date, rollUpComplete(bars, step));
    perSymbol.set(symbol, days);
    sources.push(source);
    if (!days.size)
      warnings.push(
        `${symbol}: 기간 내 ${step}분봉이 없습니다. 이 종목을 쓰는 규칙은 신호를 내지 못합니다.`,
      );
  }

  const dates = [
    ...new Set([...perSymbol.values()].flatMap((days) => [...days.keys()])),
  ].sort();
  const prior = dates.filter((date) => date < from).slice(-warmupSessions);
  const inRange = dates.filter((date) => date >= from && date <= to);
  if (warmupSessions > 0 && prior.length < warmupSessions) {
    warnings.push(
      `준비 세션이 ${warmupSessions}개 필요하지만 ${prior.length}개만 있어 첫 ${warmupSessions - prior.length}개 세션은 평가에서 빠집니다.`,
    );
  }
  const sessions = [...(warmupSessions > 0 ? prior : []), ...inRange].map(
    (date) => ({
      date,
      bars: Object.fromEntries(
        symbols.map((symbol) => [
          symbol,
          perSymbol.get(symbol)?.get(date) ?? [],
        ]),
      ),
    }),
  );
  return {
    sessions: sessions.map((session) => ({
      ...session,
      barsByStep: { [step]: session.bars },
    })),
    warmup: warmupSessions > 0 ? prior.length : 0,
    sources,
    warnings,
  };
}

/**
 * One session list for rules at several resolutions: each load's bars go under
 * its step, and `bars` stays the five-minute set when one was loaded.
 */
export function mergeSessionSteps(
  loads: Array<{ step: 1 | 3 | 5; sessions: SessionBars[] }>,
): SessionBars[] {
  const byDate = new Map<string, SessionBars>();
  for (const { step, sessions } of loads) {
    for (const session of sessions) {
      const merged = byDate.get(session.date) ?? {
        date: session.date,
        bars: {},
        barsByStep: {},
      };
      merged.barsByStep![step] = session.bars;
      if (step === 5) merged.bars = session.bars;
      byDate.set(session.date, merged);
    }
  }
  // A day one resolution has and another lacks is a day with no bars at the other, not an error.
  for (const merged of byDate.values())
    for (const { step } of loads) merged.barsByStep![step] ??= {};
  return [...byDate.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
}
