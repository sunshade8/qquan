import { z } from "zod";
import { researchFailure, uncertainResearchCost } from "./research-recovery.ts";
import { IncompleteResponseError } from "./llm-error.ts";
import { designerRequestChars } from "./designer-request-size.ts";
import {
  designerTurn,
  generationCall,
  loadFreeCatalog,
  virtualCostUsd,
  type DesignerTurn,
  type DesignerTurnRequest,
} from "./t-generation-llm.ts";
import type { AnthropicUsage } from "@/lib/llm-usage";
import {
  researchModel,
  researchCallLimits,
  type GenerationRole,
} from "./t-generation-models.ts";
import {
  type GenerationJob,
  type ResearchCall,
  type ResearchMeter,
  publicJob,
} from "./t-generation-types.ts";
import {
  getGenerationJob,
  claimGenerationJob,
  generationProgress,
  saveResearchMeter,
  saveGenerationJob,
} from "./t-generation-store.ts";

/**
 * T's research driver: CT's paid-call ledger and stage loop, CT branch only, over free models.
 * Every call still reserves, meters and commits durably; the cost is virtual (see t-generation-models.ts).
 */
type ResearchRuntime = { token: string; onUsage: (meter: ResearchMeter) => void };
const runtimes = new WeakMap<GenerationJob, ResearchRuntime>();
type PaidResult<T> = { data: T; costUsd: number; model?: string; sources?: Array<{ url: string; title: string }>; searchCalls?: number; reasoningTokens?: number | null };
type CallLimits = ReturnType<typeof researchCallLimits>;
/**
 * The most a call of `role` may bring the run's total to (reserve included). Design and strategy search keep a review reserve
 * back (reserveFraction); the reviewers and the final phases may spend it. Stage 5: the lesson distillation's own money is
 * withheld from every other CT call from the start and only the distillation may spend it (lessonReserveUsd).
 */
export function researchCeilingUsd(job: Pick<GenerationJob, "budgetUsd" | "search" | "ct">, role: GenerationRole) {
  const lessonReserve = job.ct && role !== "ctLessons" ? job.ct.contract.policy.lessonReserveUsd ?? 0 : 0;
  const base =
    job.search && job.search.phase !== "final"
      ? job.budgetUsd * (1 - job.search.config.reserveFraction)
      : job.ct && role !== "ctLessons" && !["risk_review", "final", "evidence_review"].includes(job.ct.phase)
        ? job.budgetUsd * (1 - job.ct.contract.policy.reserveFraction)
        : job.budgetUsd;
  return base - lessonReserve;
}
/**
 * The one paid-call ledger for research. Every model call — a structured ask or one turn of
 * the CT designer's session — goes through here, so each gets: reuse of a completed
 * response by key, interrupted calls budgeted at their reserve, changed limits after a
 * truncation, a durable reservation BEFORE spending, live metering, and the final cost.
 */
