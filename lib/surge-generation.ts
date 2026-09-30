/**
 * The 급등주 research pipeline: one durable stage per request.
 *
 * Structurally this is the 전략 generator — GPT plans and designs, Claude
 * reviews, and neither of them ever computes a metric — with the differences
 * that make it the feature the owner asked for:
 *
 * - **The hypothesis is the owner's:** names surging or crashing TODAY move
 *   alike for the rest of TODAY. Events are rebuilt minute by minute
 *   (`lib/surge-observation.ts`) and rules are timed from their event.
 * - **Nothing is asked after the button.** The window is `SURGE_WINDOW`, the
 *   splits are `SURGE_POLICY`, and `validation` is a stage rather than a screen,
 *   so design → freeze → validation → holdout → 2× cost → one-bar delay →
 *   independent review runs in one go.
 * - **The deliverable is a frozen rule, not a running agent.** Every paid call
 *   is inside these stages. Once published, the strategy trades from
 *   `lib/surge-engine.ts` and the live Toss ranking feed, and costs nothing per day.
 * - **The rule is judged in R.** `surgeEvidenceProblems` refuses anything whose
 *   expectancy per unit of risk is not positive out of sample, at double cost,
 *   and at the 95% lower bound — which is what "plus EV" has to mean to be
 *   worth anything.
 */

import { z } from "zod";
import { shiftDate, isWeekday } from "./market-clock.ts";
import { lastCompleteDate } from "@/lib/relay-data";
import { generationAvailability, checkGenerationModels, generationCall } from "@/lib/strategy-generation-llm";
import { GENERATION_MODELS, assertDifferentProvider, type GenerationRole } from "./strategy-generation-models.ts";
import { noteSchema, reviewSchema } from "./strategy-generation-spec.ts";
import { paceMassive } from "./massive-pacer.ts";
import { MassiveError } from "./massive.ts";
import { ClaudeApiError } from "./llm-error.ts";
import { loadSurgeBars } from "./surge-bars.ts";
import {
  compileSurgeStrategy,
  parseSurgeSpec,
  surgeCandidateSchema,
  surgeCandidatesSchema,
  surgePlanSchema,
  surgeSpecHash,
  targetPctOf,
  BAR_FEATURES,
  DAY_FEATURES,
  MAX_LOOKBACK_BARS,
  SURGE_DAY_FROM,
  SURGE_EXECUTION,
  SURGE_EXIT_BY,
  SURGE_LAST_ENTRY,
  SURGE_POOLS,
  SURGE_INTERVALS,
  type SurgeCandidateSpec,
  type SurgeInterval,
} from "./surge-spec.ts";
import { SURGE_OBSERVATION } from "./surge-observation.ts";
import { runSurge, type SurgeSession } from "./surge-engine.ts";
import { createSurgeResearchSummary, surgeCandidateFeasibility } from "./surge-research.ts";
import { SURGE_RESEARCH_VERSION } from "./surge-types.ts";
import {
  auditSurgeSessions,
  splitSurgeSessions,
  surgeSlice,
  validateFrozenSurge,
  SURGE_POLICY,
} from "./surge-validation.ts";
import {
  compactMarket,
  observationUniverse,
  expandMarket,
  surgeHistoryFloor,
} from "./surge-universe.ts";
import { fetchGroupedDaily, fetchSplits } from "./surge-market.ts";
import { SURGE_STAGES, SURGE_WINDOW, publicSurgeJob, type SurgeActivity, type SurgeJob, type SurgeStage } from "./surge-types.ts";
import {
  claimSurgeJob,
  createSurgeJob,
  getSurgeJob,
  loadIntradaySurgeSessions,
  sessionShape,
  publishSurge,
  readMarketDay,
  readRankDays,
  saveSurgeJob,
  saveSurgeActivities,
  splitsOn,
  surgeProgress,
  SURGE_LEASE_MS,
  writeMarketDay,
  writeRankDay,
  writeSplits,
} from "@/lib/surge-store";

export const createSurgeSchema = z.object({
  pool: z.enum(SURGE_POOLS),
  brief: z.string().max(1500).default(""),
  requestId: z.string().uuid(),
}).strict();

const DETAIL_CHECKLIST = `Check ALL material execution assumptions: sufficient available USD cash, whole-share affordability, commissions and modelled spread, gaps through the stop, volume participation, halted or delisted names with no bars, split-adjusted data, no future bars, market holidays/DST/early close, partial fills and rejections, one position at a time, forced exit by ${SURGE_EXIT_BY} ET, cash settlement, daily loss circuit breaker, no short/leverage/borrow. An event name is often a low-priced, thin, headline-driven stock: its spread is modelled from price and dollar volume, never quoted. Unsupported circumstances must skip entry, not be guessed. OHLCV cannot prove queue priority or quote spread. Review must acknowledge these limits.`;

/**
 * What every feature measures, and from which bars. The designer needs it to
 * write rules; the reviewers need the same text to judge look-ahead — without
 * it they can only flag "unconfirmed" and block a sound rule.
 */
