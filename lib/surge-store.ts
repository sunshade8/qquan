/**
 * D1 for the 급등주 pipeline.
 *
 * Two of these tables are deliberately **not** scoped to a run or an owner:
 *
 * - `surge_market_days` — one compact row per session holding every ticker's
 *   raw close, volume, high, low and open. It decides whose minutes could hold a
 *   same-day event, it costs one Massive call per session to build, and it is
 *   identical for every research run, so the second one pays nothing for it.
 * - `intraday_bar_days` — already shared with the relay backtest.
 *
 * The consequence worth knowing: the first generation is a multi-hour download
 * and the next one over the same year starts at the design stage.
 */

import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db/ensure";

import type { SurgeSession } from "./surge-engine.ts";
import {
  compileSurgeStrategy,
  intervalMinutes,
  parseSurgeSpec,
  sessionPrefix,
  surgeReach,
  surgeSpecHash,
  SURGE_DAY_FROM,
  SURGE_DAY_TO,
  type SurgeCandidate,
  type SurgeCandidateSpec,
  type SurgeInterval,
  type SurgePool,
  type SurgeSpec,
} from "./surge-spec.ts";
import { rollUpComplete } from "./bar-rollup.ts";
import { observeSurgeDay } from "./surge-observation.ts";
import { readSurgeBars } from "./surge-bars.ts";
import type { SplitEvent } from "./surge-market.ts";
import { surgeEvidenceProblems } from "./surge-validation.ts";
import type { CompactMarketRow } from "./surge-universe.ts";
import { SURGE_RESEARCH_VERSION, type SurgeJob } from "./surge-types.ts";

function db() {
  return (env as unknown as { DB: D1Database }).DB;
}

// ------------------------------------------------------------------- the run

export async function listSurgeJobs(ownerId: string) {
  await ensureSchema();
  const rows = await db()
    .prepare("SELECT payload FROM surge_generation_runs WHERE owner_id=? ORDER BY created_at DESC LIMIT 12")
    .bind(ownerId).all<{ payload: string }>();
  return rows.results.map((row) => JSON.parse(row.payload) as SurgeJob);
}

export async function getSurgeJob(id: string) {
  await ensureSchema();
  const row = await db().prepare("SELECT payload FROM surge_generation_runs WHERE id=?")
    .bind(id).first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as SurgeJob) : null;
}

