/**
 * CT 연구의 "지금 무슨 일이 일어나는가"를 저장된 job에서 파생한다. React 없이 순수 함수라
 * 화면(이 탭이 진행하든, 러너나 다른 브라우저가 진행하든)과 테스트가 같은 판정을 쓴다.
 *  - mergeCalls: 저장된 모델 호출 + 실시간 사용량 스냅샷(meter)
 *  - ctNow: 현재 작업 주체(모델 호출 / 서버 도구 / 재시도 대기 / 단계 전환)와 멈춤 판정
 *  - ctAgents: 연구에 참여하는 에이전트별 상태와 누적 사용량
 *  - ctTimeline: 도구 호출과 모델 호출을 한 시간순 목록으로
 */
import type { GenerationJob, ResearchCall, ResearchMeter } from "./strategy-generation-types.ts";
import type { CTResearch, CTToolTrace } from "./ct-research.ts";
import { GENERATION_MODELS, researchMaxTokens, type GenerationRole } from "./strategy-generation-models.ts";

export type CTCall = Omit<ResearchCall, "result" | "key">;
export type CTActivityJob = Pick<
  GenerationJob,
  "id" | "status" | "createdAt" | "updatedAt" | "calls" | "liveMeter" | "error" | "recovery" | "nextAction" | "costUsd" | "budgetUsd"
> & { ct: CTResearch };

/* ------------------------------------------------------------------ calls */

/** Newer of the meter saved by whoever drives the job and the one streamed to this tab. */
export function pickMeter(jobId: string, saved?: ResearchMeter | null, streamed?: ResearchMeter | null) {
  const s = streamed?.jobId === jobId ? streamed : null;
  if (!s) return saved ?? null;
  if (!saved) return s;
  return s.call.updatedAt >= saved.call.updatedAt ? s : saved;
}

/**
 * The job payload is checkpointed at most every 10s during a call; the meter every ~2s.
 * A terminal status in the payload always wins: a meter written just before the call
 * failed still says "started" and must not resurrect it.
 */
export function mergeCalls(calls: ResearchCall[] | undefined, meter: ResearchMeter | null): CTCall[] {
  const list: CTCall[] = (calls ?? []).map((call) => {
    const { result: _r, key: _k, ...rest } = call;
    void _r;
    void _k;
    return rest;
  });
  if (!meter) return list;
  const index = list.findIndex((c) => c.id === meter.call.id);
  if (index < 0) list.push({ ...meter.call });
  else if (list[index].status === "started" && meter.call.updatedAt >= list[index].updatedAt)
    list[index] = { ...list[index], ...meter.call, status: meter.call.status };
  return list;
}

/* ----------------------------------------------------------------- agents */

export type CTAgentId = "engine" | "orchestrator" | "dataAnalyst" | "designer" | "riskReviewer" | "evidenceReviewer";
type Phase = CTResearch["phase"];
export const CT_AGENTS: ReadonlyArray<{ id: CTAgentId; name: string; duty: string; phases: Phase[] }> = [
  { id: "engine", name: "서버 엔진", duty: "데이터 동결 · 원문 읽기 · 백테스트", phases: ["data", "read", "experiment", "final"] },
  { id: "orchestrator", name: "총괄", duty: "웹 검색으로 공개 접근법 탐색", phases: ["sources"] },
  { id: "dataAnalyst", name: "자료 분석", duty: "원문에서 원리 · 구현 가정 추출", phases: ["approaches"] },
  { id: "designer", name: "전략 설계", duty: "가설 · 규칙 설계와 실패 후 수정", phases: ["design", "reflect"] },
  { id: "riskReviewer", name: "독립 위험 검토", duty: "동결 규칙의 누출 · 과최적화 검토", phases: ["risk_review"] },
  { id: "evidenceReviewer", name: "독립 최종 검토", duty: "최종 평가 증거 · 수치 게이트 확인", phases: ["evidence_review"] },
];
export const agentOf = (id: CTAgentId) => CT_AGENTS.find((a) => a.id === id)!;
const isRole = (id: CTAgentId): id is Exclude<CTAgentId, "engine"> => id !== "engine";
export function agentModel(id: CTAgentId, call?: CTCall) {
  if (!isRole(id)) return { model: "모델 없음", provider: "로컬 계산" };
  const m = GENERATION_MODELS[id];
  return { model: call?.model ?? m.model, provider: call?.provider ?? m.provider };
}

/* ------------------------------------------------------------- now state */

const BACKTEST_KIND: Record<string, string> = {
  training: "학습 구간",
  development: "개발 구간",
  development_stress: "개발 구간 · 비용 2배",
  development_delay: "개발 구간 · 진입 1봉 지연",
  "sensitivity_0.9": "민감도 · 손절 ×0.9",
  "sensitivity_1.1": "민감도 · 손절 ×1.1",
  final: "최종 구간",
  final_stress: "최종 구간 · 비용 2배",
  final_delay: "최종 구간 · 진입 1봉 지연",
};
export const backtestKind = (kind: unknown) => BACKTEST_KIND[String(kind)] ?? String(kind ?? "");
export const hostOf = (u: unknown) => {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, "");
  } catch {
    return String(u ?? "");
  }
};
const trialNo = (id: unknown) => {
  const n = Number(String(id ?? "").split(":").at(-1));
  return Number.isFinite(n) ? `후보 ${n + 1}` : "후보";
};

