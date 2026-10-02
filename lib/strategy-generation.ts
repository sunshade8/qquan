import { z } from "zod";
import { advanceSlotResearch } from "@/lib/slot-research-store";
import { designBatchSchema } from "./slot-research-agent.ts";
import { researchFailure, uncertainResearchCost } from "./research-recovery.ts";
import { usageCostUsd } from "@/lib/llm-usage";
import { slotById, SLOTS, assertTradable } from "./trade-slots.ts";
import { researchRequestSchema, researchCalendar, discoveryPlanSchema, validateDiscoveryPlan } from "./strategy-discovery.ts";
import { discoverResearchUniverse } from "@/lib/strategy-discovery-data";
import { shiftDate } from "./market-clock.ts";
import { lastCompleteDate, loadRelaySessions } from "@/lib/relay-data";
import {
  generationAvailability,
  generationCall,
} from "@/lib/strategy-generation-llm";
import {
  GENERATION_MODELS,
  researchModel,
  researchMaxTokens,
  assertDifferentProvider,
  type GenerationRole,
} from "./strategy-generation-models.ts";
import {
  candidateSchema,
  candidatesSchema,
  planSchema,
  noteSchema,
  reviewSchema,
  compileStrategy,
  parseSpec,
  strategySpecHash,
  universeSchema,
  FEATURES,
  SLOT_IDS,
  EXECUTION_LIMITS,
  STRATEGY_INTERVALS,
  strategyBarMinutes,
} from "./strategy-generation-spec.ts";
import {
  VALIDATION_POLICY,
  auditDataset,
  sliceEvidence,
  validateFrozen,
} from "./strategy-generation-validation.ts";
import {
  splitResearchJob,
  researchDataId,
  summarizeResearch,
  candidateFeasibility,
} from "./strategy-generation-research.ts";
import { runRelay, ReplayDeadlineError, type SessionBars } from "./relay-engine.ts";
import {
  GENERATION_STAGES,
  type GenerationJob,
  type ResearchCall,
  type ResearchMeter,
  publicJob,
} from "./strategy-generation-types.ts";
import {
  createGenerationJob,
  getGenerationJob,
  claimGenerationJob,
  generationProgress,
  saveResearchMeter,
  saveGenerationJob,
  registeredRelayStrategies,
  writeGenerationData,
  readGenerationData,
  publishGeneration,
  resumeGenerationData,
} from "@/lib/strategy-generation-store";

export const createGenerationSchema = z
  .object({
    slot: z.enum(SLOT_IDS),
    universe: universeSchema,
    brief: z.string().max(1500).default(""),
    requestId: z.string().uuid(),
  })
  .strict();
const DETAIL_CHECKLIST = `Check ALL material execution assumptions: sufficient available USD cash, whole-share affordability, commissions and sell fees, spread/slippage/gaps, volume participation, missing/stale/crossed quotes, split-adjusted data and corporate actions, no future bars, no survivorship claims, market holidays/DST/early close/halt, limit price tick size, partial fills/cancels/rejections, ambiguous submission/idempotency, broker reconciliation and manual holdings, one position across slots, slot-end liquidation, cash settlement restrictions, daily loss circuit breaker, no short/leverage/borrow/FX conversion. Unsupported circumstances must skip entry, not be guessed. Broker enforces trading restrictions; stops are software monitored, cannot guarantee execution during halt/outage. OHLCV cannot prove queue priority or quote spread. Review must acknowledge these limits.`;

export async function createGeneration(ownerId: string, input: unknown) {
  const request = createGenerationSchema.parse(input);
  const existing = await getGenerationJob(request.requestId);
  if (existing) {
    if (existing.ownerId !== ownerId) throw new Error("요청 식별자 충돌");
    return existing;
  }
  const available = generationAvailability();
  if (!available.ready)
    throw new Error(
      `서버 키 필요: ${available.missing.join(", ")} (타사 검증 생략 불가)`,
    );
  if ((await registeredRelayStrategies()).some((s) => s.slot === request.slot))
    throw new Error("이미 전략이 등록된 슬롯입니다.");
  const to = lastCompleteDate();
  const now = new Date().toISOString();
  const job: GenerationJob = {
    id: request.requestId,
    ownerId,
    slot: request.slot,
    status: "running",
    stageIndex: 0,
    createdAt: now,
    updatedAt: now,
    from: shiftDate(to, -730),
    to,
    capitalUsd: 1000,
    brief: request.brief,
    universe: request.universe,
    sourceBarMinutes: 1,
    attempt: 1,
    validationWindow: 0,
    attempts: [],
    dataTasks: months(request.universe, shiftDate(to, -730), to),
    dataCursor: 0,
    dataSources: [],
    costUsd: 0,
    budgetUsd: 8,
    error: null,
    events: [],
  };
  await createGenerationJob(job);
  return job;
}

