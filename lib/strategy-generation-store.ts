import { researchFailure, retryResearchStorage } from "./research-recovery.ts";
import { GENERATION_STAGES } from "./strategy-generation-types.ts";
import { env } from "cloudflare:workers";
import { easternParts, shiftDate } from "./market-clock.ts";
import { ensureSchema } from "@/db/ensure";
import { RELAY_STRATEGIES } from "./relay-strategies.ts";
import {
  compileStrategy,
  strategySpecHash,
  type StrategySpec,
} from "./strategy-generation-spec.ts";
import type { GenerationJob, ResearchMeter } from "./strategy-generation-types.ts";
import { evidenceProblems } from "./strategy-generation-validation.ts";
import type { SessionBars } from "./relay-engine.ts";
import { rollUpComplete } from "./bar-rollup.ts";

type CompactGenerationData = {
  version: 2;
  sessions: Array<{ date: string; step: 1 | 3 | 5; bars: Record<string, Array<[string, number, number, number, number, number]>> }>;
};

function db() {
  return (env as unknown as { DB: D1Database }).DB;
}
async function listGenerationJobsOnce(ownerId: string) {
  await ensureSchema();
  const rows = await db()
    .prepare(
      "SELECT payload FROM strategy_generation_runs WHERE owner_id=? ORDER BY created_at DESC LIMIT 12",
    )
    .bind(ownerId)
    .all<{ payload: string }>();
  const jobs = rows.results.map((r) => JSON.parse(r.payload) as GenerationJob);
  const meters = await db().prepare("SELECT m.run_id, m.payload FROM strategy_generation_meters m JOIN strategy_generation_runs r ON r.id=m.run_id WHERE r.owner_id=? AND r.status='running'").bind(ownerId).all<{ run_id: string; payload: string }>();
  for (const row of meters.results) {
    const job = jobs.find(item => item.id === row.run_id);
    if (job) job.liveMeter = JSON.parse(row.payload) as ResearchMeter;
  }
  return jobs;
}
async function getGenerationJobOnce(id: string) {
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
async function claimGenerationJobOnce(id: string, token: string) {
  const now = Date.now();
  const result = await db()
    .prepare(
      "UPDATE strategy_generation_runs SET lease_owner=?,lease_until=? WHERE id=? AND status='running' AND (lease_owner IS NULL OR lease_until<?)",
    )
    .bind(token, now + 360_000, id, now)
    .run();
  return result.meta.changes === 1;
}
async function saveGenerationJobOnce(job: GenerationJob, token: string) {
  job.updatedAt = new Date().toISOString();
  const result = await db()
    .prepare(
      "UPDATE strategy_generation_runs SET payload=?,status=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND status='running'",
    )
    .bind(JSON.stringify(job), job.status, Date.now(), job.id, token)
    .run();
  return result.meta.changes === 1;
}
async function generationProgressOnce(job: GenerationJob, token: string) {
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
export async function pauseGenerationJob(job: GenerationJob) {
  if (job.status !== "running") throw new Error("실행 중인 연구만 일시정지할 수 있습니다.");
  job.status = "paused";
  job.pauseReason = "interrupted";
  job.error = "사용자가 일시정지했습니다. 저장된 실험부터 이어갈 수 있습니다.";
  await db().prepare("UPDATE strategy_generation_runs SET payload=?,status='paused',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running'")
    .bind(JSON.stringify(job), Date.now(), job.id).run();
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
async function writeGenerationDataOnce(
  jobId: string,
  part: number,
  sessions: SessionBars[],
) {
  // Store source candles once, compactly; a symbol-month of duplicated minute
  // objects can exceed D1's row limit. Derived resolutions are never persisted.
  const payload: CompactGenerationData = { version: 2, sessions: sessions.map(day => {
    const step = day.barsByStep?.[1] ? 1 : day.barsByStep?.[3] ? 3 : 5;
    const bars = day.barsByStep?.[step] ?? day.bars;
    return { date: day.date, step, bars: Object.fromEntries(Object.entries(bars).map(([symbol, rows]) => [symbol,
      rows.map(bar => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume] as [string, number, number, number, number, number]),
    ])) };
  }) };
  await db()
    .prepare(
      "INSERT OR REPLACE INTO strategy_generation_data (run_id,part,payload) VALUES (?,?,?)",
    )
    .bind(jobId, part, JSON.stringify(payload))
    .run();
}
async function readGenerationDataOnce(
  jobId: string,
  step: 1 | 3 | 5 = 5,
): Promise<SessionBars[]> {
  const rows = await db()
    .prepare(
      "SELECT payload FROM strategy_generation_data WHERE run_id=? ORDER BY part",
    )
    .bind(jobId)
    .all<{ payload: string }>();
  const byDate = new Map<string, SessionBars>();
  for (const row of rows.results) {
    const stored = JSON.parse(row.payload) as SessionBars[] | CompactGenerationData;
    const days: SessionBars[] = Array.isArray(stored) ? stored : stored.sessions.map(day => ({
      date: day.date, bars: {}, barsByStep: { [day.step]: Object.fromEntries(Object.entries(day.bars).map(([symbol, bars]) => [symbol,
        bars.map(([time, open, high, low, close, volume]) => ({ date: day.date, time, open, high, low, close, volume })),
      ])) },
    }));
    for (const day of days) {
      const merged: SessionBars = byDate.get(day.date) ?? { date: day.date, bars: {}, barsByStep: {} };
      const minutes = day.barsByStep?.[1];
      const source = minutes ?? day.barsByStep?.[step] ?? (step === 5 && !day.barsByStep ? day.bars : undefined);
      if (!source) throw new Error(`${day.date}: 저장된 연구에 ${step}분봉을 만들 원본이 없습니다.`);
      const target = merged.barsByStep![step] ??= {};
      for (const [symbol, bars] of Object.entries(source)) {
        const resolved = minutes ? rollUpComplete(bars, step) : bars;
        target[symbol] = [...new Map([...(target[symbol] ?? []), ...resolved].map(bar => [bar.time, bar])).values()]
          .sort((a, b) => a.time.localeCompare(b.time));
      }
      merged.bars = target;
      byDate.set(day.date, merged);
    }
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

/** Explicitly adopt one stored option. This only registers rules; it never starts trading. */
export async function registerResearchOption(job: GenerationJob, optionId: string) {
  const option = job.research?.options.find(item => item.id === optionId);
  if (job.status !== "completed" || !option || option.status !== "passed" || !option.selected ||
    !option.evidence?.passed || !option.riskReview?.approved || option.riskReview.blockers.length ||
    !option.finalReview?.approved || option.finalReview.blockers.length)
    throw new Error("완료된 연구의 검증 통과 후보만 배정할 수 있습니다.");
  if (option.selected.slot !== option.slot || option.frozenHash !== await strategySpecHash(option.selected) || evidenceProblems(option.evidence).length)
    throw new Error("동결된 규칙과 검증 근거가 일치하지 않습니다.");
  compileStrategy(option.selected);
  if (RELAY_STRATEGIES.some(strategy => strategy.slot === option.slot)) throw new Error("이미 전략이 배정된 시간대입니다.");
  await db().prepare("INSERT INTO generated_relay_strategies (id,slot,run_id,owner_id,spec_payload,evidence_payload,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM strategy_generation_runs WHERE id=? AND owner_id=? AND status='completed' AND payload=?) ON CONFLICT DO NOTHING")
    .bind(option.selected.id, option.slot, option.id, job.ownerId, JSON.stringify(option.selected),
      JSON.stringify({ frozenHash: option.frozenHash, evidence: option.evidence, review: option.finalReview, report: option.report }),
      Date.now(), job.id, job.ownerId, JSON.stringify(job)).run();
  const registered = await db().prepare("SELECT id FROM generated_relay_strategies WHERE slot=?").bind(option.slot).first<{ id: string }>();
  if (registered?.id !== option.selected.id) throw new Error("이 시간대에 다른 전략이 배정됐거나 연구 상태가 변경됐습니다. 새로고침 후 확인해 주세요.");
  return option.selected.id;
}

/** Read actual cached rows; absence is never reported as a completed download. */
export async function generationInventory() {
  await ensureSchema();
  const rows = await db()
    .prepare(
      "SELECT symbol, interval, provider, COUNT(*) sessions, MIN(trading_date) firstDate, MAX(trading_date) lastDate, SUM(json_array_length(payload)) bars FROM intraday_bar_days WHERE interval IN ('1m','5m') GROUP BY symbol, interval, provider",
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

export function listGenerationJobs(...args: Parameters<typeof listGenerationJobsOnce>) {
  return retryResearchStorage(() => listGenerationJobsOnce(...args));
}

export function getGenerationJob(...args: Parameters<typeof getGenerationJobOnce>) {
  return retryResearchStorage(() => getGenerationJobOnce(...args));
}

export function claimGenerationJob(...args: Parameters<typeof claimGenerationJobOnce>) {
  return retryResearchStorage(() => claimGenerationJobOnce(...args));
}

export function saveGenerationJob(...args: Parameters<typeof saveGenerationJobOnce>) {
  return retryResearchStorage(() => saveGenerationJobOnce(...args));
}

export function generationProgress(...args: Parameters<typeof generationProgressOnce>) {
  return retryResearchStorage(() => generationProgressOnce(...args));
}

export function writeGenerationData(...args: Parameters<typeof writeGenerationDataOnce>) {
  return retryResearchStorage(() => writeGenerationDataOnce(...args));
}

export function readGenerationData(...args: Parameters<typeof readGenerationDataOnce>) {
  return retryResearchStorage(() => readGenerationDataOnce(...args));
}

/** Compare-and-swap resumes the saved payload without clearing any research artifacts. */
export async function resumeGenerationFailure(job: GenerationJob) {
  if (!((job.status === "paused" && job.pauseReason === "interrupted") ||
    (job.status === "failed" && researchFailure(new Error(job.error ?? "")).recoverable)))
    throw new Error("복구 가능한 중단 연구만 이어갈 수 있습니다.");
  const previous = JSON.stringify(job);
  job.status = "running";
  job.error = null;
  job.recovery = { failures: 0, message: "사용자가 저장된 단계에서 연구 재개" };
  delete job.pauseReason;
  delete job.nextAction;
  job.events.push({ at: new Date().toISOString(),
    stage: job.research?.phase === "discovery" ? "discovery" : GENERATION_STAGES[job.stageIndex]?.id ?? "plan",
    state: "done", role: null, detail: "기존 후보·데이터·검증 기록 보존 · 중단 지점에서 재개" });
  const result = await retryResearchStorage(() => db().prepare(
    "UPDATE strategy_generation_runs SET status='running',payload=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND owner_id=? AND status IN ('failed','paused') AND payload=?"
  ).bind(JSON.stringify(job), Date.now(), job.id, job.ownerId, previous).run());
  if (result.meta.changes !== 1) {
    const current = await getGenerationJob(job.id);
    if (current?.status !== "running") throw new Error("연구 상태가 바뀌었습니다. 다시 확인해 주세요.");
  }
}

/** Small cross-worker snapshot: runner/browser viewers see progress without full-job writes. */
export function saveResearchMeter(meter: ResearchMeter, token: string) {
  return retryResearchStorage(async () => {
    const result = await db().prepare("INSERT INTO strategy_generation_meters (run_id,payload,updated_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM strategy_generation_runs WHERE id=? AND status='running' AND lease_owner=?) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at")
      .bind(meter.jobId, JSON.stringify(meter), Date.now(), meter.jobId, token).run();
    if (result.meta.changes !== 1) throw new Error("작업 취소 또는 실행 잠금 해제됨");
  });
}