/** What a running tool is doing, as a sentence. */
export function toolDoing(t: Pick<CTToolTrace, "name" | "input">) {
  const i = (t.input ?? {}) as Record<string, unknown>;
  switch (t.name) {
    case "collect_market_data": return `${i.symbol ?? ""} 시세 데이터를 수집하고 있습니다`;
    case "inspect_data": return "동결된 데이터 스냅샷을 확인하고 있습니다";
    case "allowed_research_memory": return "허용된 과거 연구 기억을 조회하고 있습니다";
    case "search_public_approaches": return "검색 결과의 출처를 검증하고 있습니다";
    case "read_public_source": return `${hostOf(i.url)} 원문을 읽고 있습니다`;
    case "analyze_training": return "학습 구간 통계를 계산하고 있습니다";
    case "compile_strategy": return "후보 규칙을 컴파일하고 실행 가능성을 검사하고 있습니다";
    case "backtest": return `${backtestKind(i.kind)} 백테스트를 실행하고 있습니다`;
    case "failure_diagnosis": return `${trialNo(i.trialId)}의 실패 원인을 진단하고 있습니다`;
    default: return `${t.name} 도구를 실행하고 있습니다`;
  }
}

/** What a model call is doing, as a sentence. The designer both designs and revises. */
export function callDoing(role: GenerationRole, ct: CTResearch) {
  switch (role) {
    case "orchestrator": return "웹을 검색해 공개 차트 매매 접근법을 찾고 있습니다";
    case "dataAnalyst": return "읽은 원문에서 원리와 구현 가정을 추출하고 있습니다";
    case "designer":
      return ct.trials.length || ct.phase === "reflect"
        ? "측정된 실패를 보고 후보 규칙을 수정하고 있습니다"
        : "첫 가설과 매매 규칙을 설계하고 있습니다";
    case "riskReviewer": return "동결한 규칙의 누출 · 체결 · 과최적화 위험을 독립 검토하고 있습니다";
    case "evidenceReviewer": return "최종 평가 증거와 수치 게이트를 독립 검토하고 있습니다";
    default: return `${GENERATION_MODELS[role]?.label ?? role} 모델이 응답하고 있습니다`;
  }
}

/** Concrete context for the current phase, built from counts the job already has. */
export function phaseContext(ct: CTResearch) {
  const c = ct.contract;
  const next = Math.min(ct.trials.length + 1, c.policy.maxCandidates);
  switch (ct.phase) {
    case "data": return `${c.symbols.join(", ")} · ${c.minutes}분봉 · 학습/개발/최종 구간 고정`;
    case "sources": return `${c.symbols.join(", ")} · ${c.minutes}분봉 관점으로 원문 2–6건 선정`;
    case "read": return `선정 URL ${ct.search?.urls.length ?? 0}건 중 ${ct.sources.length}건 읽음`;
    case "approaches": return `확인된 원문 ${ct.sources.length}건 · 원문에 실제 있는 인용만 허용`;
    case "design": return `후보 ${next}/${c.policy.maxCandidates} · 출처 ${ct.sources.length}건 · 학습 구간 통계만 사용`;
    case "reflect": return `후보 ${next}/${c.policy.maxCandidates} · 이전 후보 ${ct.trials.length}개의 측정 실패 반영`;
    case "experiment": return `학습 · 개발 · 비용 2배 · 1봉 지연 · 손절 민감도 · 누적 백테스트 ${ct.backtests}회`;
    case "risk_review": return "규칙 해시 동결 후 독립 모델 검토 · 제공자 장애는 승인으로 대체하지 않음";
    case "final": return "최종 구간을 한 번만 열어 동결 규칙을 평가";
    case "evidence_review": return "독립 최종 검토와 서버 수치 게이트를 모두 통과해야 등록 가능";
    case "done": return ct.endReason ?? "연구 종료";
  }
}

export type CTNow =
  | { kind: "model"; agent: CTAgentId; call: CTCall; since: string; signalAt: string; maxTokens: number }
  | { kind: "tool"; agent: "engine"; trace: CTToolTrace; since: string; signalAt: string }
  | { kind: "retry"; agent: CTAgentId | null; error: string; retryAt: string; failures: number; signalAt: string; truncatedAt?: number }
  | { kind: "between"; agent: CTAgentId | null; signalAt: string }
  | { kind: "paused" | "ended"; agent: null; signalAt: string };