export async function createStrategyResearch(ownerId: string, input: unknown) {
  const request = researchRequestSchema.parse(input);
  const existing = await getGenerationJob(request.requestId);
  if (existing) {
    if (existing.ownerId !== ownerId) throw new Error("요청 식별자 충돌");
    return existing;
  }
  const availability = generationAvailability();
  if (!availability.ready) throw new Error(`연구 모델 연결 필요: ${availability.missing.join(", ")}`);
  if (request.universe) assertTradable(request.universe, "연구 범위");
  const to = lastCompleteDate(), from = shiftDate(to, -730), now = new Date().toISOString();
  const job: GenerationJob = {
    id: request.requestId, ownerId, slot: request.slot ?? "trend", status: "running", stageIndex: 0,
    createdAt: now, updatedAt: now, from, to, capitalUsd: 1000, brief: request.brief,
    costUsd: 0, budgetUsd: request.budgetUsd, error: null, events: [], universe: [], sourceBarMinutes: 1,
    attempt: 1, attempts: [], validationWindow: 0,
    research: { goal: request.goal, phase: "discovery", ...researchCalendar(from, to), consumedWindows: 0,
      constraints: { universe: request.universe, slot: request.slot }, options: [], current: 0, revisions: 0 },
  };
  await createGenerationJob(job);
  return job;
}

function beginResearchOption(job: GenerationJob) {
  const research = job.research!, option = research.options[research.current];
  option.status = "running";
  job.slot = option.slot;
  job.universe = [...option.universe];
  job.dataTasks = months(option.universe, job.from, job.to);
  job.dataCursor = 0;
  job.dataSources = [];
  job.validationWindow = research.consumedWindows;
  research.revisions = 0;
  delete job.researchSessions;
  delete job.dataSummary;
  delete job.dataNote;
  delete job.plan;
  delete job.candidates;
  delete job.riskReview;
  delete job.selected;
  delete job.training;
  delete job.trials;
  delete job.frozenAt;
  delete job.frozenHash;
  delete job.evidence;
  delete job.finalReview;
  delete job.report;
  job.error = null;
  job.stageIndex = 0;
}

