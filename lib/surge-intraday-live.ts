/**
 * Today's surge and crash events, observed live with the backtest's definition.
 *
 * Discovery is Toss's `TOP_GAINERS` / `TOP_LOSERS` ranking at `duration=1d`,
 * which during the regular session is today's forming session measured from
 * the previous close — the same reference the event uses. A listed name is only
 * a *candidate*: its Toss one-minute candles for today are replayed through
 * `observeSurgeDay`, exactly as the backtest replays Massive's minutes, and only
 * a minute that meets the whole definition (move, price, $1M of session tape)
 * becomes an event. That minute is the event's `observedAt`; the moment this
 * runner first saw it is `availableAt`, and no rule may act before either.
 *
 * Massive's all-market snapshot would be the natural feed, but the configured
 * plan is end-of-day and the endpoint answers NOT_AUTHORIZED (measured
 * 2026-09-29). Massive is still used for one thing: the previous session's
 * dollar volume, which the spread model reads in the backtest too.
 *
 * Limits worth knowing: the ranking stops at 100 names, and a spike that crosses
 * ±10% and falls back between two refreshes is missed or seen late. Both make
 * live trade fewer events than the backtest, never ones it could not have.
 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db/ensure";
import { paceMassive } from "./massive-pacer.ts";
import { easternParts, easternWallTimeToEpoch, isWeekday, shiftDate } from "./market-clock.ts";
import { aggregateMinuteCandles, parseTossCandle } from "./live-bars.ts";
import { fetchTossMinuteCandles } from "./market-data.ts";
import { fetchRanking } from "./surge-live.ts";
import { fetchGroupedDaily } from "./surge-market.ts";
import { compactMarket, tradableTicker } from "./surge-universe.ts";
import { readMarketDay, writeMarketDay } from "./surge-store.ts";
import { observeSurgeDay, observedCandidates, SURGE_OBSERVATION } from "./surge-observation.ts";
import { isExcludedInstrument } from "./trade-slots.ts";
import type { SurgeCandidate, SurgePool } from "./surge-spec.ts";

const db = () => (env as unknown as { DB: D1Database }).DB;
export type IntradaySurgePool = { date: string; checkedAt: string | null; candidates: Record<SurgePool, SurgeCandidate[]>; error: string | null; note: string | null };
let cached: { at: number; value: IntradaySurgePool } | undefined;
let pending: Promise<IntradaySurgePool> | undefined;

/** Names whose minutes are re-checked per refresh; the rest wait for the next pass. */
const CHECKS_PER_REFRESH = 12;
const STALE_AFTER_MS = 120_000;

/** Read-only view of today's events; discovery happens only while a surge dashboard runs. */
export async function readIntradaySurgePool(nowMs = Date.now()): Promise<IntradaySurgePool> {
  await ensureSchema();
  const et = easternParts(nowMs);
  const rows = await db().prepare("SELECT pool,payload FROM surge_intraday_observations WHERE trading_date=?").bind(et.date).all<{ pool: SurgePool; payload: string }>();
  const candidates: Record<SurgePool, SurgeCandidate[]> = { gainers: [], losers: [] };
  for (const row of rows.results) candidates[row.pool].push(JSON.parse(row.payload) as SurgeCandidate);
  const through = et.time < SURGE_OBSERVATION.to ? et.time : SURGE_OBSERVATION.to;
  for (const pool of ["gainers", "losers"] as const) candidates[pool] = observedCandidates(candidates[pool], et.date, through, pool);
  const status = await db().prepare("SELECT checked_at,error FROM surge_observation_status WHERE trading_date=?").bind(et.date).first<{ checked_at: string; error: string | null }>();
  const inSession = isWeekday(et.date) && et.time >= SURGE_OBSERVATION.from && et.time < SURGE_OBSERVATION.to;
  const stale = inSession && (!status || nowMs - Date.parse(status.checked_at) > STALE_AFTER_MS);
  const hardError = status?.error && !status.error.startsWith("참고:") ? status.error : null;
  return {
    date: et.date,
    checkedAt: status?.checked_at ?? null,
    candidates,
    error: hardError ?? (stale ? "당일 급등락 관측기가 아직 실행되지 않았거나 2분 이상 갱신되지 않았습니다. 급등주 대시보드가 실행 중이고 러너(npm run trader) 또는 열린 탭이 틱을 보내야 합니다." : null),
    note: status?.error?.startsWith("참고:") ? status.error : null,
  };
}

