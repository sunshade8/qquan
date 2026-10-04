/** Measured development experience, never a source of final-test outcomes or approval. */
import type { GenerationJob } from "./strategy-generation-types.ts";
import type { Failure, Trial } from "./slot-research.ts";

export const MEMORY_VERSION = 1;
export const MEMORY_LIMIT = 24;
export const FAILURE_LESSONS: Record<Failure, string> = {
  no_trades: "조건별 차단 횟수와 거래 수를 확인하고 양립하지 않는 조건 하나를 수정한다. 무거래는 수익성 증거가 아니다.",
  cost_drag: "총손익과 비용을 분리하고 거래 빈도·보유 시간·목표 움직임을 변경한다. 비용 가정을 낮추지 않는다.",
  regime: "시간순 전·후반 차이를 설명할 관측 가능한 시장 조건을 시험한다. 유리했던 날짜만 골라내지 않는다.",
  concentration: "일부 거래에 의존하는 수익을 확인하고 더 넓은 표본에서 재검증한다. 최고 거래를 일반화하지 않는다.",
  execution: "데이터·실행 문제를 먼저 해결한다. 미측정 실패를 전략 손실이나 0% 수익으로 해석하지 않는다.",
  no_edge: "현재 조건에서 비용 후 우위가 확인되지 않았다. 같은 규칙의 이름 변경보다 구체적인 메커니즘 변경을 시험한다.",
  promising: "개발에서만 유망하다. 독립된 새 자료와 실행 검증 전에는 승인이나 실전 수익으로 해석하지 않는다.",
};

const stats = (part: Trial["development"]) => part ? {
  from: part.from, to: part.to,
  sessions: part.metrics.sessions, trades: part.metrics.totalTrades,
  meanDailyPct: part.metrics.meanDailyPct, maxDrawdownPct: part.metrics.maxDrawdownPct,
  costUsd: part.metrics.costPaidUsd, grossPnlUsd: part.grossPnlUsd,
  fireRatePct: part.fireRatePct, halves: part.halves,
  topProfitShare: part.topProfitShare, selectionLowerPct: part.selectionLowerPct,
} : null;

export function experimentRecord(job: GenerationJob, trial: Trial) {
  const m = job.search!.manifest!;
  return {
    version: MEMORY_VERSION, id: `${job.id}/${trial.id}`, runId: job.id,
    trialId: trial.id, experimentHash: trial.hash, artifact: trial.artifact,
    slot: trial.slot, family: trial.family, status: trial.status, failure: trial.failure,
    hypothesis: trial.spec.candidate.hypothesis,
    rule: trial.spec.candidate, universe: trial.spec.universe,
    parentId: trial.parentId ?? null, change: trial.change, deltaPct: trial.deltaPct,
    reasons: trial.reasons.slice(0, 8).map(r => r.slice(0, 400)),
    diagnostics: trial.diagnostics ?? {},
    train: stats(trial.train), development: stats(trial.development),
    data: { hash: m.dataHash, source: m.source, minutes: m.sourceMinutes,
      from: m.from, trainingTo: m.trainingTo, developmentTo: m.developmentTo },
    engine: m.engine, costs: m.costs, capitalUsd: job.capitalUsd,
    lesson: FAILURE_LESSONS[trial.status === "measured" ? trial.failure : "execution"],
    evidence: "Repeatedly selected development observations; not independent validation or causal proof.",
  };
}
export type ExperimentRecord = ReturnType<typeof experimentRecord>;
export type ResearchMemory = {
  version: 1; frozenAt: string; scannedRuns: number; eligibleExperiments: number;
  excludedFuture: number; excludedContext: number; duplicateExperiments: number;
  records: ExperimentRecord[];
};

/** Use only prior same-owner work available at this run's creation; freeze before model calls. */
export function selectResearchMemory(job: GenerationJob, prior: GenerationJob[]): ResearchMemory {
  const current = job.search!.manifest!;
  const memory: ResearchMemory = { version: 1, frozenAt: job.createdAt, scannedRuns: 0,
    eligibleExperiments: 0, excludedFuture: 0, excludedContext: 0, duplicateExperiments: 0, records: [] };
  const unique = new Set<string>();
  const groups = new Map<string, ExperimentRecord[]>();
  const symbols = [...job.universe!].sort().join(",");
  for (const old of prior) {
    if (old.ownerId !== job.ownerId || old.id === job.id || old.updatedAt > job.createdAt || !old.search?.manifest) continue;
    memory.scannedRuns++;
    const m = old.search.manifest;
    // Even a prior DESIGN might have consumed its entire development window.
    // Exclude the whole run if any design input could overlap today's sealed test.
    if (m.developmentTo >= current.holdoutFrom || m.trainingTo > current.developmentTo) {
      memory.excludedFuture += old.search.trials.length;
      continue;
    }
    if (m.engine !== current.engine || m.source !== current.source || m.sourceMinutes !== current.sourceMinutes ||
      [...old.universe!].sort().join(",") !== symbols || old.capitalUsd !== job.capitalUsd ||
      JSON.stringify(Object.entries(m.costs).sort()) !== JSON.stringify(Object.entries(current.costs).sort())) {
      memory.excludedContext += old.search.trials.length;
      continue;
    }
    for (const trial of old.search.trials) {
      if (!job.search!.slots.includes(trial.slot)) continue;
      if (trial.development && trial.development.to >= current.holdoutFrom) { memory.excludedFuture++; continue; }
      if (unique.has(trial.hash)) { memory.duplicateExperiments++; continue; }
      unique.add(trial.hash);
      memory.eligibleExperiments++;
      const key = `${trial.slot}/${trial.family}`;
      groups.set(key, [...(groups.get(key) ?? []), experimentRecord(old, trial)]);
    }
  }
  // Round-robin by slot/family keeps a frequently tried family from taking all context.
  for (let i = 0; memory.records.length < MEMORY_LIMIT; i++) {
    let added = false;
    for (const records of groups.values()) {
      if (!records[i]) continue;
      memory.records.push(records[i]); added = true;
      if (memory.records.length === MEMORY_LIMIT) break;
    }
    if (!added) break;
  }
  return memory;
}

/** Export an allowlisted research journal. Excludes account IDs, credentials and model call payloads. */
export function researchJournal(job: GenerationJob) {
  return {
    version: MEMORY_VERSION, id: job.id, createdAt: job.createdAt, updatedAt: job.updatedAt,
    status: job.status, from: job.from, to: job.to, universe: job.universe,
    brief: job.brief, capitalUsd: job.capitalUsd, costUsd: job.costUsd,
    phase: job.search?.phase, endReason: job.search?.endReason,
    memory: job.search?.memory, designs: job.search?.agent?.batches ?? [],
    experiments: job.search?.manifest ? job.search.trials.map(t => experimentRecord(job, t)) : [],
    // Final outcomes live in a separate field and are never consumed by selectResearchMemory.
    finalEvaluation: job.search?.final ?? {},
    combinedEvaluation: job.search?.combined ?? null,
    limitations: ["LLM weights are not trained; historical evidence is supplied as context.",
      "Development observations are selected repeatedly and do not prove future profitability."],
  };
}