const later = (a: string, b?: string) => (b && b > a ? b : a);
/** The agent that owns a phase when nothing is visibly in flight. */
export function phaseAgent(phase: Phase): CTAgentId | null {
  return CT_AGENTS.find((a) => a.phases.includes(phase))?.id ?? null;
}

export function ctNow(job: CTActivityJob, calls: CTCall[]): CTNow {
  const { ct } = job;
  let signalAt = job.updatedAt;
  for (const c of calls) signalAt = later(signalAt, c.updatedAt);
  if (job.status === "paused") return { kind: "paused", agent: null, signalAt };
  if (job.status !== "running") return { kind: "ended", agent: null, signalAt };
  const call = [...calls].reverse().find((c) => c.status === "started");
  if (call)
    return { kind: "model", agent: call.role as CTAgentId, call, since: call.startedAt, signalAt, maxTokens: researchMaxTokens(call.role) };
  const trace = [...ct.tools].reverse().find((t) => t.status === "started");
  if (trace) return { kind: "tool", agent: "engine", trace, since: trace.at, signalAt };
  if (job.recovery?.retryAt) {
    const failed = calls.at(-1)?.status === "failed" ? calls.at(-1)! : null;
    // A failed call that used its whole output allowance was cut off, not refused.
    const cap = failed ? researchMaxTokens(failed.role) : 0;
    return {
      kind: "retry",
      agent: (failed?.role as CTAgentId | undefined) ?? phaseAgent(ct.phase),
      ...(failed && (failed.usage.output_tokens ?? 0) >= cap ? { truncatedAt: cap } : {}),
      error: job.recovery.message || job.error || "일시적 오류",
      retryAt: job.recovery.retryAt,
      failures: job.recovery.failures,
      signalAt,
    };
  }
  return { kind: "between", agent: phaseAgent(ct.phase), signalAt };
}

/**
 * Nothing new has been written for longer than the work in flight can explain.
 * Model calls can reason silently for minutes before the first usage event; tools,
 * step transitions and scheduled retries write within seconds.
 */
export function stalledFor(now: CTNow, nowMs: number) {
  if (now.kind === "paused" || now.kind === "ended") return 0;
  const quiet = nowMs - Date.parse(now.signalAt);
  const allowance =
    now.kind === "model" ? 5 * 60_000
    : now.kind === "retry" ? Math.max(0, Date.parse(now.retryAt) - Date.parse(now.signalAt)) + 45_000
    : 45_000;
  return quiet > allowance ? quiet : 0;
}

/* --------------------------------------------------------------- roster */

export type CTAgentState = "working" | "retry" | "waiting" | "done" | "failed" | "idle";
export type CTAgentRow = {
  id: CTAgentId;
  name: string;
  duty: string;
  model: string;
  provider: string;
  state: CTAgentState;
  calls: number;
  tools: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  lastAt: string | null;
};
export function ctAgents(job: CTActivityJob, calls: CTCall[], now: CTNow): CTAgentRow[] {
  const { ct } = job;
  return CT_AGENTS.map((a) => {
    const mine = calls.filter((c) => c.role === a.id);
    const tools = a.id === "engine" ? ct.tools : [];
    const last = mine.at(-1);
    const lastAt = [last?.updatedAt, tools.at(-1)?.at].filter(Boolean).sort().at(-1) ?? null;
    const used = mine.length > 0 || tools.length > 0;
    let state: CTAgentState = used ? "done" : "idle";
    if (last?.status === "failed" || last?.status === "interrupted") state = "failed";
    if (now.agent === a.id) state = now.kind === "model" || now.kind === "tool" ? "working" : now.kind === "retry" ? "retry" : "waiting";
    const { model, provider } = agentModel(a.id, last);
    return {
      id: a.id,
      name: a.name,
      duty: a.duty,
      model,
      provider,
      state,
      calls: mine.length,
      tools: tools.length,
      costUsd: mine.reduce((s, c) => s + (c.costUsd ?? 0), 0),
      inputTokens: mine.reduce((s, c) => s + (c.usage.input_tokens ?? 0) + (c.usage.cache_read_input_tokens ?? 0), 0),
      outputTokens: mine.reduce((s, c) => s + (c.usage.output_tokens ?? 0), 0),
      lastAt,
    };
  });
}

/* ------------------------------------------------------------- timeline */

export type CTTimelineEntry =
  | { kind: "tool"; key: string; at: string; trace: CTToolTrace }
  | { kind: "call"; key: string; at: string; call: CTCall };
/** Oldest first. Keys are stable across polls so the feed can mark only genuinely new rows. */
export function ctTimeline(tools: CTToolTrace[], calls: CTCall[]): CTTimelineEntry[] {
  const entries: CTTimelineEntry[] = [
    ...tools.map((trace, i) => ({ kind: "tool" as const, key: `t:${trace.id}:${i}`, at: trace.at, trace })),
    ...calls.map((call) => ({ kind: "call" as const, key: `c:${call.id}`, at: call.startedAt, call })),
  ];
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
