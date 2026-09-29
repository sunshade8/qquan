import { env } from "cloudflare:workers";
import { easternParts, shiftDate } from "./market-clock.ts";
import { ensureSchema } from "@/db/ensure";
import { RELAY_STRATEGIES } from "./relay-strategies.ts";
import {
  compileStrategy,
  strategySpecHash,
  type StrategySpec,
} from "./strategy-generation-spec.ts";
import type { GenerationJob } from "./strategy-generation-types.ts";
import { evidenceProblems } from "./strategy-generation-validation.ts";
import type { SessionBars } from "./relay-engine.ts";

function db() {
  return (env as unknown as { DB: D1Database }).DB;
}
export async function listGenerationJobs(ownerId: string) {
  await ensureSchema();
  const rows = await db()
    .prepare(
      "SELECT payload FROM strategy_generation_runs WHERE owner_id=? ORDER BY created_at DESC LIMIT 12",
    )
    .bind(ownerId)
    .all<{ payload: string }>();
  return rows.results.map((r) => JSON.parse(r.payload) as GenerationJob);
}
export async function getGenerationJob(id: string) {
  await ensureSchema();
  const row = await db()
    .prepare("SELECT payload FROM strategy_generation_runs WHERE id=?")
    .bind(id)
    .first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as GenerationJob) : null;
}
export async function createGenerationJob(job: GenerationJob) {
  await ensureSchema();
  try {
    await db()
      .prepare(
        "INSERT INTO strategy_generation_runs (id,owner_id,slot,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        job.id,
        job.ownerId,
        job.slot,
        job.status,
        JSON.stringify(job),
        Date.parse(job.createdAt),
        Date.now(),
      )
      .run();
  } catch (error) {
    if (/UNIQUE constraint/i.test(String(error)))
      throw new Error(
        "이미 전략 생성이 진행 중입니다. 진행 중인 작업을 완료하거나 취소하세요.",
      );
    throw error;
  }
}
export async function claimGenerationJob(id: string, token: string) {
  const now = Date.now();
  const result = await db()
    .prepare(
      "UPDATE strategy_generation_runs SET lease_owner=?,lease_until=? WHERE id=? AND status='running' AND (lease_owner IS NULL OR lease_until<?)",
    )
    .bind(token, now + 360_000, id, now)
    .run();
  return result.meta.changes === 1;
}
export async function saveGenerationJob(job: GenerationJob, token: string) {
  job.updatedAt = new Date().toISOString();
  const result = await db()
    .prepare(
      "UPDATE strategy_generation_runs SET payload=?,status=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND status='running'",
    )
    .bind(JSON.stringify(job), job.status, Date.now(), job.id, token)
    .run();
  return result.meta.changes === 1;
}
export async function generationProgress(job: GenerationJob, token: string) {
  job.updatedAt = new Date().toISOString();
  const result = await db()
    .prepare(
      "UPDATE strategy_generation_runs SET payload=?,updated_at=?,lease_until=? WHERE id=? AND lease_owner=? AND status='running'",
    )
    .bind(JSON.stringify(job), Date.now(), Date.now() + 360_000, job.id, token)
    .run();
  if (result.meta.changes !== 1)
    throw new Error("작업 취소 또는 실행 잠금 해제됨");
}
export async function cancelGenerationJob(job: GenerationJob) {
  job.status = "cancelled";
  job.error = "사용자가 생성을 취소했습니다.";
  job.updatedAt = new Date().toISOString();
  await db()
    .prepare(
      "UPDATE strategy_generation_runs SET payload=?,status='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status IN ('running','paused')",
    )
    .bind(JSON.stringify(job), Date.now(), job.id)
    .run();
}
export async function nextGenerationJob() {
  await ensureSchema();
  const row = await db()
    .prepare(
      "SELECT id FROM strategy_generation_runs WHERE status='running' OR (status='paused' AND json_extract(payload,'$.pauseReason')='data' AND json_extract(payload,'$.to') < ?) ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at LIMIT 1",
    )
    .bind(shiftDate(easternParts(Date.now()).date, -1))
    .first<{ id: string }>();
  return row?.id ?? null;
}
export async function writeGenerationData(
  jobId: string,
  part: number,
  sessions: SessionBars[],
) {
  await db()
    .prepare(
      "INSERT OR REPLACE INTO strategy_generation_data (run_id,part,payload) VALUES (?,?,?)",
    )
    .bind(jobId, part, JSON.stringify(sessions))
    .run();
}
export async function readGenerationData(
  jobId: string,
): Promise<SessionBars[]> {
  const rows = await db()
    .prepare(
      "SELECT payload FROM strategy_generation_data WHERE run_id=? ORDER BY part",
    )
    .bind(jobId)
    .all<{ payload: string }>();
  const byDate = new Map<string, SessionBars>();
  for (const row of rows.results)
    for (const day of JSON.parse(row.payload) as SessionBars[]) {
      const merged = byDate.get(day.date) ?? { date: day.date, bars: {} };
      for (const [symbol, bars] of Object.entries(day.bars))
        merged.bars[symbol] = [...(merged.bars[symbol] ?? []), ...bars].sort(
          (a, b) => a.time.localeCompare(b.time),
        );
      byDate.set(day.date, merged);
    }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
/** Global account registry, matching the existing shared live/paper dashboards. Owner is provenance. */
export async function registeredRelayStrategies() {
  await ensureSchema();
  const rows = await db()
    .prepare(
      "SELECT spec_payload FROM generated_relay_strategies ORDER BY created_at",
    )
    .all<{ spec_payload: string }>();
  const generated = rows.results.map((r) =>
    compileStrategy(JSON.parse(r.spec_payload)),
  );
  const all = [...RELAY_STRATEGIES, ...generated];
  if (new Set(all.map((s) => s.slot)).size !== all.length)
    throw new Error("슬롯 중복 배정 — 실행 중단");
  return all;
}
export async function publishGeneration(job: GenerationJob, token: string) {
  if (
    !job.selected ||
    !job.evidence?.passed ||
    !job.finalReview?.approved ||
    job.finalReview.blockers.length ||
    !job.riskReview?.approved
  )
    throw new Error("검증 승인 증거가 없습니다.");
  if (
    job.riskReview.blockers.length ||
    job.frozenHash !== (await strategySpecHash(job.selected))
  )
    throw new Error("동결 규칙 또는 위험 검증 기록 불일치");
  if (evidenceProblems(job.evidence).length)
    throw new Error("검증 수치가 등록 기준을 충족하지 못합니다.");
  if (RELAY_STRATEGIES.some((s) => s.slot === job.slot))
    throw new Error("이미 코드 전략이 배정된 슬롯입니다.");
  compileStrategy(job.selected);
  const existing = await db()
    .prepare("SELECT run_id FROM generated_relay_strategies WHERE slot=?")
    .bind(job.slot)
    .first<{ run_id: string }>();
  if (existing?.run_id === job.id) return; // Recover after commit but before saving the completion event.
  const completed: GenerationJob = {
    ...job,
    status: "completed",
    updatedAt: new Date().toISOString(),
    events: [
      ...job.events,
      {
        at: new Date().toISOString(),
        stage: "publish",
        state: "done",
        detail: "슬롯 등록 완료",
        role: null,
      },
    ],
  };
  // The registry insert and job completion commit together. A racing cancel either
  // wins before both writes or observes completed; never a cancelled-but-live rule.
  const results = await db().batch([
    db()
      .prepare(
        "INSERT INTO generated_relay_strategies (id,slot,run_id,owner_id,spec_payload,evidence_payload,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM strategy_generation_runs WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?)",
      )
      .bind(
        job.selected.id,
        job.slot,
        job.id,
        job.ownerId,
        JSON.stringify(job.selected),
        JSON.stringify({
          frozenHash: job.frozenHash,
          evidence: job.evidence,
          review: job.finalReview,
          report: job.report,
        }),
        Date.now(),
        job.id,
        token,
        Date.now(),
      ),
    db()
      .prepare(
        "UPDATE strategy_generation_runs SET status='completed',payload=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_owner=? AND EXISTS (SELECT 1 FROM generated_relay_strategies WHERE run_id=?)",
      )
      .bind(JSON.stringify(completed), Date.now(), job.id, token, job.id),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1)
    throw new Error(
      "슬롯 등록 전에 작업이 취소되었거나 실행 잠금을 잃었습니다.",
    );
}
export async function registeredSpecs(): Promise<StrategySpec[]> {
  await ensureSchema();
  const rows = await db()
    .prepare("SELECT spec_payload FROM generated_relay_strategies")
    .all<{ spec_payload: string }>();
  return rows.results.map((r) => JSON.parse(r.spec_payload));
}

/** Read actual cached rows; absence is never reported as a completed download. */
export async function generationInventory() {
  await ensureSchema();
  const rows = await db()
    .prepare(
      "SELECT symbol, interval, provider, COUNT(*) sessions, MIN(trading_date) firstDate, MAX(trading_date) lastDate, SUM(json_array_length(payload)) bars FROM intraday_bar_days WHERE interval='5m' GROUP BY symbol, interval, provider",
    )
    .all<{
      symbol: string;
      interval: string;
      provider: string;
      sessions: number;
      firstDate: string;
      lastDate: string;
      bars: number;
    }>();
  return rows.results;
}

export async function resumeGenerationBudget(job: GenerationJob) {
  if (job.status !== "paused" || job.pauseReason !== "budget")
    throw new Error("예산 대기 중인 연구만 재개할 수 있습니다.");
  const previous = JSON.stringify(job);
  job.budgetUsd += 8;
  job.status = "running";
  job.error = null;
  delete job.pauseReason;
  delete job.nextAction;
  job.events.push({
    at: new Date().toISOString(),
    stage: "plan",
    state: "done",
    detail: "사용자가 연구 예산 $8 추가 · 저장된 단계에서 재개",
    role: null,
  });
  await db()
    .prepare(
      "UPDATE strategy_generation_runs SET status='running',payload=?,updated_at=? WHERE id=? AND status='paused' AND payload=?",
    )
    .bind(JSON.stringify(job), Date.now(), job.id, previous)
    .run();
}

/** Append only new dates; earlier test boundaries remain fixed by researchSessions. */
export async function resumeGenerationData(
  job: GenerationJob,
  to: string,
  tasks: NonNullable<GenerationJob["dataTasks"]>,
) {
  if (job.status !== "paused" || job.pauseReason !== "data" || to <= job.to)
    return;
  const previous = JSON.stringify(job);
  job.to = to;
  job.dataTasks = [...(job.dataTasks ?? []), ...tasks];
  job.status = "running";
  job.stageIndex = 0;
  job.error = null;
  delete job.pauseReason;
  delete job.nextAction;
  job.events.push({
    at: new Date().toISOString(),
    stage: "data",
    state: "done",
    detail: "새 거래일 데이터 자동 확보 재개",
    role: null,
  });
  await db()
    .prepare(
      "UPDATE strategy_generation_runs SET status='running',payload=?,updated_at=? WHERE id=? AND status='paused' AND payload=?",
    )
    .bind(JSON.stringify(job), Date.now(), job.id, previous)
    .run();
}