const FEATURE_DEFINITIONS = `EVENTS are SAME-DAY: an event is the first completed regular-session (${SURGE_OBSERVATION.from}-${SURGE_OBSERVATION.to} ET) 1-minute bar whose close is >= +${SURGE_OBSERVATION.changePct}% (gainers) or <= -${SURGE_OBSERVATION.changePct}% (losers) from the previous regular close, priced $${SURGE_OBSERVATION.minPrice}-$${SURGE_OBSERVATION.maxPrice}, with >= $${SURGE_OBSERVATION.minSessionDollarVolume / 1e6}M regular-session dollar volume through that minute. observedAt is that minute's close; nothing about the event exists before it, and it stays an event after any pullback. The previous close is only the reference a move is measured from — no rule selects on yesterday. Day features (${DAY_FEATURES.join(", ")}), all computed at the decision bar's close from the regular session's completed bars so far: eventChangePct = move vs previous close at observation (signed); fromPrevClosePct = latest close vs previous close; fromEventPricePct = latest close vs the observation price; minutesSinceEvent = decision time minus observedAt; sessionHighDistancePct = latest close vs the session high so far (<=0); sessionVwapDistancePct = latest close vs the session VWAP (typical price); sessionRangePct = session high-low so far over previous close; openGapPct = 09:30 open vs previous close; sessionDollarVolumeM = session dollar volume so far in $M. Bar features ${BAR_FEATURES.join(",")} read the last lookback+1 consecutive completed bars at the rule's barInterval (lookback <= ${MAX_LOOKBACK_BARS}): returnPct = last close / first close - 1 in percent; vwapDistancePct = vs typical-price VWAP of the sample; rangePosition 0..1 within the sample; relativeVolume = last volume / prior sample mean; breakoutPct = percent above the prior sample's highs; rangePct = sample high-low / close in percent.`;

const POOL_LABEL = { gainers: "same-day surge (+10% events)", losers: "same-day crash (-10% events)" } as const;

function weekdaysBetween(from: string, to: string) {
  const dates: string[] = [];
  for (let cursor = from; cursor <= to; cursor = shiftDate(cursor, 1)) {
    if (isWeekday(cursor)) dates.push(cursor);
  }
  return dates;
}

export async function createSurgeGeneration(ownerId: string, input: unknown) {
  const request = createSurgeSchema.parse(input);
  const existing = await getSurgeJob(request.requestId);
  if (existing) {
    if (existing.ownerId !== ownerId) throw new Error("요청 식별자 충돌");
    return existing;
  }
  const available = generationAvailability();
  if (!available.ready) {
    throw new Error(`서버 키 필요: ${available.missing.join(", ")} (타사 검증 생략 불가)`);
  }
  const to = lastCompleteDate();
  const from = shiftDate(to, -SURGE_WINDOW.tradingDays);
  const floor = surgeHistoryFloor();
  if (from < floor) throw new Error(`Massive 전체 시장 일봉은 ${floor} 이후만 제공합니다.`);

  const now = new Date().toISOString();
  const job: SurgeJob = {
    researchVersion: SURGE_RESEARCH_VERSION,
    id: request.requestId,
    ownerId,
    pool: request.pool,
    status: "running",
    stageIndex: 0,
    createdAt: now,
    updatedAt: now,
    from,
    to,
    capitalUsd: SURGE_WINDOW.capitalUsd,
    brief: request.brief,
    costUsd: 0,
    error: null,
    events: [],
    attempt: 1,
    attempts: [],
    // A few sessions before the window so its first day has a previous close to be measured against.
    marketTasks: weekdaysBetween(shiftDate(from, -6), to),
    marketCursor: 0,
    barTasks: [],
    barCursor: 0,
    barFailures: [],
  };
  await createSurgeJob(job);
  return job;
}

/**
 * Model calls run with `maxRetries: 0`, so one 429 from a provider used to end
 * a run that had already paid for hours of data and several attempts. A rate
 * limit, overload or dropped connection is not a verdict on the research: the
 * stage waits and runs again, a few times, before the run is failed.
 */
const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_TRANSIENT_RETRIES = 3;
export const transientRetryDelayMs = (retry: number) => 60_000 * 2 ** (retry - 1);
export const isTransientModelError = (error: unknown) =>
  error instanceof ClaudeApiError && TRANSIENT_STATUS.has(error.status);

async function askModel<T extends z.ZodType>(job: SurgeJob, report: (message: string) => Promise<void>, role: GenerationRole, schema: T, prompt: string) {
  const model = GENERATION_MODELS[role];
  await report(`${model.provider} · ${model.model} 요청 전송 · 응답 대기`);
  const result = await generationCall(job.ownerId, role, schema, prompt);
  await report(`${model.model} 응답 수신 · 구조 검증 완료 · 비용 $${result.costUsd.toFixed(4)}`);
  job.costUsd += result.costUsd;
  return result.data;
}

function pause(job: SurgeJob, reason: NonNullable<SurgeJob["pauseReason"]>, message: string, action: string) {
  job.status = "paused";
  job.pauseReason = reason;
  job.error = message;
  job.nextAction = action;
}

/** Roll back to the design stage with the measured reasons the last attempt failed. */
function revise(job: SurgeJob, stage: SurgeJob["events"][number]["stage"], reasons: string[]) {
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
  // The caller increments once after committing this stage's event.
  job.stageIndex = SURGE_STAGES.findIndex((stage_) => stage_.id === "plan") - 1;
}