function finishResearchOption(job: GenerationJob, reasons: string[] = []) {
  const research = job.research!, option = research.options[research.current];
  const passed = !reasons.length && job.evidence?.passed && job.finalReview?.approved && !job.finalReview.blockers.length;
  Object.assign(option, {
    status: passed ? "passed" : "rejected", reasons,
    selected: job.selected, training: job.training, evidence: job.evidence,
    frozenHash: job.frozenHash, riskReview: job.riskReview, finalReview: job.finalReview, report: job.report,
  });
  // Once any outcome is seen, that calendar window is spent across ALL scopes.
  if (job.evidence) research.consumedWindows++;
  if (research.current + 1 < research.options.length && research.consumedWindows < research.windows.length) {
    research.current++;
    beginResearchOption(job);
    job.stageIndex = -1; // the enclosing stage commit increments it
  } else {
    for (const queued of research.options.filter(item => item.status === "queued")) {
      queued.status = "rejected";
      queued.reasons = ["연구 전체의 미사용 검증 기간이 소진되어 실행하지 않았습니다."];
    }
    research.phase = "complete";
    job.status = "completed";
    job.error = null;
  }
}
function months(symbols: string[], from: string, to: string) {
  const tasks: Array<{ symbol: string; from: string; to: string }> = [];
  for (const symbol of symbols) {
    let cursor = from;
    while (cursor <= to) {
      const d = new Date(`${cursor.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      const next = d.toISOString().slice(0, 10),
        end = shiftDate(next, -1);
      tasks.push({ symbol, from: cursor, to: end < to ? end : to });
      cursor = next;
    }
  }
  return tasks;
}

/** Only one resolution is held at a time; the model still gets evidence for each choice. */
async function researchSummary(job: GenerationJob, sessions: SessionBars[]) {
  const summary = summarizeResearch(job, sessions);
  if (job.sourceBarMinutes === 1) for (const step of [1, 3] as const) {
    const data = await readGenerationData(researchDataId(job), step);
    summary.barResolutions.push(...summarizeResearch(job, data, step).barResolutions);
  }
  return summary;
}

/** Keep this slot plus the maximum 24-bar lookback at 5m, aligned for every supported grid. */
function researchWindow(sessions: SessionBars[], slot: NonNullable<ReturnType<typeof slotById>>, step: 1 | 5) {
  const start = Math.max(240, Math.floor((Number(slot.from.slice(0, 2)) * 60 + Number(slot.from.slice(3)) - 125) / 15) * 15);
  const from = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
  return sessions.map(day => {
    const bars = Object.fromEntries(Object.entries(day.bars).map(([symbol, rows]) => [symbol, rows.filter(bar => bar.time >= from && bar.time < slot.to)]));
    return { date: day.date, bars, barsByStep: { [step]: bars } };
  });
}
type ResearchRuntime = { token: string; onUsage: (meter: ResearchMeter) => void };
const runtimes = new WeakMap<GenerationJob, ResearchRuntime>();
async function ask<T extends z.ZodType>(job: GenerationJob, role: GenerationRole, schema: T, prompt: string) {
  // Reject oversized input before reserving a paid call or recording uncertain spend.
  if (prompt.length > 140_000) throw new Error("에이전트 입력이 예산을 초과했습니다.");
  const runtime = runtimes.get(job)!;
  const model = researchModel(role, job.recovery?.failures);
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
    role, prompt, schema: z.toJSONSchema(schema), option: job.research?.current, attempt: job.attempt, stage: job.stageIndex,
  })));
  const key = Array.from(new Uint8Array(keyBytes), value => value.toString(16).padStart(2, "0")).join("");
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
  if (cached) return schema.parse(cached.result);
  // A killed worker may have incurred charges even if its final response was lost.
  for (const old of job.calls.filter(call => call.status === "started")) {
    old.status = "interrupted";
    old.uncertainUsd = old.reserveUsd;
    old.error = "연결 중단으로 최종 사용량 미확인";
  }
  // Includes system/schema overhead and a conservative UTF token bound, including retries.
  const reserve = ((prompt.length + JSON.stringify(z.toJSONSchema(schema)).length + 4000) * 2 * model.input + researchMaxTokens(role) * model.output) / 1_000_000;
  const ceiling = job.search && job.search.phase !== "final" ? job.budgetUsd * (1 - job.search.config.reserveFraction) : job.budgetUsd;
  if (job.costUsd + uncertainResearchCost(job.calls) + reserve > ceiling)
    throw new ResearchBudgetError(`연구 예산 $${job.budgetUsd} 내 추가 호출 여유가 없습니다. 미확인 호출 비용도 한도에 포함합니다.`);
  const now = new Date().toISOString();
  const call: ResearchCall = { id: crypto.randomUUID(), key, role, model: model.model, provider: model.provider,
    status: "started", startedAt: now, updatedAt: now, usage: {}, estimated: true, costUsd: 0, reserveUsd: reserve };
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
  try {
    const result = await generationCall(job.ownerId, role, schema, prompt, {
      failures: job.recovery?.failures,
      onUsage: async (usage, estimated) => {
        call.usage = usage;
        call.estimated = estimated;
        call.costUsd = usageCostUsd(call.model, usage) ?? 0;
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
      },
    });
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
      if ([400, 401, 402, 403, 404, 429].includes(failure.status)) {
        call.usage = {}; call.costUsd = 0; call.estimated = false;
      }
      if (call.estimated) call.uncertainUsd = call.reserveUsd;
      else job.costUsd += call.costUsd;
      await generationProgress(job, runtime.token);
    }
    meter();
    throw error;
  }
}
class ResearchBudgetError extends Error {}
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
function revise(
  job: GenerationJob,
  stage: GenerationJob["events"][number]["stage"],
  reasons: string[],
  consumed = false,
) {
  job.attempts ??= [];
  job.attempts.push({
    attempt: job.attempt ?? 1,
    stage,
    reasons,
    candidates: job.candidates,
    trials: job.trials,
    riskReview: job.riskReview,
    evidence: job.evidence,
    finalReview: job.finalReview,
  });
  job.attempt = (job.attempt ?? 1) + 1;
  if (job.research && (consumed || ++job.research.revisions >= 2)) {
    finishResearchOption(job, reasons);
    return;
  }
  if (consumed) job.validationWindow = (job.validationWindow ?? 0) + 1;
  delete job.candidates;
  delete job.riskReview;
  delete job.selected;
  delete job.training;
  delete job.trials;
  delete job.frozenAt;
  delete job.frozenHash;
  delete job.evidence;
  delete job.finalReview;
  delete job.report;
  job.error = null;
  // The caller increments once after committing the stage event.
  job.stageIndex = GENERATION_STAGES.findIndex((s) => s.id === "plan") - 1;
}

/** One durable stage/chunk per request. Reloads and the local runner resume from D1. */
export async function advanceGeneration(
  id: string,
  onProgress: (message: string) => void = () => undefined,
  onUsage: (meter: ResearchMeter) => void = () => undefined,
) {
  let job = await getGenerationJob(id);
  if (
    !job?.search &&
    job?.status === "paused" &&
    job.pauseReason === "data" &&
    job.to < lastCompleteDate()
  ) {
    const to = lastCompleteDate();
    await resumeGenerationData(
      job,
      to,
      months(job.universe!, shiftDate(job.to, 1), to),
    );
    job = await getGenerationJob(id);
  }
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
  const stage = job.research?.phase === "discovery"
    ? { id: "discovery" as const, label: "종목과 시간대 탐색", role: "orchestrator" as const }
    : GENERATION_STAGES[job.stageIndex];
  try {
    if (job.search) {
      onProgress(`슬롯 연구: ${job.search.phase} · ${job.search.trials.length}개 시도`);
      await advanceSlotResearch(job, token, async (role, context) => ask(job!, role, reviewSchema,
        `Independent empirical strategy review. Deterministic gates cannot be relaxed. Do not invent executions or approval. Return Korean findings. ${JSON.stringify(context)}`),
        prompt => ask(job!, "designer", designBatchSchema, prompt));
      await commit();
      return (await getGenerationJob(id)) ?? job;
    }
    if (!stage) throw new Error("알 수 없는 생성 단계");
    if (!job.universe?.length && stage.id !== "discovery")
      throw new Error(
        "종목 범위가 없는 이전 작업입니다. 종목코드를 입력해 새 연구를 시작하세요.",
      );
    if (job.events.at(-1)?.state === "started") {
      const failures = (job.recovery?.failures ?? 0) + 1;
      job.recovery = { failures, message: "실행 중단 감지 · 저장된 단계 복구" };
      if (failures >= 3) throw new Error("반복된 실행 중단으로 자동 복구를 일시정지합니다.");
      onProgress("중단된 단계 복구 · 완료된 모델 응답과 기존 검증 기록 재사용");
    }
    job.error = null;
    delete job.nextAction;
    job.events.push({
      at: new Date().toISOString(),
      stage: stage.id,
      state: "started",
      detail: stage.label,
      role: stage.role,
    });
    await generationProgress(job, token);
    onProgress(stage.label);
    if (stage.id === "discovery") {
      const research = job.research!;
      research.discovery ??= await discoverResearchUniverse(job, onProgress);
      await generationProgress(job, token);
      const registered = await registeredRelayStrategies();
      const slots = SLOTS.filter(slot => (!research.constraints.slot || slot.id === research.constraints.slot) &&
        (research.goal !== "complement" || !registered.some(strategy => strategy.slot === slot.id)));
      if (!slots.length) throw new Error("연구할 빈 시간대가 없습니다. 자동 탐색으로 기존 전략의 대안을 비교할 수 있습니다.");
      const prompt = `RESEARCH_DISCOVERY: Build 1–3 distinct, ranked research options using only the measured candidate symbols and allowed slots. You choose symbols, time window and falsifiable hypothesis. These are options for empirical comparison, not buy/sell instructions. Do not refuse research because investing has risk. Evaluate liquidity, whole-share affordability and available training data. The daily snapshot is a coarse screen, not intraday evidence or proof of an edge. Prefer economical scopes of 1–2 symbols. Engine supports completed OHLCV return/VWAP/range/volume/breakout conditions, 1/3/5-minute bars, long-only, one entry per slot/day and slot-end exit. No news/options/shorting signals. Goal complement means target underrepresented time windows or different hypotheses; do not claim measured diversification or improved portfolio performance. User constraints may restrict choices. Do not promise returns or invent statistics. All options share one $${job.budgetUsd} budget and immutable chronological test blocks. Data: ${JSON.stringify({ goal: research.goal, brief: job.brief, capitalUsd: job.capitalUsd, constraints: research.constraints, discovery: research.discovery, slots, existingStrategies: registered.map(strategy => ({ name: strategy.name, slot: strategy.slot, universe: strategy.universe, summary: strategy.summary })) })}`;
      const plan = validateDiscoveryPlan(await ask(job, "orchestrator", discoveryPlanSchema, prompt),
        research.discovery.candidates.map(row => row.symbol), slots.map(slot => slot.id), research.constraints);
      research.summary = plan.summary;
      research.options = plan.options.map((option, index) => ({ ...option, id: `${job.id}:option:${index}`, status: "queued", reasons: [] }));
      research.phase = "experiments";
      beginResearchOption(job);
      job.events.push({ at: new Date().toISOString(), stage: "discovery", state: "done", detail: plan.summary, role: "orchestrator" });
      delete job.recovery;
      await commit();
      return (await getGenerationJob(id)) ?? job;
    }
    const slot = slotById(job.slot)!;
    if (stage.id === "plan" || stage.id === "data_review") {
      const sessions = await readGenerationData(researchDataId(job));
      if (
        (job.validationWindow ?? 0) >=
        splitResearchJob(job, sessions, true).windows
      ) {
        pause(
          job,
          "data",
          "확보한 미사용 검증 구간을 모두 사용했습니다.",
          "페이지 또는 러너가 실행 중이면 새 거래일 데이터를 자동 확보하고, 새로운 40세션(검증 20·최종 검증 20)이 모이면 같은 연구를 재개합니다.",
        );
        job.events.push({
          at: new Date().toISOString(),
          stage: stage.id,
          state: "done",
          detail: job.error!,
          role: stage.role,
        });
        await commit();
        return job;
      }
      job.dataSummary = await researchSummary(job, sessions);
    }
    const context = JSON.stringify({
      slot,
      brief: job.brief,
      researchOption: job.research?.options[job.research.current],
      previousOptions: job.research?.options.filter(option => option.status === "rejected" || option.status === "passed").map(option => ({ title: option.title, slot: option.slot, universe: option.universe, reasons: option.reasons, status: option.status })),
      capitalUsd: job.capitalUsd,
      universe: job.universe,
      barIntervals: job.sourceBarMinutes === 1 ? STRATEGY_INTERVALS : ["5m"],
      period: { from: job.from, to: job.to },
      trainingData: job.dataSummary,
      executionContract:
        "Engine sizes whole shares using 99% of available capital and 1% bar volume cap. No per-trade 0.5% risk sizing exists. StopPct is price movement, not portfolio risk. Spread/fees are modeled assumptions, not measured quotes. These known limitations require cautions, not fabricated facts or new approval requirements.",
      attempt: job.attempt,
      totalCandidatesTried: (job.attempts ?? []).reduce(
        (n, a) => n + (a.candidates?.length ?? 0),
        0,
      ),
      previousAttempts: (job.attempts ?? []).slice(-4).map((a) => ({
        attempt: a.attempt,
        stage: a.stage,
        reasons: a.reasons,
        candidates: a.candidates,
        trials: a.trials,
        riskReview: a.riskReview,
        measuredFailure: a.evidence
          ? {
              reasons: a.evidence.reasons,
              validation: a.evidence.validation.metrics,
              holdout: a.evidence.holdout.metrics,
              stress: a.evidence.stress.metrics,
              delayed: a.evidence.delayed.metrics,
            }
          : undefined,
      })),
      policy: {
        ...VALIDATION_POLICY,
        validationFraction: undefined,
        testWindowPolicy:
          "Initial train 60%; remaining dates are pre-partitioned into up to 3 chronological validation/holdout pairs with >=20 sessions each. Every consumed block becomes past training data for the next attempt. Appended data uses fresh 40-session pairs. Use supplied session counts, not a per-attempt 20% assumption.",
      },
      execution: EXECUTION_LIMITS,
    });
    switch (stage.id) {
      case "plan": {
        job.plan = await ask(
          job,
          "orchestrator",
          planSchema,
          `Act as the strategy research orchestrator. On revisions, reconcile previous blockers and executable rules with a new preregistered hypothesis for this attempt. Plan falsifiable cash-only intraday research for exactly this slot. Use exactly this experiment’s selected universe. Do not add or remove symbols. Assess measured whole-share affordability, liquidity and modeled costs before planning. You will delegate data summarization, rule design, independent Anthropic reviews and deterministic replay. Use training summaries only; never inspect future test blocks. No promise of returns. Context: ${context}\n${DETAIL_CHECKLIST}`,
        );
        if (
          job.plan.universe.length !== job.universe!.length ||
          job.plan.universe.some((s) => !job.universe!.includes(s))
        )
          revise(job, "plan", [
            "계획 모델이 지정 종목 범위를 변경했습니다. 사용자가 입력한 종목 전체를 그대로 사용해 계획을 다시 작성하세요.",
          ]);
        break;
      }
      case "data": {
        const cursor = job.dataCursor ?? 0,
          task = job.dataTasks?.[Math.min(cursor, job.dataTasks.length - 1)];
        if (!task) throw new Error("데이터 수집 계획 없음");
        const loaded = await loadRelaySessions(
          [task.symbol],
          task.from,
          task.to,
          0,
          onProgress,
          job.sourceBarMinutes ?? 5,
        );
        if (loaded.sources.some((s) => s.provider !== "Massive"))
          throw new Error(
            "검증 데이터는 Massive 단일 출처가 필요합니다. 대체 데이터로 승격하지 않습니다.",
          );
        if (loaded.warnings.length) throw new Error(loaded.warnings.join("; "));
        const sourceIssues = auditDataset(loaded.sessions, [task.symbol], slot, job.sourceBarMinutes ?? 5);
        if (sourceIssues.length) throw new Error(`데이터 품질 부족: ${sourceIssues.join("; ")}`);
        await writeGenerationData(researchDataId(job), Math.min(cursor, job.dataTasks!.length - 1), researchWindow(loaded.sessions, slot, job.sourceBarMinutes ?? 5));
        job.dataSources = (job.dataSources ?? []).filter(source => !(source.symbol === task.symbol && source.from === task.from && source.to === task.to));
        job.dataSources.push(
          ...loaded.sources.map((s) => ({
            symbol: s.symbol,
            provider: s.provider,
            bars: s.bars,
            from: task.from,
            to: task.to,
          })),
        );
        job.dataCursor = Math.min(cursor + 1, job.dataTasks!.length);
        if (job.dataCursor < job.dataTasks!.length) {
          job.events.push({
            at: new Date().toISOString(),
            stage: stage.id,
            state: "done",
            detail: `데이터 ${job.dataCursor}/${job.dataTasks!.length} 구간 확보`,
            role: null,
          });
          delete job.recovery;
          await commit();
          return job;
        }
        const sessions = await readGenerationData(researchDataId(job)),
          issues = auditDataset(sessions, job.universe!, slot);
        if (issues.length)
          throw new Error(`데이터 품질 부족: ${issues.join("; ")}`);
        if (job.research) {
          const split = splitResearchJob(job, sessions);
          if (split.train.length < 90 || split.validation.length < 20 || split.holdout.length < 20)
            throw new Error(`고정 검증 기간의 데이터 부족: 학습 ${split.train.length}, 검증 ${split.validation.length}, 최종 ${split.holdout.length}세션`);
        }
        job.researchSessions ??= sessions.length;
        if (
          (job.validationWindow ?? 0) >=
          splitResearchJob(job, sessions, true).windows
        ) {
          pause(
            job,
            "data",
            "다음 검증에 필요한 새 40세션을 모으고 있습니다.",
            "페이지 또는 러너가 실행 중이면 새 거래일 데이터를 자동 확보해 이어갑니다.",
          );
          break;
        }
        job.dataSummary = await researchSummary(job, sessions);
        break;
      }
      case "data_review": {
        const sessions = await readGenerationData(researchDataId(job));
        if (
          (job.validationWindow ?? 0) >=
          splitResearchJob(job, sessions, true).windows
        ) {
          pause(
            job,
            "data",
            "확보한 미사용 검증 구간을 모두 사용했습니다.",
            "실패한 구간을 재사용하지 않습니다. 새 거래일 데이터가 쌓인 뒤 이어서 검증해야 합니다.",
          );
          break;
        }
        job.dataSummary = await researchSummary(job, sessions);
        job.dataNote = await ask(
          job,
          "dataAnalyst",
          noteSchema,
          `Summarize measured training data and limitations for the designer. Do not claim approval or see holdout performance. ${context}\n${JSON.stringify(job.dataSummary)}`,
        );
        break;
      }
      case "design": {
        const output = await ask(
          job,
          "designer",
          candidatesSchema,
          `Design 1–3 distinct simple hypotheses as executable rules. Repair prior blockers using the full shared context and training diagnostics. Do not repeat identical rejected candidates. Do not invent sizing capabilities or require quotes absent from historical OHLCV. No arbitrary code. The parameters will be frozen before validation; only training can select candidates. ${context}\nPlan:${JSON.stringify(job.plan)}\nTraining data:${JSON.stringify(job.dataSummary)}\nData note:${JSON.stringify(job.dataNote)}\nLanguage:${JSON.stringify(z.toJSONSchema(candidateSchema))}\nFeatures ${FEATURES.join(",")}: Choose barInterval from context.barIntervals to match the hypothesis timescale; freeze it with the rule. All features use last lookback+1 completed same-day consecutive bars at that interval (including earlier slots). Lookback counts bars, not minutes. minBarDollarVolume and participation apply to that same resolution; use barResolutions training evidence. returnPct = last close / first close -1 in percent; vwapDistancePct uses typical-price volume weighted mean; rangePosition is 0..1 over sample; relativeVolume is last volume / prior sample mean; breakoutPct is percent above previous lookback highs; rangePct is sample high-low / close percent. All conditions AND. Rank selects one eligible symbol. Price/volume/affordability/gaps are hard guarded. minMinutesAfterOpen means minutes after this SLOT starts, not exchange open. Leave at least two strategy bars before the slot ends. Max one entry per slot/day. Entry at the next strategy bar open; the delay stress is one bar of this same interval. Stop and target relative to actual fill, conservative stop-first if both touched, mandatory slot end exit. Favor sparse falsifiable rules, no data-mined threshold sweeps. ${DETAIL_CHECKLIST}`,
        );
        job.candidates = output.candidates;
        const feasibility = candidateFeasibility(
          job,
          job.candidates,
          await readGenerationData(researchDataId(job)),
        );
        if (feasibility.issues.length)
          revise(job, "design", feasibility.issues);
        break;
      }
      case "risk_review": {
        assertDifferentProvider("designer", "riskReviewer");
        job.riskReview = await ask(
          job,
          "riskReviewer",
          reviewSchema,
          `You independently review GPT-6.1 Sol rules. Reject any material unsupported assumption, unexecutable candidate or leakage. Review ALL candidates against the supplied engine contract. Require exact actionable repairs for blockers. Known disclosed OHLCV limitations belong in cautions unless rules depend on unavailable data. Do not invent a per-trade risk budget, and do not reject solely because a feasible whole-share strategy uses small capital. Review ALL candidates; no rewriting. A backtest is not a guarantee. ${DETAIL_CHECKLIST}\n${context}\n${JSON.stringify({ plan: job.plan, candidates: job.candidates, data: job.dataSummary, language: z.toJSONSchema(candidateSchema) })}`,
        );
        if (!job.riskReview.approved || job.riskReview.blockers.length)
          revise(
            job,
            "risk_review",
            job.riskReview.blockers.length
              ? job.riskReview.blockers
              : [job.riskReview.summary],
          );
        break;
      }
      case "training": {
        const trials: Array<{ spec: ReturnType<typeof parseSpec>; result: ReturnType<typeof runRelay> }> = [];
        for (const [i, candidate] of job.candidates!.entries()) {
          const sessions = await readGenerationData(researchDataId(job), strategyBarMinutes(candidate));
          const split = splitResearchJob(job, sessions);
          const spec = parseSpec({
            version: 1,
            id: `generated-${job.id}-${job.research?.current ?? 0}-${i}`,
            slot: job.slot,
            universe: job.plan!.universe,
            candidate,
            evidence: `생성 ${job.id} · 과거 ${candidate.barInterval ?? "5m"}봉 검증`,
          });
          trials.push({
            spec,
            result: runRelay([compileStrategy(spec)], split.train, {
              capitalUsd: job.capitalUsd,
            }),
          });
        }
        job.trials = trials.map((t) => ({
          name: t.spec.candidate.name,
          metrics: t.result.metrics,
        }));
        const eligible = trials.filter(
          (t) =>
            t.result.metrics.totalTrades >= VALIDATION_POLICY.minTrainTrades &&
            (t.result.metrics.meanDailyPct ?? 0) > 0 &&
            (t.result.metrics.maxDrawdownPct ?? 100) <=
              VALIDATION_POLICY.maxDrawdownPct,
        );
        eligible.sort(
          (a, b) =>
            (b.result.metrics.meanDailyPct ?? 0) -
              (a.result.metrics.meanDailyPct ?? 0) ||
            a.spec.id.localeCompare(b.spec.id),
        );
        if (!eligible.length) {
          revise(job, "training", [
            "학습 구간 비용 차감 후 수익·표본 기준 미달. 저장된 각 후보의 실제 거래 수·비용·수익·낙폭을 보고 새 가설을 설계하세요.",
          ]);
          break;
        }
        job.selected = eligible[0].spec;
        job.training = sliceEvidence(eligible[0].result);
        job.frozenAt = new Date().toISOString();
        job.frozenHash = await strategySpecHash(job.selected);
        break;
      }
      case "validation": {
        if (!job.selected || !job.training || !job.frozenAt)
          throw new Error("동결 규칙 없음");
        if (job.frozenHash !== (await strategySpecHash(job.selected)))
          throw new Error("동결한 규칙이 변경되었습니다.");
        const sessions = await readGenerationData(researchDataId(job), strategyBarMinutes(job.selected.candidate));
        job.evidence = validateFrozen(
          job.selected,
          sessions,
          job.capitalUsd,
          job.training,
          job.frozenAt,
          splitResearchJob(job, sessions),
        );
        // Still ask the independent reviewer to diagnose a failed test; publication remains impossible.
        break;
      }
      case "evidence_review": {
        assertDifferentProvider("designer", "evidenceReviewer");
        job.finalReview = await ask(
          job,
          "evidenceReviewer",
          reviewSchema,
          `You are the independent Anthropic final verifier of GPT's frozen strategy. All metrics were computed by the actual relay engine, not by an LLM. Check sample size, costs, missed fills, drawdowns, train/validation/holdout drift, regime concentration, multiple hypotheses tried, data limits and realistic execution. NEVER approve if deterministic passed=false. Do not change parameters or ask for another try on this holdout. ${DETAIL_CHECKLIST}\n${context}\n${JSON.stringify({ spec: job.selected, trials: job.trials, evidence: job.evidence, data: job.dataSummary, risk: job.riskReview })}`,
        );
        if (
          !job.evidence?.passed ||
          !job.finalReview.approved ||
          job.finalReview.blockers.length
        )
          revise(
            job,
            "evidence_review",
            [
              ...(job.evidence?.reasons ?? []),
              ...job.finalReview.blockers,
              job.finalReview.summary,
            ],
            true,
          );
        break;
      }
      case "report":
        job.report = await ask(
          job,
          "reporter",
          noteSchema,
          `Summarize the supplied APPROVED measured evidence in Korean for the strategy card. This is formatting, not an approval decision. Include the sample dates, capital, costs, limitations and no promise of future profits. ${JSON.stringify({ spec: job.selected, evidence: job.evidence, review: job.finalReview })}`,
        );
        break;
      case "publish":
        if (job.research) finishResearchOption(job);
        else {
          await publishGeneration(job, token);
          job.status = "completed";
        }
        break;
    }
    job.events.push({
      at: new Date().toISOString(),
      stage: stage.id,
      state: job.error ? "error" : "done",
      detail:
        job.error ??
        (job.attempts?.at(-1)?.attempt === (job.attempt ?? 1) - 1 &&
        job.attempts.at(-1)?.stage === stage.id
          ? `후보 개선 ${job.attempt}회차로 자동 진행: ${job.attempts.at(-1)!.reasons.join("; ")}`
          : stage.id === "publish" && job.research ? "후보 검증 결과 저장 · 배정은 사용자가 선택" : `${stage.label} 완료`),
      role: stage.role,
      model: job.calls?.at(-1)?.role === stage.role ? job.calls.at(-1)?.model : undefined,
    });
    if (job.status === "running") job.stageIndex++;
    delete job.recovery;
    await commit();
  } catch (error) {
    // Never run failure transitions on a mutated stage whose commit was ambiguous.
    if (/작업 취소 또는 실행 잠금/.test(String(error))) return await getGenerationJob(id);
    if (committing) throw error;
    const failure = researchFailure(error);
    if (error instanceof ReplayDeadlineError && job.search) {
      job.search.phase = "done";
      job.search.endReason = "최종 검증 계산 시간 상한 · 검증 미완료";
      job.search.computeMs = Math.max(job.search.computeMs, job.search.config.maxComputeMs);
      job.status = "completed";
    } else if (error instanceof ResearchBudgetError) {
      pause(
        job,
        "budget",
        error.message,
        "예산을 추가하면 같은 연구 기록과 현재 단계에서 이어갑니다.",
      );
    } else if (failure.recoverable || job.recovery?.message.includes("실행 중단")) {
      const failures = (job.recovery?.failures ?? 0) + 1;
      job.error = failure.message;
      if (failure.transient && failures < 3) {
        const seconds = failures === 1 ? 10 : 30;
        job.recovery = { failures, retryAt: new Date(Date.now() + seconds * 1000).toISOString(), message: failure.message };
        job.nextAction = `${seconds}초 후 같은 단계 자동 재시도${failures === 2 && stage?.role && GENERATION_MODELS[stage.role].provider === "Anthropic" ? " · Claude Sonnet 5 대체 검증" : ""}. 기존 후보와 검증 기록은 유지됩니다.`;
        onProgress(job.nextAction);
      } else {
        job.recovery = { failures, message: failure.message };
        pause(job, "interrupted", failure.message, "자동 복구를 멈췄습니다. 저장된 단계에서 이어갈 수 있습니다. 인증·결제 오류는 해당 설정을 확인한 뒤 재개하세요.");
      }
    } else if (job.search) {
      job.search.endReason = "데이터/실행 장애 · 성과 평가 미완료";
      pause(job, "interrupted", error instanceof Error ? error.message : "연구 실행 장애", "동결 기간과 시도 기록을 보존했습니다. 문제 복구 후 같은 단계에서 재개하세요.");
    } else if (job.research?.phase === "experiments" && stage?.id === "data") {
      pause(job, "interrupted", error instanceof Error ? error.message : "데이터 확보 실패", "백테스트 미실행 · 데이터 문제를 복구한 뒤 같은 구간에서 재개합니다.");
    } else {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "전략 생성 실패";
    }
    job.events.push({
      at: new Date().toISOString(),
      stage: stage?.id ?? "plan",
      state: "error",
      detail: job.error ?? (error instanceof Error ? error.message : "전략 생성 실패"),
      role: stage?.role ?? null,
    });
    await commit();
  }
  // A cancellation wins over a late result returned by a provider.
  return (await getGenerationJob(id)) ?? job;
}
export { publicJob };