export async function refreshIntradaySurgePool(nowMs = Date.now()): Promise<IntradaySurgePool> {
  const et = easternParts(nowMs);
  if (!isWeekday(et.date) || et.time < SURGE_OBSERVATION.from || et.time >= SURGE_OBSERVATION.to) return readIntradaySurgePool(nowMs);
  if (cached && cached.value.date === et.date && nowMs - cached.at < 20_000) return cached.value;
  if (pending) return pending;
  pending = refresh(nowMs).finally(() => { pending = undefined; });
  return pending;
}

/**
 * Yesterday's dollar volume per ticker — the spread model's liquidity input in
 * the backtest, so live prices its cost the same way. Read from the shared
 * market cache, or fetched once (one Massive call) and cached for the day.
 */
const priorVolumes = new Map<string, Promise<Map<string, number>>>();
function priorDollarVolumes(date: string) {
  if (!priorVolumes.has(date)) {
    priorVolumes.set(date, (async () => {
      for (let back = 1; back <= 6; back++) {
        const day = shiftDate(date, -back);
        if (!isWeekday(day)) continue;
        let rows = await readMarketDay(day);
        if (!rows) {
          await paceMassive(`${day} 전 종목 일별 시세 (실거래 비용 모형)`);
          const fetched = await fetchGroupedDaily(day, true);
          if (!fetched.length) continue;
          rows = compactMarket(fetched);
          await writeMarketDay(day, rows);
        }
        if (rows.length) return new Map(rows.map(([symbol, close, volume]) => [symbol, Math.round(close * volume)]));
      }
      return new Map<string, number>();
    })().catch((error) => {
      priorVolumes.delete(date);
      throw error;
    }));
  }
  return priorVolumes.get(date)!;
}

async function todaysMinutes(symbol: string, date: string, nowMs: number) {
  const start = easternWallTimeToEpoch(date, SURGE_OBSERVATION.from);
  const candles = [];
  let before: string | null = null;
  // 390 regular-session minutes fit in two pages of 200; a third covers premarket overlap.
  for (let page = 0; page < 3; page++) {
    const result = await fetchTossMinuteCandles(symbol, { count: 200, before });
    const parsed = result.candles.map(parseTossCandle).filter((candle) => candle !== null);
    candles.push(...parsed);
    if (!parsed.length || Math.min(...parsed.map((candle) => candle.endMs)) <= start + 60_000 || !result.nextBefore) break;
    before = result.nextBefore;
  }
  return aggregateMinuteCandles(candles, nowMs, 1).filter((bar) => bar.date === date);
}