/**
 * Repeated attempts of the same failing idea spend tokens without new
 * information. The holdout is also not infinite: each rejection has already
 * looked at it once.
 */
const MAX_ATTEMPTS = 6;

async function sessionDatesFor(job: SurgeJob) {
  const dates: string[] = [];
  for (const date of job.marketTasks ?? []) {
    if (date < job.from || date > job.to) continue;
    const rows = await readMarketDay(date);
    if (rows?.length) dates.push(date);
  }
  return dates;
}

/** One minute-bar download per symbol and month it could have an event in. */
function barTasksFor(dates: string[], envelopes: Map<string, Array<{ symbol: string }>>) {
  const needed = new Map<string, { symbol: string; from: string; to: string }>();
  for (const date of dates) {
    for (const candidate of envelopes.get(date) ?? []) {
      const key = `${candidate.symbol}|${date.slice(0, 7)}`;
      const task = needed.get(key);
      if (!task) {
        needed.set(key, { symbol: candidate.symbol, from: date, to: date });
      } else {
        if (date < task.from) task.from = date;
        if (date > task.to) task.to = date;
      }
    }
  }
  return [...needed.values()].sort((left, right) => left.from.localeCompare(right.from) || left.symbol.localeCompare(right.symbol));
}

const CHUNK_DETAIL = /^(일별 시세|1분봉|분봉 처리) \d+\//;

/**
 * A download stage is hundreds of one-call chunks, each logging `started` and
 * `done`. Every chunk rewrites the job row and every status poll ships it, so
 * only the latest chunk is kept; the split count and interruptions stay.
 */
function keepLatestChunk(job: SurgeJob) {
  const last = job.events.at(-1);
  job.events = job.events.filter((event, index) =>
    index === job.events.length - 1 ||
    event.stage !== last?.stage ||
    !(event.state === "started" || (event.state === "done" && CHUNK_DETAIL.test(event.detail))));
}

/**
 * What to do with a stage whose last event is `started` — the request running it
 * died (dev server restart, closed connection, Worker eviction).
 *
 * Data and deterministic stages resume: downloads land in the account-wide
 * cache, training and validation replay a frozen spec whose hash is checked, and
 * publishing is lease-guarded. A paid model stage is retried once — the lost
 * call was already billed, and a stage that keeps dying would keep billing.
 */
export function interruptedStagePolicy(stage: SurgeStage, job: Pick<SurgeJob, "interruptions">) {
  const role = SURGE_STAGES.find((row) => row.id === stage)?.role;
  if (!role) return "resume" as const;
  return (job.interruptions?.[stage] ?? 0) < 1 ? "retry" as const : "fail" as const;
}

