import { env } from "cloudflare:workers";
import { loadRelaySessions } from "@/lib/relay-data";
import { z } from "zod";
import { ensureSchema } from "@/db/ensure";
import {
  createGenerationJob,
  generationInventory,
  registeredRelayStrategies,
  readGenerationData,
  writeGenerationData,
  generationProgress,
} from "@/lib/strategy-generation-store";
import {
  SLOT_IDS,
  EXECUTION_LIMITS,
  universeSchema,
  compileStrategy,
  type StrategySpec,
} from "./strategy-generation-spec.ts";
import { DASHBOARD_CAPITAL_USD } from "./trading-engine.ts";
import { assertTradable, isExcludedInstrument } from "./trade-slots.ts";
import {
  runRelay,
  ReplayDeadlineError,
  type SessionBars,
  type RelayResult,
} from "./relay-engine.ts";
import {
  SEARCH_DEFAULTS,
  SEARCH_VERSION,
  SLOTS,
  boundaries,
  digest,
  coverageFor,
  costSnapshot,
  configProblems,
  propose,
  replayDevelopment,
  summarize,
  targetsFor as summarizeTargets,
  finalEvidence,
  type Trial,
  type SearchManifest,
} from "./slot-research.ts";
import { agentCandidate, designContext, designPrompt, validateDesignBatch, executableRule, type DesignBatch } from "./slot-research-agent.ts";
import type { GenerationJob } from "./strategy-generation-types.ts";
import type { GenerationReview } from "./strategy-generation-spec.ts";

const db = () => (env as unknown as { DB: D1Database }).DB;
export async function ensureSearchSchema() {
  await ensureSchema();
  await db().batch([
    db().prepare(
      "CREATE TABLE IF NOT EXISTS slot_research_artifacts (hash TEXT PRIMARY KEY,payload TEXT NOT NULL)",
    ),
    db().prepare(
      "CREATE TABLE IF NOT EXISTS slot_research_exposure (run_id TEXT PRIMARY KEY,from_date TEXT NOT NULL,to_date TEXT NOT NULL,symbols TEXT NOT NULL,phase TEXT NOT NULL)",
    ),
  ]);
}
export const searchRequestSchema = z
  .object({
    goal: z.enum(["discover", "complement", "idea"]).default("discover"),
    brief: z.string().max(1500).default(""),
    designMode: z.enum(["agent", "local"]).default("agent"),
    maxDesignBatches: z.number().int().min(1).max(2).default(2),
    universe: universeSchema.optional(),
    slot: z.enum(SLOT_IDS).optional(),
    slots: z.array(z.enum(SLOT_IDS)).min(1).max(9).optional(),
    budgetUsd: z.union([z.literal(8), z.literal(16), z.literal(24)]).default(8),
    requestId: z.string().uuid(),
    target: z
      .object({
        dailyTargetPct: z.union([z.literal(1), z.literal(1.5), z.literal(2)]),
        slots: z.number().int().min(1).max(9),
      })
      .nullable()
      .default(null),
    sourceMinutes: z.union([z.literal(1), z.literal(5)]).default(5),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    config: z
      .object({
        minPerSlot: z.number().int().min(8).max(16).optional(),
        maxPerSlot: z.number().int().min(8).max(16).optional(),
        maxBacktests: z.number().int().min(16).max(1000).optional(),
        maxComputeMs: z.number().int().min(1000).max(3600000).optional(),
        stagnationTrials: z.number().int().min(4).max(16).optional(),
        improvementPct: z.number().min(0.001).max(0.1).optional(),
      })
      .optional(),
  })
  .strict();