async function refresh(nowMs: number) {
  await ensureSchema();
  const et = easternParts(nowMs);
  const token = crypto.randomUUID();
  await db().prepare("INSERT OR IGNORE INTO surge_observation_status (trading_date,checked_at,error) VALUES (?,?,'관측 준비 중')")
    .bind(et.date, new Date(0).toISOString()).run();
  const claimed = await db().prepare("UPDATE surge_observation_status SET lease_owner=?,lease_until=? WHERE trading_date=? AND (lease_until IS NULL OR lease_until<?)")
    .bind(token, Date.now() + 90_000, et.date, Date.now()).run();
  if (claimed.meta.changes !== 1) return readIntradaySurgePool();
  const state = await db().prepare("SELECT cursor FROM surge_observation_status WHERE trading_date=?").bind(et.date).first<{ cursor: number }>();
  let cursor = state?.cursor ?? 0;
  let failure: string | null = null;
  try {
    const known = await readIntradaySurgePool(nowMs);
    const seen = new Set([...known.candidates.gainers.map(c => `gainers:${c.symbol}`), ...known.candidates.losers.map(c => `losers:${c.symbol}`)]);
    const seeds: Array<{ pool: SurgePool; symbol: string; prevClose: number }> = [];
    for (const [pool, type] of [["gainers", "TOP_GAINERS"], ["losers", "TOP_LOSERS"]] as const) {
      const snapshot = await fetchRanking(type, "US", "1d");
      for (const row of snapshot.rows) {
        if (!row.basePrice || !(row.basePrice > 0) || row.changeRate === null || !row.lastPrice) continue;
        if (!tradableTicker(row.symbol) || isExcludedInstrument(row.symbol) || seen.has(`${pool}:${row.symbol}`)) continue;
        // The list is today's move so far; only names currently past the threshold are worth a minute replay.
        const move = row.changeRate * 100;
        if (pool === "gainers" ? move < SURGE_OBSERVATION.changePct : move > -SURGE_OBSERVATION.changePct) continue;
        if (row.lastPrice < SURGE_OBSERVATION.minPrice || row.lastPrice > SURGE_OBSERVATION.maxPrice) continue;
        seeds.push({ pool, symbol: row.symbol, prevClose: row.basePrice });
      }
    }
    seeds.sort((a, b) => a.pool.localeCompare(b.pool) || a.symbol.localeCompare(b.symbol));
    let prior = new Map<string, number>();
    let note: string | null = null;
    try {
      prior = await priorDollarVolumes(et.date);
    } catch (error) {
      note = `참고: 전일 거래대금을 불러오지 못해 비용 모형이 당일 누적 거래대금을 씁니다 (${error instanceof Error ? error.message : "Massive 오류"}).`;
    }
    const start = seeds.length ? cursor % seeds.length : 0;
    const deadline = Date.now() + 20_000;
    const minutesBySymbol = new Map<string, Awaited<ReturnType<typeof todaysMinutes>>>();
    for (let offset = 0; offset < Math.min(CHECKS_PER_REFRESH, seeds.length) && Date.now() < deadline; offset++) {
      const index = (start + offset) % seeds.length;
      const seed = seeds[index];
      cursor = index + 1;
      if (!minutesBySymbol.has(seed.symbol)) {
        try {
          minutesBySymbol.set(seed.symbol, await todaysMinutes(seed.symbol, et.date, nowMs));
        } catch (error) {
          // One name's candles failing delays that name; it is retried on the next pass.
          note = `참고: ${seed.symbol} 1분봉 조회 실패 — 다음 순회에서 재확인 (${error instanceof Error ? error.message : "알 수 없음"})`;
          continue;
        }
      }
      const event = observeSurgeDay({ symbol: seed.symbol, prevClose: seed.prevClose, priorDollarVolume: prior.get(seed.symbol) }, minutesBySymbol.get(seed.symbol)!, seed.pool);
      // No event yet (thin tape so far, say): the name stays a seed and is replayed again later.
      if (!event) continue;
      // Discovery may be late: never pretend this runner knew the event earlier.
      event.availableAt = easternParts(Date.now()).time;
      await db().prepare("INSERT OR IGNORE INTO surge_intraday_observations (trading_date,pool,symbol,payload) VALUES (?,?,?,?)")
        .bind(et.date, seed.pool, seed.symbol, JSON.stringify(event)).run();
    }
    failure = note;
  } catch (error) {
    failure = `토스 급등락 관측 실패: ${error instanceof Error ? error.message : "알 수 없음"}`;
  }
  const checkedAt = new Date().toISOString();
  await db().prepare("UPDATE surge_observation_status SET checked_at=?,error=?,cursor=?,lease_owner=NULL,lease_until=NULL WHERE trading_date=? AND lease_owner=?")
    .bind(checkedAt, failure, cursor, et.date, token).run();
  const value = await readIntradaySurgePool();
  cached = { at: Date.now(), value };
  return value;
}