/** One durable stage or chunk per request. Reloads and the runner resume from D1. */
export async function advanceSurgeGeneration(
  id: string,
  onProgress: (message: string, activity?: SurgeActivity) => void = () => undefined,
) {
  let job = await getSurgeJob(id);
  if (!job || job.status !== "running") return job;
  if (job.retryAt && Date.parse(job.retryAt) > Date.now()) {
    onProgress(`모델 호출 한도 대기 — ${new Date(job.retryAt).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}에 재시도`);
    return job;
  }
  const token = crypto.randomUUID();
  const downloading = ["market", "bars"].includes(SURGE_STAGES[job.stageIndex]?.id ?? "");
  const leaseMs = downloading ? SURGE_LEASE_MS.download : SURGE_LEASE_MS.model;
  if (!(await claimSurgeJob(id, token, leaseMs))) return job;
  job = (await getSurgeJob(id))!;
  if (job.status !== "running") return job;

  if (job.researchVersion !== SURGE_RESEARCH_VERSION) {
    pause(job, "interrupted", "이전 방식(전일 랭킹 또는 고정 슬롯)의 연구입니다. 당일 급등락 가설로 새 연구를 시작하세요.", "기존 기록은 보존됩니다. 새 급등주 전략 생성을 누르세요.");
    await saveSurgeJob(job, token);
    return job;
  }

  const stage = SURGE_STAGES[job.stageIndex];
  let pending: Promise<void> = Promise.resolve();
  const report = (detail: string, kind: SurgeActivity["kind"] = "update") => {
    const activity: SurgeActivity = {
      id: crypto.randomUUID(), at: new Date().toISOString(), stage: stage?.id ?? "market",
      attempt: attemptAtStart, detail, kind,
    };
    job!.activities = [...(job!.activities ?? []), activity].slice(-160);
    const snapshot = job!.activities;
    onProgress(detail, activity);
    pending = pending.then(() => saveSurgeActivities(id, token, snapshot))
      .catch((error) => { console.error("Surge activity persistence failed", error); });
    return pending;
  };
  const persist = async (current: SurgeJob, lease: string) => {
    const event = current.events.at(-1);
    if (event) await report(event.detail, event.state === "error" ? "error" : "done");
    await pending;
    return saveSurgeJob(current, lease);
  };
  const ask = <T extends z.ZodType>(current: SurgeJob, role: GenerationRole, schema: T, prompt: string) =>
    askModel(current, report, role, schema, prompt);

  // Whether *this* stage sent the run back to design — not whether an earlier attempt failed here.
  const attemptAtStart = job.attempt ?? 1;
  try {
    if (!stage) throw new Error("알 수 없는 생성 단계");
    if (job.events.at(-1)?.state === "started") {
      const policy = interruptedStagePolicy(stage.id, job);
      if (policy === "fail") {
        throw new Error("같은 모델 단계가 두 번 중단되었습니다. 중복 과금을 막기 위해 종료합니다. 새 생성으로 재시도하세요.");
      }
      job.interruptions = { ...job.interruptions, [stage.id]: (job.interruptions?.[stage.id] ?? 0) + 1 };
      job.events.push({
        at: new Date().toISOString(), stage: stage.id, state: "error",
        detail: policy === "retry"
          ? `${stage.label} 중단 — 서버 재시작/연결 끊김, 모델 호출 1회 재시도`
          : `${stage.label} 중단 — 서버 재시작/연결 끊김, 저장된 지점에서 재개`,
        role: stage.role,
      });
    }
    job.events.push({
      at: new Date().toISOString(), stage: stage.id, state: "started", detail: stage.label, role: stage.role,
    });
    await surgeProgress(job, token, leaseMs);
    await report(stage.label);

    // ------------------------------------------------------------- data stages

    if (stage.id === "market") {
      const tasks = job.marketTasks ?? [];
      // Corporate actions first: the ranking reads raw prices, so it has to know
      // which of the day's biggest moves were splits before it calls one a surge.
      if (!job.splitsLoaded) {
        await report(`Massive 분할·병합 이력 조회 — /v3/reference/splits, ${tasks[0]}~${job.to}`);
        await paceMassive("분할·병합 이력", (message) => { void report(message); });
        const events = await fetchSplits(tasks[0], job.to, (message) => { void report(message); });
        job.splitEvents = await writeSplits(events);
        job.splitsLoaded = true;
        job.events.push({
          at: new Date().toISOString(), stage: stage.id, state: "done",
          detail: `분할·병합 ${job.splitEvents}건 확보 — 해당일 랭킹에서 제외`, role: null,
        });
        await persist(job, token);
        return job;
      }

      let cursor = job.marketCursor ?? 0;
      // Skip sessions already in the account-wide cache without spending a call.
      await report("저장된 일별 시세 캐시 확인");
      const beforeCache = cursor;
      const rebuildEnvelope = async (date: string, rows: ReturnType<typeof expandMarket>) => {
        if (!rows.length) return;
        for (let back = 1; back <= 6; back++) {
          const previous = await readMarketDay(shiftDate(date, -back));
          if (previous?.length) {
            await writeRankDay(date, observationUniverse(date, rows, previous, await splitsOn(date)));
            return;
          }
        }
      };
      while (cursor < tasks.length) {
        const cached = await readMarketDay(tasks[cursor]);
        if (cached === null) break;
        await rebuildEnvelope(tasks[cursor], expandMarket(cached));
        cursor++;
      }
      if (cursor > beforeCache) await report(`일별 시세 ${cursor - beforeCache}일 캐시 사용 · 추가 호출 생략`, "done");
      if (cursor < tasks.length) {
        const date = tasks[cursor];
        await paceMassive(`${date} 전 종목 일별 시세`, (message) => { void report(message); });
        await report(`Massive 요청 1건 — ${date} 미국 전 종목 일별 시세 (${cursor + 1}/${tasks.length}일)`);
        const rows = await fetchGroupedDaily(date, true);
        await writeMarketDay(date, compactMarket(rows));
        await rebuildEnvelope(date, rows);
        job.marketCursor = cursor + 1;
        job.events.push({
          at: new Date().toISOString(), stage: stage.id, state: "done",
          detail: `일별 시세 ${job.marketCursor}/${tasks.length}일 · ${date} ${rows.length ? `거래 가능 ${rows.length.toLocaleString()}종목` : "휴장"}`,
          role: null,
        });
        keepLatestChunk(job);
        await persist(job, token);
        return job;
      }
      job.marketCursor = tasks.length;

      const dates = await sessionDatesFor(job);
      if (dates.length < SURGE_POLICY.minSessions) {
        throw new Error(`거래 세션 ${dates.length}개로는 검증할 수 없습니다 (최소 ${SURGE_POLICY.minSessions}개).`);
      }
      job.sessionDates = dates;
      job.marketSessions = dates.length;
      const envelopeRows = await readRankDays(job.pool, dates[0], dates.at(-1)!);
      job.barTasks = barTasksFor(dates, new Map(envelopeRows.map((row) => [row.rankedOn, row.candidates])));
      job.barCursor = 0;
      await report(`당일 사건 후보 ${envelopeRows.reduce((sum, row) => sum + row.candidates.length, 0).toLocaleString()}종목·일 · 1분봉 요청 ${job.barTasks.length.toLocaleString()}건 예정`, "done");
    }

    if (stage.id === "bars") {
      const tasks = job.barTasks ?? [];
      let cursor = job.barCursor ?? 0;
      if (cursor < tasks.length) {
        // Symbol-months already in the account-wide cache cost no call, so they are
        // walked in one request, like cached market days; the first real download ends it.
        const started = Date.now();
        let task = tasks[cursor];
        for (;;) {
          task = tasks[cursor];
          await report(`캐시 확인 및 분봉 확보 — ${task.symbol} ${task.from.slice(0, 7)} 1분봉 (${cursor + 1}/${tasks.length}종목·월)`);
          let cached = false;
          try {
            const loaded = await loadSurgeBars(task.symbol, task.from, task.to, (message) => { void report(message); });
            cached = loaded.cached;
            await report(`${task.symbol} ${task.from.slice(0, 7)} · ${loaded.cached ? "저장된 분봉 범위 확인 완료 · 추가 호출 생략" : `수신·저장 완료 · ${loaded.minuteBars.toLocaleString()}개 1분봉`}`, "done");
            job.barsDownloaded = (job.barsDownloaded ?? 0) + loaded.minuteBars;
          } catch (error) {
            // One unavailable ticker is a day with no signal, not a dead run.
            const reason = error instanceof MassiveError || error instanceof Error ? error.message : String(error);
            await report(`${task.symbol} 분봉 확보 실패 · ${reason}`, "error");
            job.barFailures = [...(job.barFailures ?? []), `${task.symbol} ${task.from.slice(0, 7)}: ${reason}`].slice(-60);
            if ((job.barFailures.length / Math.max(1, tasks.length)) > 0.2) {
              throw new Error(`분봉 확보 실패가 전체의 20%를 넘었습니다. 마지막 사유: ${reason}`);
            }
          }
          cursor += 1;
          if (!cached || cursor >= tasks.length || Date.now() - started > 20_000) break;
        }
        job.barCursor = cursor;
        job.events.push({
          at: new Date().toISOString(), stage: stage.id, state: "done",
          detail: `분봉 처리 ${job.barCursor}/${tasks.length} · 누적 확보 실패 ${job.barFailures?.length ?? 0}건`,
          role: null,
        });
        keepLatestChunk(job);
        await persist(job, token);
        return job;
      }
    }

    // ------------------------------------------------------------ shared context

    /**
     * Sessions are loaded one block at a time — the designer's survey reads the
     * training block only, and never the days it will be tested on — and each
     * event keeps only the bars its rule can reach (`loadIntradaySurgeSessions`).
     * The survey reads every event at one minute, one day at a time; every measured run
     * afterwards loads its own rule's events at its own resolution.
     */
    const blocks = () => splitSurgeSessions(job!.sessionDates ?? []);
    const sessionsFor = async (dates: string[], shape: { interval: SurgeInterval; rule: SurgeCandidateSpec | null }) => {
      await report(`${dates.length}개 세션 로드 · ${shape.interval}${shape.rule ? ` · ${shape.rule.name}` : " · 전체 사건"}`);
      const sessions = await loadIntradaySurgeSessions(job!.pool, dates, shape.interval, shape.rule);
      await report(`${sessions.length}개 세션 로드 완료 · 사건 ${sessions.reduce((sum, session) => sum + session.candidates.length, 0).toLocaleString()}건`);
      return sessions;
    };
    let measuredSummary: ReturnType<ReturnType<typeof createSurgeResearchSummary>["result"]> | undefined;
    const surveyEvents: SurgeSession[] = [];

    if (["plan", "data_review", "design"].includes(stage.id)) {
      const summary = createSurgeResearchSummary(job.capitalUsd, 1);
      const dates = blocks().train;
      await report("학습 구간 1분봉 · 당일 관측 이후 경로와 유사한 첫 15분 패턴 비교");
      for (const [index, date] of dates.entries()) {
        const [session] = await loadIntradaySurgeSessions(job.pool, [date], "1m");
        summary.add(session);
        // Keep only events for feasibility; minute OHLCV is released after each day.
        surveyEvents.push({ date, candidates: session.candidates, bars: {} });
        if ((index + 1) % 10 === 0 || index + 1 === dates.length) await report(`1분봉 세션 로드 완료 ${index + 1}/${dates.length} · 당일 경로 통계 계산`);
      }
      measuredSummary = summary.result();
      job.dataSummary = measuredSummary;
    }

    const context = JSON.stringify({
      side: POOL_LABEL[job.pool],
      eventDefinition: {
        changePct: SURGE_OBSERVATION.changePct,
        priceUsd: [SURGE_OBSERVATION.minPrice, SURGE_OBSERVATION.maxPrice],
        minSessionDollarVolumeUsd: SURGE_OBSERVATION.minSessionDollarVolume,
        session: `${SURGE_OBSERVATION.from}-${SURGE_OBSERVATION.to} ET`,
      },
      brief: job.brief,
      capitalUsd: job.capitalUsd,
      period: { from: job.from, to: job.to, sessions: job.marketSessions },
      trainingData: job.dataSummary,
      selectionContract:
        `The owner's hypothesis: stocks that are surging or crashing TODAY behave alike for the rest of TODAY. Events are rebuilt from completed 1-minute bars (see the feature definitions). At any decision only events already observed are visible; a rule picks among them with rankBy. There is no previous-day selection and no next-day holding. The training summary is aligned on the exact first observation minute, price=100. afterObservation reports same-day forward paths. afterSimilarFirst15m groups events using ONLY their first 15-minute return, then measures subsequent same-day paths from the +15m price. Compare group sample counts and dispersion before claiming similar behavior. Any rule using a first-15m shape must wait at least 15 minutes after observation and encode the setup with available features; future outcomes must never label a setup. Similarity is a hypothesis to falsify, not a promised continuation or reversal. The previous close is only a return baseline, never yesterday's winner/loser selection. No outcome crosses the session boundary. Crash-side rules are long-only bounce hypotheses because the broker offers no US short selling.`,
      executionContract:
        `Timing is EVENT-RELATIVE: a decision is made on a completed bar at the rule's barInterval (${SURGE_INTERVALS.join(", ")}) whose close falls in [entryFrom, entryTo] ET (entryFrom no earlier than the first bar's close after ${SURGE_DAY_FROM}, entryTo no later than ${SURGE_LAST_ENTRY}) and is between minMinutesSinceEvent and maxMinutesSinceEvent after the event's observedAt. The fill is the next bar's open. A position exits at the stop, the target (stopPct*rewardRisk), after maxHoldMinutes, or at ${SURGE_EXIT_BY} ET, whichever is first. Up to maxTradesPerDay sequential trades a day, one position at a time, never the same name twice; the search resumes after each exit. Whole shares with 99% of the balance, capped at 1% of the signal bar's volume; the stop is taken first when a bar covers both. Minutes are downloaded once and rolled up, so a finer interval costs nothing extra. Prices are RAW, not split-adjusted, and names whose split executed that day are excluded. Spread is modelled from price and dollar volume, never quoted. No per-trade risk budget, no scaling in or out. These are known limitations requiring cautions, not fabricated facts.`,
      attempt: job.attempt,
      attemptsRemaining: MAX_ATTEMPTS - (job.attempt ?? 1),
      previousAttempts: (job.attempts ?? []).slice(-4).map((attempt) => ({
        attempt: attempt.attempt,
        stage: attempt.stage,
        reasons: attempt.reasons,
        candidates: attempt.candidates,
        trials: attempt.trials,
        riskReview: attempt.riskReview,
        measuredFailure: attempt.evidence ? {
          reasons: attempt.evidence.reasons,
          validation: attempt.evidence.validation.expectancy,

        } : undefined,
      })),
      policy: SURGE_POLICY,
      execution: SURGE_EXECUTION,
    });

    switch (stage.id) {
      case "plan": {
        await report("필수 모델 접근 확인 (읽기 전용)");
        await checkGenerationModels();
        job.plan = await ask(job, "orchestrator", surgePlanSchema,
          `Act as GPT-6 Astra orchestrator for 급등주 research. Plan falsifiable, cash-only, long-only intraday research on ${POOL_LABEL[job.pool]}: what these names do LATER THE SAME DAY after the event is first observed. The side is fixed by the user; do not propose a different one. On revisions, reconcile the previous measured blockers with a genuinely new preregistered hypothesis — restating a rejected idea wastes the remaining holdout. Before planning, reason about whether the modelled round trip leaves room for the stop distances you intend: the hurdle table is in the training summary. No promise of returns. Context: ${context}\n${DETAIL_CHECKLIST}`);
        if (job.plan.pool !== job.pool) {
          revise(job, "plan", ["계획 모델이 지정된 풀을 변경했습니다. 사용자가 선택한 풀을 그대로 사용하세요."]);
        }
        break;
      }

      case "data_review":
        job.dataNote = await ask(job, "dataAnalyst", noteSchema,
          `Summarize the measured training sample of ${POOL_LABEL[job.pool]} for the designer: how the SAME session behaves AFTER an event was first observed (forward returns, excursions, first touch; by time of day, move size and similar first-15m paths). Identify where similar observable setups do and do not lead to repeatable later-today behavior. Report dispersion, missing observations, event counts and distinct sessions; never infer similarity from only an overall average, where the cost hurdle sits, and what the data cannot show. Do not claim approval and do not describe validation or holdout data — you have not seen it. ${context}\n${JSON.stringify(job.dataSummary)}`);
        break;

      case "design": {
        const output = await ask(job, "designer", surgeCandidatesSchema,
          `Design 1–3 distinct, simple, executable hypotheses about what ${POOL_LABEL[job.pool]} names do LATER THE SAME DAY after their event was observed, timed from the event. Repair prior blockers using the measured failures in the context. Do not repeat a rejected candidate. Choose stopPct and rewardRisk deliberately: rewardRisk IS the 손익비 this feature exists to establish, and the break-even win rate it implies after the modelled cost is in the training summary's roundTripInR table. Prefer few, falsifiable conditions over threshold sweeps. ${context}\nPlan:${JSON.stringify(job.plan)}\nTraining data:${JSON.stringify(job.dataSummary)}\nData note:${JSON.stringify(job.dataNote)}\nLanguage:${JSON.stringify(z.toJSONSchema(surgeCandidateSchema))}\n${FEATURE_DEFINITIONS} All conditions AND. rankBy picks one symbol from those that pass. ${DETAIL_CHECKLIST}`);
        job.candidates = output.candidates;
        if (job.candidates.some((candidate) => candidate.pool !== job.pool)) {
          revise(job, "design", ["후보가 지정된 풀과 다릅니다. 사용자가 선택한 풀만 사용하세요."]);
          break;
        }
        const feasibility = surgeCandidateFeasibility(job.id, job.candidates, surveyEvents, job.capitalUsd, measuredSummary!);
        if (feasibility.issues.length) revise(job, "design", feasibility.issues);
        break;
      }

      case "risk_review":
        assertDifferentProvider("designer", "riskReviewer");
        job.riskReview = await ask(job, "riskReviewer", reviewSchema,
          `You independently review GPT-6 Astra's 급등주 rules, which trade names AFTER a same-day surge/crash event, timed from the event. These are often low-priced, thin, headline-driven names whose spread is modelled rather than quoted, so weigh cost realism and gap risk first. Reject any material unsupported assumption, unexecutable candidate, or look-ahead (in particular any use of the day's final high, low, close, volume or rank). Check specifically that the reward:risk and stop distance leave a break-even win rate a real strategy could clear after the modelled round trip. Do not invent a per-trade risk budget and do not reject solely because the capital is small. Require exact actionable repairs for blockers. Review ALL candidates; no rewriting. A backtest is not a guarantee. Feature definitions: ${FEATURE_DEFINITIONS} ${DETAIL_CHECKLIST}\n${context}\n${JSON.stringify({ plan: job.plan, candidates: job.candidates, data: job.dataSummary, language: z.toJSONSchema(surgeCandidateSchema) })}`);
        if (!job.riskReview.approved || job.riskReview.blockers.length) {
          revise(job, "risk_review", job.riskReview.blockers.length ? job.riskReview.blockers : [job.riskReview.summary]);
        }
        break;

      case "training": {
        const trials: Array<{ spec: ReturnType<typeof parseSurgeSpec>; result: ReturnType<typeof runSurge> }> = [];
        for (const [index, candidate] of job.candidates!.entries()) {
          const spec = parseSurgeSpec({
            version: 2,
            id: `surge-${job.id}-${index}`,
            candidate,
            evidence: `생성 ${job.id} · ${job.from}–${job.to} · 당일 ${job.pool === "gainers" ? "급상승" : "급하락"} 사건 · ${candidate.barInterval}봉 (원주가)`,
          });
          const train = await sessionsFor(blocks().train, sessionShape(candidate));
          const issues = auditSurgeSessions(train);
          if (issues.length) throw new Error(`데이터 품질 부족: ${issues.join("; ")}`);
          await report(`후보 ${index + 1}/${job.candidates!.length} · ${candidate.name} · ${train.length}개 학습 세션 백테스트`);
          trials.push({ spec, result: runSurge(compileSurgeStrategy(spec), train, { capitalUsd: job.capitalUsd }) });
        }
        await report(`${trials.length}개 후보 계산 완료 · 거래 수·기대값·낙폭 기준 비교`);
        job.trials = trials.map((trial) => ({
          name: trial.spec.candidate.name,
          metrics: trial.result.metrics,
          expectancy: trial.result.expectancy,
        }));
        const eligible = trials.filter((trial) =>
          trial.result.metrics.totalTrades >= SURGE_POLICY.minTrainTrades &&
          (trial.result.expectancy.expectancyR ?? 0) >= SURGE_POLICY.minExpectancyR &&
          (trial.result.metrics.meanDailyPct ?? 0) > 0 &&
          (trial.result.metrics.maxDrawdownPct ?? 100) <= SURGE_POLICY.maxDrawdownPct);
        eligible.sort((left, right) =>
          (right.result.expectancy.expectancyR ?? 0) - (left.result.expectancy.expectancyR ?? 0) ||
          left.spec.id.localeCompare(right.spec.id));
        if (!eligible.length) {
          revise(job, "training", [
            `학습 구간에서 비용 차감 후 ${SURGE_POLICY.minExpectancyR}R·표본 ${SURGE_POLICY.minTrainTrades}건 기준을 넘은 후보가 없습니다. 저장된 각 후보의 실제 거래 수·기대값·승률·평균 손익 R을 보고 진입 타이밍·손절폭·손익비부터 다시 설계하세요.`,
          ]);
          break;
        }
        job.selected = eligible[0].spec;
        job.training = surgeSlice(eligible[0].result);
        job.frozenAt = new Date().toISOString();
        job.frozenHash = await surgeSpecHash(job.selected);
        break;
      }

      case "validation": {
        if (!job.selected || !job.training || !job.frozenAt) throw new Error("동결 규칙 없음");
        if (job.frozenHash !== (await surgeSpecHash(job.selected))) throw new Error("동결한 규칙이 변경되었습니다.");
        await report("미사용 구간 · 비용 2배 · 진입 1봉 지연 실행");
        const shape = sessionShape(job.selected.candidate);
        job.evidence = validateFrozenSurge(job.selected, {
          validation: await sessionsFor(blocks().validation, shape),
          holdout: await sessionsFor(blocks().holdout, shape),
        }, job.capitalUsd, job.training, job.frozenAt, (message) => { void report(message); });
        break;
      }

      case "evidence_review":
        assertDifferentProvider("designer", "evidenceReviewer");
        job.finalReview = await ask(job, "evidenceReviewer", reviewSchema,
          `You are the independent Claude Opus 5 final verifier of GPT's frozen 급등주 rule, which trades names after a same-day surge/crash event, timed from the event. Every metric here was computed by the deterministic engine, never by a model. Judge the edge in R first: expectancy per unit of risk on the holdout, at double cost, and with a one-strategy-bar entry delay, plus the 95% lower bound. Then sample size, missed fills, drawdown, train→holdout drift, regime concentration, how many hypotheses were tried, survivorship among events, and whether the modelled spread is plausible for these names. NEVER approve if deterministic passed=false. Do not change parameters and do not ask for another run on this holdout. Feature definitions: ${FEATURE_DEFINITIONS} ${DETAIL_CHECKLIST}\n${context}\n${JSON.stringify({ spec: job.selected, trials: job.trials, evidence: job.evidence, data: job.dataSummary, risk: job.riskReview })}`);
        if (!job.evidence?.passed || !job.finalReview.approved || job.finalReview.blockers.length) {
          job.status = "rejected";
          job.error = ["최종 미사용 평가에서 탈락했습니다. 이 구간 결과를 설계에 재사용하지 않습니다.",
            ...(job.evidence?.reasons ?? []), ...job.finalReview.blockers, job.finalReview.summary].join("; ");
        }
        break;

      case "report":
        job.report = await ask(job, "reporter", noteSchema,
          `Summarize the supplied APPROVED measured evidence in Korean for the 급등주 strategy card. This is formatting, not an approval decision. State the sample dates, trade count, expectancy in R, realised payoff ratio versus the intended 손익비, worst day, drawdown, modelled-cost caveat, and that past evidence promises nothing. ${JSON.stringify({ spec: job.selected, evidence: job.evidence, review: job.finalReview })}`);
        break;

      case "publish":
        await report("검증된 규칙과 근거를 전략 저장소에 등록");
        await publishSurge(job, token);
        job.status = "completed";
        break;
    }

    delete job.retryAt;
    if ((job.attempt ?? 1) > MAX_ATTEMPTS) {
      job.status = "rejected";
      job.error = `자동 개선 ${MAX_ATTEMPTS}회 안에 기준을 넘는 패턴을 찾지 못했습니다. 남은 미사용 구간을 아끼기 위해 중단합니다.`;
    }

    job.events.push({
      at: new Date().toISOString(),
      stage: stage.id,
      state: job.error ? "error" : "done",
      detail: job.error ??
        ((job.attempt ?? 1) > attemptAtStart
          ? `후보 개선 ${job.attempt}회차로 자동 진행: ${job.attempts!.at(-1)!.reasons.join("; ")}`
          : `${stage.label} 완료`),
      role: stage.role,
    });
    if (job.status === "running") job.stageIndex += 1;
    await persist(job, token);
  } catch (error) {
    const retries = stage ? (job.transientRetries?.[stage.id] ?? 0) + 1 : Infinity;
    if (stage && isTransientModelError(error) && retries <= MAX_TRANSIENT_RETRIES) {
      const delay = transientRetryDelayMs(retries);
      job.transientRetries = { ...job.transientRetries, [stage.id]: retries };
      job.retryAt = new Date(Date.now() + delay).toISOString();
      job.events.push({
        at: new Date().toISOString(), stage: stage.id, state: "error",
        detail: `${(error as Error).message} — ${Math.round(delay / 1000)}초 후 같은 단계 재시도 (${retries}/${MAX_TRANSIENT_RETRIES})`,
        role: stage.role,
      });
      await persist(job, token);
      return (await getSurgeJob(id)) ?? job;
    }
    if (error instanceof ClaudeApiError && error.status === 402) {
      // An empty provider balance is the account's state, not the research's: hold the run where it is.
      pause(job, "provider", error.message, "크레딧을 충전한 뒤 '이어서 진행'을 누르면 같은 연구 기록과 현재 단계에서 이어갑니다.");
    } else {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "급등주 전략 생성 실패";
    }
    job.events.push({
      at: new Date().toISOString(),
      stage: stage?.id ?? "market",
      state: "error",
      detail: job.error ?? "급등주 전략 생성 실패",
      role: stage?.role ?? null,
    });
    await persist(job, token);
  }
  return (await getSurgeJob(id)) ?? job;
}

/** What the board shows about a published rule. */
export function surgeStrategySummary(spec: unknown) {
  const strategy = compileSurgeStrategy(spec);
  return {
    id: strategy.id,
    name: strategy.name,
    summary: strategy.summary,
    pool: strategy.pool,
    interval: strategy.interval,
    entryFrom: strategy.entryFrom,
    entryTo: strategy.entryTo,
    minMinutesSinceEvent: strategy.minMinutesSinceEvent,
    maxMinutesSinceEvent: strategy.maxMinutesSinceEvent,
    maxHoldMinutes: strategy.maxHoldMinutes,
    maxTradesPerDay: strategy.maxTradesPerDay,
    exitBy: strategy.exitBy,
    stopPct: strategy.stopPct,
    rewardRisk: strategy.rewardRisk,
    targetPct: strategy.targetPct,
    rules: strategy.rules,
    cautions: strategy.cautions,
  };
}

export { publicSurgeJob, targetPctOf };