async function paidCall<T>(
  job: GenerationJob,
  role: GenerationRole,
  key: string,
  reserveFor: (limits: CallLimits) => number,
  run: (limits: CallLimits, onUsage: (usage: AnthropicUsage, estimated: boolean) => Promise<void>) => Promise<PaidResult<T>>,
  extra: { label?: string } = {},
): Promise<T> {
  const runtime = runtimes.get(job)!;
  const model = researchModel(role, job.recovery?.failures);
  job.calls ??= [];
  for (const prior of job.calls) {
    if (prior.status === "failed" && prior.error === "에이전트 입력이 예산을 초과했습니다.") {
      // generationCall rejects this exact error before constructing any SDK request.
      prior.uncertainUsd = 0;
      prior.costUsd = 0;
      prior.estimated = false;
      prior.usage = {};
    }
  }
  const cached = job.calls.find(call => call.key === key && call.status === "completed");
  if (cached) return cached.result as T;
  // A killed worker may have incurred charges even if its final response was lost.
  for (const old of job.calls.filter(call => call.status === "started")) {
    old.status = "interrupted";
    old.uncertainUsd = old.reserveUsd;
    old.error = "연결 중단으로 최종 사용량 미확인";
  }
  // A CT call already cut off at its output allowance is retried with changed limits, never identical ones.
  const limits = researchCallLimits(role, { ct: Boolean(job.ct), truncated: job.calls.some(call => call.key === key && call.incompleteReason === "max_output_tokens") });
  const reserve = reserveFor(limits);
  const ceiling = researchCeilingUsd(job, role);
  if (job.costUsd + uncertainResearchCost(job.calls) + reserve > ceiling)
    throw new ResearchBudgetError(`연구 예산 $${job.budgetUsd} 내 추가 호출 여유가 없습니다. 미확인 호출 비용도 한도에 포함합니다.`);
  const now = new Date().toISOString();
  const call: ResearchCall = { id: crypto.randomUUID(), key, role, model: model.model, provider: model.provider,
    status: "started", startedAt: now, updatedAt: now, usage: {}, estimated: true, costUsd: 0, reserveUsd: reserve, ...limits, ...(extra.label ? { label: extra.label } : {}) };
  job.calls.push(call);
  await generationProgress(job, runtime.token); // Intent is durable BEFORE spending money.
  let persistedAt = Date.now(), meteredAt = 0;
  let accounted = false;
  const meter = () => {
    const { result: _result, key: _key, ...publicCall } = call;
    void _result; void _key;
    const snapshot = { jobId: job.id, call: publicCall, costUsd: job.costUsd, uncertainUsd: uncertainResearchCost(job.calls) };
    runtime.onUsage(snapshot);
    return snapshot;
  };
  // Hidden reasoning streams no events; keep the 360s lease alive so a long call is never re-claimed and paid twice.
  const keepAlive = setInterval(() => {
    if (Date.now() - persistedAt < 60_000) return;
    persistedAt = Date.now();
    // A cancellation surfaces at the next checkpoint or commit.
    generationProgress(job, runtime.token).catch(() => undefined);
  }, 30_000);
  try {
    const result = await run(limits, async (usage, estimated) => {
      call.usage = usage;
      call.estimated = estimated;
      call.costUsd = virtualCostUsd(usage);
      call.updatedAt = new Date().toISOString();
      const snapshot = meter();
      if (Date.now() - meteredAt >= 2000 || !estimated) {
        await saveResearchMeter(snapshot, runtime.token);
        meteredAt = Date.now();
      }
      // Stream to the browser immediately; checkpoint at most once per 10s to avoid D1 overload.
      if (Date.now() - persistedAt >= 10_000) {
        await generationProgress(job, runtime.token);
        persistedAt = Date.now();
      }
    });
    // T calls `auto`; record the model the router actually used (x-routed-via).
    if (result.model) call.model = result.model;
    call.sources = result.sources;
    call.searchCalls = result.searchCalls;
    call.reasoningTokens = result.reasoningTokens;
    call.result = result.data;
    call.status = "completed";
    call.estimated = false;
    call.costUsd = result.costUsd;
    call.updatedAt = new Date().toISOString();
    job.costUsd += result.costUsd;
    accounted = true;
    // A replay reuses the validated response even if the following stage commit was interrupted.
    await generationProgress(job, runtime.token);
    await saveResearchMeter(meter(), runtime.token);
    return result.data;
  } catch (error) {
    if (!accounted) {
      call.status = "failed";
      const failure = researchFailure(error);
      call.error = failure.message;
      if (error instanceof IncompleteResponseError) {
        call.incompleteReason = error.reason;
        call.reasoningTokens = error.reasoningTokens;
      }
      if ([400, 401, 402, 403, 404, 429].includes(failure.status)) {
        call.usage = {}; call.costUsd = 0; call.estimated = false;
      }
      if (call.estimated) call.uncertainUsd = call.reserveUsd;
      else job.costUsd += call.costUsd;
      await generationProgress(job, runtime.token);
    }
    meter();
    throw error;
  } finally {
    clearInterval(keepAlive);
  }
}
async function sha256(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
async function ask<T extends z.ZodType>(job: GenerationJob, role: GenerationRole, schema: T, prompt: string) {
  // Reject oversized input before reserving a paid call or recording uncertain spend.
  if (prompt.length > 140_000) throw new Error("에이전트 입력이 예산을 초과했습니다.");
  const key = await sha256({
    ct: job.ct?.phase, role, prompt, schema: z.toJSONSchema(schema), option: job.research?.current, attempt: job.attempt, stage: job.stageIndex,
  });
  const model = researchModel(role, job.recovery?.failures);
  const webSearch = Boolean(job.ct && job.ct.phase === "sources");
  const schemaChars = JSON.stringify(z.toJSONSchema(schema)).length;
  const data = await paidCall(job, role, key,
    // Includes system/schema overhead and a conservative UTF token bound, including retries.
    limits => ((prompt.length + schemaChars + 4000) * 2 * model.input + limits.maxOutputTokens * model.output) / 1_000_000,
    (limits, onUsage) => generationCall(job.ownerId, role, schema, prompt, {
      failures: job.recovery?.failures, ct: Boolean(job.ct), webSearch, ...limits, onUsage,
      ...(job.ct ? { cacheKey: `ct-${job.id}` } : {}),
    }));
  return schema.parse(data);
}
/**
 * One paid turn of the CT designer's research session. The key binds the run, session, turn
 * and the exact preceding messages, so a resumed runner reuses a turn it already paid for.
 * Reserved per turn: input priced as a cache write, output at the turn's allowance.
 */
async function askTurn(job: GenerationJob, role: GenerationRole, request: DesignerTurnRequest, at: { session: number; turn: number }, label: string) {
  const key = await sha256({ ct: "design-session-turn", run: job.id, role, session: at.session, turn: at.turn, prev: await sha256(request) });
  const model = researchModel(role, job.recovery?.failures);
  // Base64 chart images count as the tokens they cost, not as 4 characters of text each.
  const chars = designerRequestChars(request);
  return paidCall<DesignerTurn>(job, role, key,
    limits => ((chars / 2) * model.input * 1.25 + limits.maxOutputTokens * model.output) / 1_000_000,
    (limits, onUsage) => designerTurn(job.ownerId, role, request, { failures: job.recovery?.failures, ct: true, ...limits, onUsage }),
    { label });
}
class ResearchBudgetError extends Error {}
/**
 * A CT call that hit its output allowance is retried once, immediately, with changed
 * limits (see researchCallLimits). A second truncation, or a role with nothing left to
 * change, pauses instead of spending again on the same outcome.
 */
function ctOutputLimit(job: GenerationJob, error: IncompleteResponseError) {
  const failed = job.calls?.at(-1);
  const truncations = failed ? job.calls!.filter(call => call.key === failed.key && call.incompleteReason === "max_output_tokens").length : 0;
  const next = failed ? researchCallLimits(failed.role, { ct: true, truncated: true }) : null;
  const changed = next && (next.maxOutputTokens !== error.maxOutputTokens || next.effort !== error.effort);
  const n = (value: number) => value.toLocaleString("en-US");
  job.error = error.message;
  if (next && changed && truncations === 1) {
    // A truncation is not a transient failure: it neither consumes the transient retry budget nor waits.
    const plan = `한도 ${n(next.maxOutputTokens)}토큰 · 추론 ${next.effort} 설정으로 1회 재시도`;
    job.recovery = { failures: job.recovery?.failures ?? 0, retryAt: new Date().toISOString(), message: plan };
    job.nextAction = `출력 한도 ${n(error.maxOutputTokens)}토큰 초과 · ${plan}. 기존 후보와 검증 기록은 유지됩니다.`;
    return;
  }
  job.recovery = { failures: job.recovery?.failures ?? 0, message: error.message };
  pause(job, "interrupted", error.message,
    `출력 한도 ${n(error.maxOutputTokens)}토큰 초과${truncations > 1 ? `가 조건을 바꾼 재시도에서도 반복되어` : "로"} 자동 재시도를 멈췄습니다` +
    `${error.reasoningTokens != null ? ` (출력 ${n(error.outputTokens)}토큰 중 추론 ${n(error.reasoningTokens)}토큰)` : ""}. ` +
    (next ? `재개하면 한도 ${n(next.maxOutputTokens)}토큰 · 추론 ${next.effort} 설정으로 다시 호출합니다(유료).` : "저장된 단계에서 재개할 수 있습니다."));
}
function pause(
  job: GenerationJob,
  reason: NonNullable<GenerationJob["pauseReason"]>,
  message: string,
  action: string,
) {
  job.status = "paused";
  job.pauseReason = reason;
  job.error = message;
  job.nextAction = action;
}

/** One durable stage/chunk per request. Reloads and the local runner resume from D1. */
export async function advanceGeneration(
  id: string,
  onProgress: (message: string) => void = () => undefined,
  onUsage: (meter: ResearchMeter) => void = () => undefined,
) {
  let job = await getGenerationJob(id);
  if (!job || job.status !== "running") return job;
  if (job.recovery?.retryAt && Date.parse(job.recovery.retryAt) > Date.now()) return job;
  const token = crypto.randomUUID();
  if (!(await claimGenerationJob(id, token))) return job;
  job = (await getGenerationJob(id))!;
  if (job.status !== "running") return job;
  runtimes.set(job, { token, onUsage });
  let committing = false;
  const commit = async () => {
    committing = true;
    await saveGenerationJob(job!, token);
    committing = false;
  };
  try {
    if (!job.ct) throw new Error("T 연구가 아닌 작업입니다.");
    await loadFreeCatalog();
    onProgress(`T 연구: ${job.ct.phase}`);
    const { advanceCTResearch } = await import("./t-research-store.ts");
    await advanceCTResearch(job, token, (role, schema, prompt) => ask(job!, role, schema, prompt),
      (role, request, at, label) => askTurn(job!, role, request, at, label));
    // A step that succeeded ends any earlier failure: the old error and its "retrying" note must not outlive the retry.
    delete job.recovery;
    job.error = null;
    delete job.nextAction;
    await commit();
    return (await getGenerationJob(id)) ?? job;
  } catch (error) {
    // Never run failure transitions on a mutated stage whose commit was ambiguous.
    if (/작업 취소 또는 실행 잠금/.test(String(error))) return await getGenerationJob(id);
    if (committing) throw error;
    const failure = researchFailure(error);
    if (job.ct && (error instanceof ResearchBudgetError || /CT 계산 시간 상한|백테스트 한도|CT 연구 권한·시간 한도/.test(String(error)))) {
      job.ct.phase = "done"; job.ct.passed = false; job.ct.endReason = `연구 한도 종료 · 통과 전략 없음 · ${error instanceof Error ? error.message : "한도"}`; job.status = "completed";
    } else if (job.ct && error instanceof IncompleteResponseError && error.truncated) {
      ctOutputLimit(job, error);
      onProgress(job.nextAction ?? error.message);
    } else if (failure.recoverable || job.recovery?.message.includes("실행 중단")) {
      const failures = (job.recovery?.failures ?? 0) + 1;
      job.error = failure.message;
      // Free tiers are exhausted by the day, not the second: a rate limit waits minutes, not seconds.
      if (failure.transient && failures < 6) {
        const seconds = failure.status === 429 ? Math.min(900, 60 * failures) : failures === 1 ? 10 : 30;
        job.recovery = { failures, retryAt: new Date(Date.now() + seconds * 1000).toISOString(), message: failure.message };
        job.nextAction = `${seconds}초 후 같은 단계 자동 재시도. 기존 후보와 검증 기록은 유지됩니다.`;
        onProgress(job.nextAction);
      } else {
        job.recovery = { failures, message: failure.message };
        pause(job, "interrupted", failure.message, "자동 복구를 멈췄습니다. 저장된 단계에서 이어갈 수 있습니다. 무료 한도는 UTC 자정에 초기화됩니다.");
      }
    } else {
      pause(job, "interrupted", error instanceof Error ? error.message : "T 실행 장애", "자료·API·모델 연결 복구 후 저장된 단계에서 재개하세요.");
    }
    job.events.push({
      at: new Date().toISOString(),
      stage: "plan",
      state: "error",
      detail: job.error ?? (error instanceof Error ? error.message : "T 실행 실패"),
      role: null,
    });
    await commit();
  }
  // A cancellation wins over a late result returned by a provider.
  return (await getGenerationJob(id)) ?? job;
}
export { publicJob };