export async function createSurgeJob(job: SurgeJob) {
  await ensureSchema();
  try {
    await db().prepare(
      "INSERT INTO surge_generation_runs (id,owner_id,pool,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(job.id, job.ownerId, job.pool, job.status, JSON.stringify(job), Date.parse(job.createdAt), Date.now()).run();
  } catch (error) {
    if (/UNIQUE constraint/i.test(String(error))) {
      throw new Error("이미 급등주 전략 생성이 진행 중입니다. 진행 중인 작업을 완료하거나 취소하세요.");
    }
    throw error;
  }
}

/**
 * A lease outlives the request that took it only when that request dies, so its
 * length is how long an orphaned stage blocks the run. Model stages need
 * minutes; one download chunk needs well under two.
 */
export const SURGE_LEASE_MS = { model: 360_000, download: 150_000 } as const;

export async function claimSurgeJob(id: string, token: string, leaseMs: number = SURGE_LEASE_MS.model) {
  const now = Date.now();
  const result = await db().prepare(
    "UPDATE surge_generation_runs SET lease_owner=?,lease_until=? WHERE id=? AND status='running' AND (lease_owner IS NULL OR lease_until<?)",
  ).bind(token, now + leaseMs, id, now).run();
  return result.meta.changes === 1;
}

export async function saveSurgeJob(job: SurgeJob, token: string) {
  job.updatedAt = new Date().toISOString();
  const result = await db().prepare(
    "UPDATE surge_generation_runs SET payload=?,status=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND status='running'",
  ).bind(JSON.stringify(job), job.status, Date.now(), job.id, token).run();
  return result.meta.changes === 1;
}

export async function surgeProgress(job: SurgeJob, token: string, leaseMs: number = SURGE_LEASE_MS.model) {
  job.updatedAt = new Date().toISOString();
  const result = await db().prepare(
    "UPDATE surge_generation_runs SET payload=?,updated_at=?,lease_until=? WHERE id=? AND lease_owner=? AND status='running'",
  ).bind(JSON.stringify(job), Date.now(), Date.now() + leaseMs, job.id, token).run();
  if (result.meta.changes !== 1) throw new Error("작업 취소 또는 실행 잠금 해제됨");
}

/** Update only telemetry, without releasing the lease or overwriting cancellation. */
export async function saveSurgeActivities(id: string, token: string, activities: SurgeJob["activities"]) {
  await db().prepare(
    "UPDATE surge_generation_runs SET payload=json_set(payload,'$.activities',json(?)) WHERE id=? AND lease_owner=? AND status='running'",
  ).bind(JSON.stringify(activities), id, token).run();
}

export async function cancelSurgeJob(job: SurgeJob) {
  job.status = "cancelled";
  job.error = "사용자가 생성을 취소했습니다.";
  job.updatedAt = new Date().toISOString();
  await db().prepare(
    "UPDATE surge_generation_runs SET payload=?,status='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status IN ('running','paused')",
  ).bind(JSON.stringify(job), Date.now(), job.id).run();
}

export async function nextSurgeJob() {
  await ensureSchema();
  const row = await db()
    .prepare("SELECT id FROM surge_generation_runs WHERE status='running' ORDER BY created_at LIMIT 1")
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function resumeSurgeGeneration(job: SurgeJob) {
  if (job.status !== "paused" || (job.pauseReason !== "budget" && job.pauseReason !== "provider")) {
    throw new Error("예산 또는 크레딧 대기 중인 연구만 재개할 수 있습니다.");
  }
  const previous = JSON.stringify(job);
  const legacyBudgetPause = job.pauseReason === "budget";
  delete job.budgetUsd;
  job.status = "running";
  job.updatedAt = new Date().toISOString();
  job.error = null;
  delete job.pauseReason;
  delete job.nextAction;
  delete job.retryAt;
  job.events.push({
    at: new Date().toISOString(), stage: "plan", state: "done",
    detail: legacyBudgetPause ? "API 예산 제한 없이 저장된 단계에서 재개" : "사용자가 크레딧 충전 후 재개 · 저장된 단계에서 이어감", role: null,
  });
  await db().prepare(
    "UPDATE surge_generation_runs SET status='running',payload=?,updated_at=? WHERE id=? AND status='paused' AND payload=?",
  ).bind(JSON.stringify(job), Date.now(), job.id, previous).run();
}

// -------------------------------------------------------- shared market cache

/** The only basis the ranking accepts. See the header of `lib/surge-universe.ts`. */
export const PRICE_BASIS = "raw-events-v2";

export async function readMarketDay(date: string): Promise<CompactMarketRow[] | null> {
  await ensureSchema();
  const row = await db().prepare("SELECT payload FROM surge_market_days WHERE trading_date=? AND basis=?")
    .bind(date, PRICE_BASIS).first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as CompactMarketRow[]) : null;
}

export async function writeMarketDay(date: string, rows: CompactMarketRow[]) {
  await db().prepare(
    "INSERT OR REPLACE INTO surge_market_days (trading_date,payload,tickers,created_at,basis) VALUES (?,?,?,?,?)",
  ).bind(date, JSON.stringify(rows), rows.length, Date.now(), PRICE_BASIS).run();
  // A ranking built from adjusted closes is not repairable, only replaceable.
  await db().prepare("DELETE FROM surge_rank_days WHERE ranked_on=? AND basis<>?").bind(date, PRICE_BASIS).run();
}

export async function writeRankDay(rankedOn: string, pools: Record<SurgePool, SurgeCandidate[]>) {
  const statements = (Object.entries(pools) as Array<[SurgePool, SurgeCandidate[]]>).map(([pool, candidates]) =>
    db().prepare("INSERT OR REPLACE INTO surge_rank_days (id,ranked_on,pool,payload,created_at,basis) VALUES (?,?,?,?,?,?)")
      .bind(`${pool}|${rankedOn}`, rankedOn, pool, JSON.stringify(candidates), Date.now(), PRICE_BASIS));
  await db().batch(statements);
}

export async function readRankDays(pool: SurgePool, from: string, to: string) {
  await ensureSchema();
  const rows = await db().prepare(
    "SELECT ranked_on, payload FROM surge_rank_days WHERE pool=? AND basis='raw-events-v2' AND ranked_on BETWEEN ? AND ? ORDER BY ranked_on",
  ).bind(pool, from, to).all<{ ranked_on: string; payload: string }>();
  return rows.results.map((row) => ({
    rankedOn: row.ranked_on,
    candidates: JSON.parse(row.payload) as SurgeCandidate[],
  }));
}

/** How much of the shared ranking history already exists, for the UI's honesty panel. */
export async function surgeMarketInventory() {
  await ensureSchema();
  const row = await db().prepare(
    "SELECT COUNT(*) sessions, MIN(trading_date) firstDate, MAX(trading_date) lastDate FROM surge_market_days WHERE basis='raw-events-v2'",
  ).first<{ sessions: number; firstDate: string | null; lastDate: string | null }>();
  return {
    sessions: row?.sessions ?? 0,
    firstDate: row?.firstDate ?? null,
    lastDate: row?.lastDate ?? null,
  };
}

// ----------------------------------------------------------------- splits

export async function writeSplits(events: SplitEvent[]) {
  if (!events.length) return 0;
  for (let index = 0; index < events.length; index += 20) {
    await db().batch(events.slice(index, index + 20).map((event) =>
      db().prepare("INSERT OR REPLACE INTO surge_splits (id,ticker,execution_date,split_from,split_to,created_at) VALUES (?,?,?,?,?,?)")
        .bind(`${event.ticker}|${event.executionDate}`, event.ticker, event.executionDate, event.from, event.to, Date.now())));
  }
  return events.length;
}

/** Tickers whose split executed on `date` — their raw close-over-close move is an artifact. */
export async function splitsOn(date: string) {
  await ensureSchema();
  const rows = await db().prepare("SELECT ticker FROM surge_splits WHERE execution_date=?")
    .bind(date).all<{ ticker: string }>();
  return new Set(rows.results.map((row) => row.ticker));
}

export async function surgeSplitInventory() {
  await ensureSchema();
  const row = await db().prepare(
    "SELECT COUNT(*) events, MIN(execution_date) firstDate, MAX(execution_date) lastDate FROM surge_splits",
  ).first<{ events: number; firstDate: string | null; lastDate: string | null }>();
  return { events: row?.events ?? 0, firstDate: row?.firstDate ?? null, lastDate: row?.lastDate ?? null };
}

// ------------------------------------------------------------ session loading

/**
 * Same-day event sessions for the replay.
 *
 * Each date's envelope (`observationUniverse`) names whose minutes to read; the
 * events are then found by replaying those ONE-minute bars through
 * `observeSurgeDay`, whatever the rule's own resolution. Bars at the rule's
 * resolution are rolled up from the same minutes on the hour grid, keeping only
 * complete buckets — the same bars the live runner builds from Toss candles.
 *
 * Memory is the constraint: a busy day has dozens of events. So each event keeps
 * only the bars a rule can read — `surgeReach` — and the regular-session bars
 * trimmed before that span are carried as running totals (`SessionPrefix`), which
 * is all the session features need. `rule` narrows further to events the rule
 * could trade at all; the designer's survey passes none.
 */
export async function loadIntradaySurgeSessions(
  pool: SurgePool,
  dates: string[],
  interval: SurgeInterval,
  rule: SurgeCandidateSpec | null = null,
): Promise<SurgeSession[]> {
  if (!dates.length) return [];
  const envelopes = new Map((await readRankDays(pool, dates[0], dates.at(-1)!)).map(row => [row.rankedOn, row.candidates]));
  const step = intervalMinutes(interval);
  const eligible = rule ? compileSurgeStrategy({ version: 2, id: "reach", candidate: rule, evidence: "" }).eligible : () => true;
  const sessions: SurgeSession[] = [];
  for (const date of dates) {
    const seeds = envelopes.get(date);
    if (!seeds) throw new Error(`${date} 당일 관측 모집단이 없습니다. 일별 시세부터 재구성해야 합니다.`);
    const session: SurgeSession = { date, candidates: [], bars: {}, prefix: {} };
    let missing = 0;
    for (let index = 0; index < seeds.length; index += 40) {
      const chunk = seeds.slice(index, index + 40);
      const minutes = new Map((await readSurgeBars("1m", chunk.map(c => c.symbol), [date])).map(row => [row.symbol, row.bars]));
      for (const seed of chunk) {
        const bars = minutes.get(seed.symbol);
        if (!bars?.length) { missing++; continue; }
        const event = observeSurgeDay(seed, bars, pool);
        if (!event) continue;
        session.candidates.push(event);
        if (!eligible(event)) continue;
        const reach = surgeReach(rule, event.observedAt!);
        const regular = rollUpComplete(bars, step).filter(bar => bar.time >= SURGE_DAY_FROM && bar.time < SURGE_DAY_TO);
        session.bars[event.symbol] = regular.filter(bar => bar.time >= reach.from && bar.time < reach.to);
        const head = sessionPrefix(regular.filter(bar => bar.time < reach.from));
        if (head) session.prefix![event.symbol] = head;
      }
    }
    if (seeds.length && missing / seeds.length > 0.2) throw new Error(`${date} 관측 모집단 분봉 누락 ${missing}/${seeds.length} — 당일 사건을 검증할 수 없습니다.`);
    sessions.push(session);
  }
  return sessions;
}

/** The resolution a candidate's sessions have to be loaded at, and a cache key for that load. */
export function sessionShape(candidate: SurgeCandidateSpec) {
  return { interval: candidate.barInterval, rule: candidate, key: JSON.stringify(candidate) };
}

// ----------------------------------------------------------------- publishing

export async function registeredSurgeSpecs(): Promise<Array<{ runId: string; pool: SurgePool; spec: SurgeSpec }>> {
  await ensureSchema();
  const rows = await db()
    .prepare("SELECT run_id, pool, spec_payload FROM generated_surge_strategies ORDER BY created_at DESC")
    .all<{ run_id: string; pool: string; spec_payload: string }>();
  // Only rules in today's language trade; an older prior-day or slot-bound rule stays in its report only.
  return rows.results.flatMap((row) => {
    try {
      return [{ runId: row.run_id, pool: row.pool as SurgePool, spec: parseSurgeSpec(JSON.parse(row.spec_payload)) }];
    } catch {
      return [];
    }
  });
}

export async function publishSurge(job: SurgeJob, token: string) {
  if (job.researchVersion !== SURGE_RESEARCH_VERSION || job.selected?.version !== 2) throw new Error("이전 연구는 당일 관측 전략으로 등록할 수 없습니다.");
  if (!job.selected || !job.evidence?.passed || !job.finalReview?.approved ||
      job.finalReview.blockers.length || !job.riskReview?.approved) {
    throw new Error("검증 승인 증거가 없습니다.");
  }
  if (job.riskReview.blockers.length || job.frozenHash !== (await surgeSpecHash(job.selected))) {
    throw new Error("동결 규칙 또는 위험 검증 기록 불일치");
  }
  if (surgeEvidenceProblems(job.evidence).length) {
    throw new Error("검증 수치가 등록 기준을 충족하지 못합니다.");
  }
  compileSurgeStrategy(job.selected);

  const existing = await db().prepare("SELECT run_id FROM generated_surge_strategies WHERE run_id=?")
    .bind(job.id).first<{ run_id: string }>();
  if (existing) return;

  const completed: SurgeJob = {
    ...job,
    status: "completed",
    updatedAt: new Date().toISOString(),
    events: [...job.events, {
      at: new Date().toISOString(), stage: "publish", state: "done",
      detail: "급등주 전략 등록 완료", role: null,
    }],
  };
  const results = await db().batch([
    db().prepare(
      `INSERT INTO generated_surge_strategies (id,run_id,owner_id,pool,spec_payload,evidence_payload,created_at)
       SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM surge_generation_runs WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?)`,
    ).bind(
      job.selected.id, job.id, job.ownerId, job.pool,
      JSON.stringify(job.selected),
      JSON.stringify({
        frozenHash: job.frozenHash,
        evidence: job.evidence,
        review: job.finalReview,
        report: job.report,
      }),
      Date.now(), job.id, token, Date.now(),
    ),
    db().prepare(
      `UPDATE surge_generation_runs SET status='completed',payload=?,updated_at=?,lease_owner=NULL,lease_until=NULL
       WHERE id=? AND status='running' AND lease_owner=? AND EXISTS (SELECT 1 FROM generated_surge_strategies WHERE run_id=?)`,
    ).bind(JSON.stringify(completed), Date.now(), job.id, token, job.id),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    throw new Error("등록 전에 작업이 취소되었거나 실행 잠금을 잃었습니다.");
  }
}