export async function createSlotResearch(ownerId: string, input: unknown) {
  const request = searchRequestSchema.parse(input);
  await ensureSearchSchema();
  const old = await db()
    .prepare("SELECT payload FROM strategy_generation_runs WHERE id=?")
    .bind(request.requestId)
    .first<{ payload: string }>();
  if (old) {
    const job = JSON.parse(old.payload) as GenerationJob;
    if (job.ownerId !== ownerId) throw new Error("요청 식별자 충돌");
    return job;
  }
  if (request.goal === "idea" && request.designMode !== "agent")
    throw new Error(
      "자유 서술 아이디어를 임의 규칙으로 바꾸지 않습니다. 현재 반복 연구는 명시된 네 전략 계열을 비교합니다. 자동 탐색을 선택하세요.",
    );
  const inventory = (await generationInventory()).filter(
    (r) =>
      r.provider === "Massive" &&
      r.interval === `${request.sourceMinutes}m` &&
      !isExcludedInstrument(r.symbol),
  );
  const universe =
    request.universe ??
    inventory
      .filter((r) => r.sessions >= 150)
      .sort(
        (a, b) => b.sessions - a.sessions || a.symbol.localeCompare(b.symbol),
      )
      .slice(0, 2)
      .map((r) => r.symbol);
  if (!universe.length)
    throw new Error(
      `보유 ${request.sourceMinutes}분봉에 연속 연구 범위가 없습니다. 사건일 전용 원본 봉은 일반 세션 분모로 사용하지 않습니다.`,
    );
  assertTradable(universe, "연구 범위");
  const rows = universe.map((symbol) =>
    inventory.find((r) => r.symbol === symbol),
  );
  if (rows.some((r) => !r))
    throw new Error(
      "선택 종목의 동일 출처·봉 주기 캐시가 없습니다. 먼저 데이터 확보가 필요합니다.",
    );
  const from =
    request.from ??
    rows
      .map((r) => r!.firstDate)
      .sort()
      .at(-1)!;
  const to = request.to ?? rows.map((r) => r!.lastDate).sort()[0];
  if (from >= to) throw new Error("공통 데이터 기간이 없습니다.");
  const registered =
    request.goal === "complement" ? await registeredRelayStrategies() : [];
  const slots = SLOTS.filter(
    (s) =>
      (request.slots
        ? request.slots.includes(s.id)
        : !request.slot || s.id === request.slot) &&
      !registered.some((r) => r.slot === s.id),
  ).map((s) => s.id);
  if (!slots.length) throw new Error("연구할 대상 슬롯이 없습니다.");
  if (request.target && request.target.slots !== slots.length)
    throw new Error("선택 목표의 슬롯 수와 대상 슬롯 수를 일치시켜 주세요.");
  const config = { ...SEARCH_DEFAULTS, ...request.config };
  const problem = configProblems(config, slots);
  if (problem) throw new Error(problem);
  if (request.sourceMinutes === 1 && config.maxBacktests < slots.length * (config.minPerSlot * 2 + 3) + 1)
    throw new Error("최소 개발 탐색과 최종·결합 시험 예약을 위한 백테스트 한도가 부족합니다.");
  const now = new Date().toISOString();
  const job: GenerationJob = {
    id: request.requestId,
    ownerId,
    slot: slots[0],
    status: "running",
    stageIndex: 0,
    createdAt: now,
    updatedAt: now,
    from,
    to,
    capitalUsd: DASHBOARD_CAPITAL_USD,
    brief: request.brief,
    universe,
    sourceBarMinutes: request.sourceMinutes,
    budgetUsd: request.budgetUsd,
    costUsd: 0,
    error: null,
    events: [],
    search: {
      version: 1,
      phase: "data",
      agent: { mode: request.designMode, maxDesignBatches: request.maxDesignBatches, batches: [] },
      evaluation: "unmeasured",
      slots,
      target: request.target,
      config,
      trials: [],
      backtests: 0,
      computeMs: 0,
      cacheHits: 0,
      selected: {},
      final: {},
    },
  };
  await createGenerationJob(job);
  return job;
}
export async function saveArtifact(hash: string, payload: unknown) {
  await db()
    .prepare(
      "INSERT INTO slot_research_artifacts (hash,payload) VALUES (?,?) ON CONFLICT(hash) DO NOTHING",
    )
    .bind(hash, JSON.stringify(payload))
    .run();
}
export async function getArtifact<T = unknown>(
  hash: string,
): Promise<T | null> {
  const row = await db()
    .prepare("SELECT payload FROM slot_research_artifacts WHERE hash=?")
    .bind(hash)
    .first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as T) : null;
}
/** Snapshot only authenticated provider rows at their actual native resolution. */
export async function readNativeCache(
  symbols: string[],
  from: string,
  to: string,
  step: 1 | 5,
) {
  const sessions = new Map<string, SessionBars>();
  for (const symbol of symbols) {
    const rows = await db()
      .prepare(
        "SELECT trading_date,payload,provider FROM intraday_bar_days WHERE symbol=? AND interval=? AND trading_date>=? AND trading_date<=? ORDER BY trading_date",
      )
      .bind(symbol, `${step}m`, from, to)
      .all<{ trading_date: string; payload: string; provider: string }>();
    for (const row of rows.results) {
      if (row.provider !== "Massive")
        throw new Error(`${symbol}: 캐시 출처 ${row.provider} 불일치`);
      const day = sessions.get(row.trading_date) ?? {
        date: row.trading_date,
        bars: {},
      };
      day.bars[symbol] = (
        JSON.parse(row.payload) as Array<
          [string, number, number, number, number, number]
        >
      ).map(([time, open, high, low, close, volume]) => ({
        date: row.trading_date,
        time,
        open,
        high,
        low,
        close,
        volume,
      }));
      day.barsByStep = { [step]: day.bars };
      sessions.set(day.date, day);
    }
  }
  return [...sessions.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function compactResult(result: RelayResult): RelayResult {
  return {
    ...result,
    days: result.days.map((day) => ({
      ...day,
      slots: day.slots.filter((s) => s.strategyId),
    })),
  };
}
type DevelopmentArtifact = {
  training: RelayResult;
  development: RelayResult;
  spec: StrategySpec;
  manifest: SearchManifest;
  diagnostics: Record<string, number>;
};
const sessionCache = new Map<string, SessionBars[]>();
async function snapshot(job: GenerationJob) {
  const key = job.search!.manifest!.dataHash;
  let sessions = sessionCache.get(key);
  if (!sessions) {
    sessions = await readGenerationData(
      `${job.id}:empirical`,
      job.sourceBarMinutes ?? 5,
    );
    sessionCache.clear();
    sessionCache.set(key, sessions);
  }
  if ((await digest(sessions)) !== key)
    throw new Error("동결 데이터 해시 불일치");
  return sessions;
}
export async function advanceSlotResearch(
  job: GenerationJob,
  token: string,
  review: (
    role: "riskReviewer" | "evidenceReviewer",
    context: unknown,
  ) => Promise<GenerationReview>,
  design?: (prompt: string) => Promise<DesignBatch>,
) {
  await ensureSearchSchema();
  const search = job.search!;
  const started = Date.now();
  const done = (reason: string) => {
    search.phase = "done";
    search.endReason = reason;
    const measuredSlots = new Set(search.trials.filter(t => t.status === "measured").map(t => t.slot));
    search.evaluation = measuredSlots.size === 0 ? "unmeasured" : measuredSlots.size === search.slots.length ? "measured" : "partial";
    job.status = measuredSlots.size > 0
      ? "completed"
      : "failed";
  };
  if (search.phase === "data") {
    // Shared loader checks durable coverage first and downloads only uncovered
    // ranges. Explicit native resolution is a research-only contract.
    const acquisitionWarnings: string[] = [];
    try {
      const loaded = await loadRelaySessions(
      job.universe!,
      job.from,
      job.to,
      0,
      () => undefined,
      job.sourceBarMinutes!,
      job.sourceBarMinutes!,
    );
      acquisitionWarnings.push(...loaded.warnings);
      if (loaded.sources.some(s => s.provider !== "Massive"))
        acquisitionWarnings.push("대체 공급자 자료는 원본 연구 스냅샷에 편입하지 않습니다.");
    } catch (error) {
      // An unavailable download is not a reason to discard valid acquired history.
      // readNativeCache still enforces provenance; coverageFor excludes missing bars.
      acquisitionWarnings.push(error instanceof Error ? error.message : String(error));
    }
    const sessions = await readNativeCache(
      job.universe!,
      job.from,
      job.to,
      job.sourceBarMinutes!,
    );
    if (!sessions.length) throw new Error(`원본 데이터 확보 미완료: ${acquisitionWarnings.join("; ") || "보유 캐시 없음"}`);
    const hasDaily = await db()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='daily_prices'",
      )
      .first();
    const daily = hasDaily
      ? await db()
          .prepare(
            "SELECT DISTINCT trading_date FROM daily_prices WHERE symbol IN ('SPY','QQQ') AND trading_date>=? AND trading_date<=? ORDER BY trading_date",
          )
          .bind(job.from, job.to)
          .all<{ trading_date: string }>()
      : { results: [] };
    const dates = [
      ...new Set([
        ...sessions.map((s) => s.date),
        ...daily.results.map((r) => r.trading_date),
      ]),
    ].sort();
    if (!dates.length) throw new Error("캐시에 측정 가능한 세션이 없습니다.");
    // Normalize via the same durable serializer before hashing.
    const groups = new Map<string, SessionBars[]>();
    for (const s of sessions) {
      const k = s.date.slice(0, 7);
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    let part = 0;
    for (const group of groups.values())
      await writeGenerationData(`${job.id}:empirical`, part++, group);
    const stored = await readGenerationData(
      `${job.id}:empirical`,
      job.sourceBarMinutes!,
    );
    const hash = await digest(stored);
    const exposure = await db()
      .prepare(
        "SELECT run_id,symbols FROM slot_research_exposure WHERE from_date<=? AND to_date>=? AND run_id<>?",
      )
      .bind(job.to, job.from, job.id)
      .all<{ run_id: string; symbols: string }>();
    const legacy = await db()
      .prepare(
        "SELECT id FROM strategy_generation_runs WHERE id<>? AND json_extract(payload,'$.from')<=? AND json_extract(payload,'$.to')>=?",
      )
      .bind(job.id, job.to, job.from)
      .all<{ id: string }>();
    const exposureRuns = [
      ...exposure.results
        .filter((r) =>
          JSON.parse(r.symbols).some((s: string) => job.universe!.includes(s)),
        )
        .map((r) => r.run_id),
      ...legacy.results.map((r) => r.id),
    ];
    search.manifest = {
      ...boundaries(job.from, job.to),
      dataHash: hash,
      source: "Massive adjusted OHLCV / intraday_bar_days",
      sourceMinutes: job.sourceBarMinutes!,
      engine: SEARCH_VERSION,
      symbols: job.universe!,
      dates,
      coverage: search.slots.map((slot) =>
        coverageFor(
          sessions,
          job.universe!,
          slot,
          job.sourceBarMinutes!,
          dates,
        ),
      ),
      costs: costSnapshot(job.universe!),
      exposure: exposureRuns.length ? "previously_seen" : "unknown",
      exposureRuns,
      provenance: [
        "현재 종목 범위의 수정주가 캐시; 원본 1분봉 내부 누락은 5분봉에서 확인 불가.",
        "시장 달력: 보유 SPY/QQQ 일봉 및 원본 분봉 관측일 합집합. 전체 달력 완전성 미확인.",
        "이전 파일 연구 및 모델 사전학습 노출을 모두 추적할 수 없어 독립 최종 검증 인증 불가.",
      ],
      acquisitionWarnings,
      createdAt: new Date().toISOString(),
    };
    await db()
      .prepare(
        "INSERT INTO slot_research_exposure VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING",
      )
      .bind(
        job.id,
        job.from,
        job.to,
        JSON.stringify(job.universe),
        "development",
      )
      .run();
    sessionCache.clear();
    sessionCache.set(hash, stored);
    const viable = search.manifest.coverage.some(c =>
      c.validDates.filter(d => d <= search.manifest!.trainingTo).length >= 90 &&
      c.validDates.filter(d => d > search.manifest!.trainingTo && d <= search.manifest!.developmentTo).length >= 20);
    search.phase = search.agent?.mode === "agent" && viable ? "design" : "search";
    job.events.push({
      at: new Date().toISOString(),
      stage: "data",
      state: "done",
      role: null,
      detail: `성과 조회 전 데이터·기간·${search.slots.length}슬롯 품질 분모 동결 · ${hash.slice(0, 12)}`,
    });
    return;
  }
  const manifest = search.manifest!;
  if (
    JSON.stringify(costSnapshot(job.universe!)) !==
      JSON.stringify(manifest.costs) ||
    manifest.engine !== SEARCH_VERSION
  )
    throw new Error(
      "비용/엔진 설정이 동결 버전과 달라 재개할 수 없습니다. 새 연구가 필요합니다.",
    );
  if (search.phase === "design" || search.phase === "reflect") {
    if (!design) throw new Error("연구 설계 에이전트가 연결되지 않았습니다.");
    const context = designContext(job, await snapshot(job));
    const prompt = designPrompt(context, search.phase === "reflect");
    const inputHash = await digest(prompt);
    // The model response is separately checkpointed by ask() before this commit.
    const result = validateDesignBatch(await design(prompt), manifest.sourceMinutes, search.slots);
    const outputHash = await digest(result);
    search.agent!.batches.push({ ...result, inputHash, outputHash,
      basedOnTrialIds: search.trials.map(t => t.id), createdAt: new Date().toISOString() });
    search.phase = "search";
    job.events.push({ at: new Date().toISOString(), stage: "design", state: "done", role: "designer",
      detail: `에이전트 설계 배치 ${search.agent!.batches.length} · 네 계열 · ${search.trials.length}개 개발 실험 진단 반영 · ${result.summary}` });
    return;
  }
  if (search.phase === "search") {
    const viableSlots = search.slots.filter(slot => !search.trials.some(t => t.slot === slot && ["data_error", "execution_error"].includes(t.status)));
    // Finish the fair baseline allocation before asking for a single batched revision.
    // Compute limits and final reserve are checked BEFORE any additional paid design.
    const finalReserve = manifest.sourceMinutes === 1 ? search.slots.length * 3 + 1 : 0;
    const searchBacktestLimit = search.config.maxBacktests - finalReserve;
    if (search.agent?.mode === "agent" && search.agent.batches.length === 1 &&
      search.agent.maxDesignBatches > 1 && search.config.maxPerSlot > 8 && viableSlots.length &&
      viableSlots.every(slot => search.trials.filter(t => t.slot === slot).length >= 8) &&
      search.backtests + viableSlots.length * 4 <= searchBacktestLimit &&
      search.computeMs < search.config.maxComputeMs * (1 - search.config.reserveFraction)) {
      search.phase = "reflect";
      return;
    }
    const next = propose(search);
    if (
      !next ||
      search.backtests + 2 > searchBacktestLimit ||
      search.computeMs >= search.config.maxComputeMs * (manifest.sourceMinutes === 1 ? 1 - search.config.reserveFraction : 1)
    ) {
      search.endReason =
        search.computeMs >= search.config.maxComputeMs
          ? "계산 시간 상한"
          : search.backtests + 2 > searchBacktestLimit
            ? "백테스트 상한"
            : search.trials.length >=
                search.slots.length * search.config.maxPerSlot
              ? "사전 탐색 범위 소진"
              : "최소 탐색 후 개선 정체/계열 범위 소진";
      search.phase = "freeze";
      return;
    }
    const proposal = agentCandidate(search,
      next.family,
      next.round,
      next.parent,
    );
    const { candidate, change } = proposal;
    candidate.barInterval = `${job.sourceBarMinutes}m` as "1m" | "5m";
    const id = `${next.slot}-${next.family}-${next.round}`;
    const spec: StrategySpec = {
      version: 1,
      id,
      slot: next.slot,
      universe: job.universe!,
      candidate,
      evidence: `${SEARCH_VERSION}; 개발 비교·반복 선택; ${manifest.sourceMinutes}분 원본`,
    };
    const hash = await digest({
      data: manifest.dataHash,
      engine: manifest.engine,
      costs: manifest.costs,
      rules: { slot: spec.slot, universe: spec.universe, candidate: executableRule(candidate) },
      capital: job.capitalUsd,
      boundaries: boundaries(job.from, job.to),
      maxTrials: search.config.maxPerSlot * search.slots.length,
    });
    const trial: Trial = {
      id,
      hash,
      slot: next.slot,
      family: next.family,
      parentId: next.parent?.id,
      change,
      spec,
      status: "execution_error",
      reasons: [],
      failure: "execution",
      deltaPct: null,
      eligible: false,
      artifact: hash,
      designHash: "designHash" in proposal ? proposal.designHash : undefined,
    };
    const cached = await getArtifact<{
      trial: Trial;
      detail?: DevelopmentArtifact;
    }>(hash);
    if (cached) {
      // Keep current identity, lineage, agent provenance and target selection.
      for (const key of ["status", "reasons", "failure", "eligible", "diagnostics", "train", "development"] as const)
        Object.assign(trial, { [key]: structuredClone(cached.trial[key]) });
      for (const summary of [trial.train, trial.development])
        if (summary) summary.targets = summarizeTargets(summary.metrics.meanDailyPct, search.target);
      search.cacheHits++;
    } else {
      const sourceSessions = await snapshot(job);
      try {
        const result = replayDevelopment(
          spec,
          sourceSessions,
          manifest,
          search.target,
          search.config,
          job.capitalUsd,
          {
            deadlineAt:
              started +
              Math.max(0, search.config.maxComputeMs - search.computeMs),
            onBacktest: () => {
              search.backtests++;
            },
          },
        );
        if (result.error) {
          trial.status = "data_error";
          trial.reasons = [result.error];
        } else if (
          result.train &&
          result.dev &&
          result.training &&
          result.development
        ) {
          trial.status = "measured";
          trial.train = result.train;
          trial.development = result.dev;
          trial.diagnostics = result.counters;
          trial.failure = result.failure!;
          trial.reasons = result.reasons!;
          trial.eligible = !trial.reasons.length;
          trial.deltaPct =
            next.parent?.development?.metrics.meanDailyPct != null &&
            trial.development.metrics.meanDailyPct != null
              ? trial.development.metrics.meanDailyPct -
                next.parent.development.metrics.meanDailyPct
              : null;
          await saveArtifact(hash, {
            trial,
            detail: {
              training: compactResult(result.training),
              development: compactResult(result.development),
              spec,
              manifest,
              diagnostics: result.counters,
            },
          });
        }
      } catch (error) {
        // A storage fault is recoverable infrastructure, not evidence against a strategy.
        if (trial.status === "measured") throw error;
        if (error instanceof ReplayDeadlineError) {
          trial.status = "budget_exhausted";
          search.phase = "freeze";
          search.endReason = "계산 시간 상한 · 중단된 실험은 미측정";
          trial.artifact = await digest({
            hash,
            job: job.id,
            kind: "budget_unmeasured",
          });
        }
        trial.reasons = [
          error instanceof Error ? error.message : String(error),
        ];
      }
      if (trial.status === "budget_exhausted")
        await saveArtifact(trial.artifact, { trial });
      if (trial.status !== "measured" && trial.status !== "budget_exhausted")
        await saveArtifact(hash, { trial });
    }
    trial.deltaPct = next.parent?.development?.metrics.meanDailyPct != null && trial.development?.metrics.meanDailyPct != null
      ? trial.development.metrics.meanDailyPct - next.parent.development.metrics.meanDailyPct : null;
    search.trials.push(trial);
    search.computeMs += Date.now() - started;
    job.events.push({
      at: new Date().toISOString(),
      stage: "training",
      state: trial.status === "measured" ? "done" : "error",
      role: null,
      detail: `${id} · ${change} · ${trial.failure} · 개발 일평균 ${trial.development?.metrics.meanDailyPct ?? "미측정"}%`,
    });
    return;
  }
  if (search.phase === "freeze") {
    for (const slot of search.slots) {
      const best = search.trials
        .filter((t) => t.slot === slot && t.eligible)
        .sort(
          (a, b) =>
            (b.development!.metrics.meanDailyPct ?? -Infinity) -
              (a.development!.metrics.meanDailyPct ?? -Infinity) ||
            a.id.localeCompare(b.id),
        )[0];
      if (best) search.selected[slot] = best.id;
    }
    search.frozenHash = await digest({
      selected: search.selected,
      specs: search.trials
        .filter((t) => Object.values(search.selected).includes(t.id))
        .map((t) => t.spec),
      manifest: manifest.dataHash,
    });
    search.frozenAt = new Date().toISOString();
    if (!Object.keys(search.selected).length) {
      done(
        `${search.endReason} · 개발 진출 기준 충족 후보 없음 · 최종 구간 미개봉`,
      );
      return;
    }
    // Native 5m cannot certify the live runner's complete-minute contract.
    if (manifest.sourceMinutes !== 1) {
      done(
        `${search.endReason} · 5분봉 개발 후보 보존 · 원본 1분봉 실행 검증 필요 · 최종 미개봉`,
      );
      return;
    }
    search.phase = "review";
    return;
  }
  if (search.phase === "review") {
    const reviewManifest = {
      ...manifest,
      dates: undefined,
      coverage: manifest.coverage.map((c) => ({
        slot: c.slot,
        valid: c.validDates.length,
        excluded: c.excluded.length,
      })),
      provenance: manifest.provenance,
    };
    search.review = await review("riskReviewer", {
      manifest: reviewManifest,
      config: search.config,
      totalTrials: search.trials.length,
      selected: search.trials.filter((t) =>
        Object.values(search.selected).includes(t.id),
      ),
      execution: EXECUTION_LIMITS,
    });
    if (!search.review.approved || search.review.blockers.length) {
      done("독립 위험 검토 반려 · 최종 미개봉");
      return;
    }
    search.phase = "final";
    // Persist joint selection and review BEFORE reading any test outcome.
    await generationProgress(job, token);
    return;
  }
  if (search.phase === "final") {
    const selected = search.trials.filter((t) =>
      Object.values(search.selected).includes(t.id),
    );
    const frozen = await digest({
      selected: search.selected,
      specs: selected.map((t) => t.spec),
      manifest: manifest.dataHash,
    });
    if (frozen !== search.frozenHash)
      throw new Error("동결 후보/결합 규칙 불일치");
    const sessions = await snapshot(job);
    const runFinal = (
      strategies: Parameters<typeof runRelay>[0],
      days: SessionBars[],
      stress = {},
    ) => {
      const replayStarted = Date.now();
      search.backtests++;
      try { return runRelay(strategies, days, {
        capitalUsd: job.capitalUsd,
        ...stress,
        deadlineAt:
          replayStarted + Math.max(0, search.config.maxComputeMs - search.computeMs),
      }); } finally { search.computeMs += Date.now() - replayStarted; }
    };
    for (const t of selected) {
      if (search.final[t.slot]) continue;
      if (search.backtests + 3 > search.config.maxBacktests) {
        done("최종 검증 계산 상한 · 검증 미완료");
        return;
      }
      const valid = new Set(
        manifest.coverage.find((c) => c.slot === t.slot)!.validDates,
      );
      const days = sessions.filter(
        (s) => s.date >= manifest.holdoutFrom && valid.has(s.date),
      );
      const strategy = compileStrategy(t.spec);
      const result = runFinal([strategy], days),
        stress = runFinal([strategy], days, { costMultiplier: 2 }),
        delayed = runFinal([strategy], days, { entryDelayBars: 1 });
      const prior = (await getArtifact<{ detail: DevelopmentArtifact }>(
        t.artifact,
      ))!.detail;
      const evidence = finalEvidence(
        prior.training,
        prior.development,
        result,
        stress,
        delayed,
        search.frozenAt!,
      );
      const reasons = [
        ...evidence.reasons,
        "과거 노출 독립성 미확인: 새 독립 검증 통과로 표시하지 않음",
      ];
      const key = await digest({ frozen, slot: t.slot, kind: "final" });
      await saveArtifact(key, { result, stress, delayed, evidence, manifest });
      search.final[t.slot] = {
        summary: summarize(
          result,
          search.target,
          search.config.maxPerSlot * search.slots.length,
        ),
        reasons,
        passed: false,
        artifact: key,
        evidence,
      };
      await generationProgress(job, token);
    }
    if (!search.combined) {
      const sets = selected.map(
        (t) =>
          new Set(manifest.coverage.find((c) => c.slot === t.slot)!.validDates),
      );
      const days = sessions.filter(
        (s) =>
          s.date >= manifest.holdoutFrom &&
          sets.every((set) => set.has(s.date)),
      );
      if (search.backtests + 1 > search.config.maxBacktests) {
        done("결합 검증 계산 상한 · 검증 미완료");
        return;
      }
      const combined = runFinal(
        selected.map((t) => compileStrategy(t.spec)),
        days,
      );
      search.combined = summarize(combined, null, search.trials.length);
      search.combined.targets = [];
      search.combinedArtifact = await digest({ frozen, kind: "combined" });
      await saveArtifact(search.combinedArtifact, {
        result: combined,
        manifest,
      });
    }
    search.finalReview = await review("evidenceReviewer", {
      frozenHash: frozen,
      manifest,
      totalTrials: search.trials.length,
      final: Object.fromEntries(
        Object.entries(search.final).map(([slot, f]) => [
          slot,
          { summary: f.summary, reasons: f.reasons, passed: f.passed },
        ]),
      ),
      combined: search.combined,
      policy:
        "No tuning, no claim of independent unused data. Existing deterministic gates are binding.",
    });
    done("동결 후보·결합 규칙 공통 최종 기간 평가 종료 · 노출 독립성 미확인");
  }
}
