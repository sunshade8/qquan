/**
 * CT 연구의 "지금 무슨 일이 일어나는가"를 저장된 job에서 파생한다. React 없이 순수 함수라
 * 화면(이 탭이 진행하든, 러너나 다른 브라우저가 진행하든)과 테스트가 같은 판정을 쓴다.
 *  - mergeCalls: 저장된 모델 호출 + 실시간 사용량 스냅샷(meter)
 *  - ctNow: 현재 작업 주체(모델 호출 / 서버 도구 / 재시도 대기 / 단계 전환)와 멈춤 판정
 *  - ctAgents: 연구에 참여하는 에이전트별 상태와 누적 사용량
 *  - ctTimeline: 도구 호출과 모델 호출을 한 시간순 목록으로
 */
import type { GenerationJob, ResearchCall, ResearchMeter } from "./t-generation-types.ts";
import type { CTResearch, CTToolTrace } from "./t-research.ts";
import { RESEARCH_MODELS, researchMaxTokens, type CTRole, type GenerationRole } from "./t-generation-models.ts";
import { ctSessionPolicy } from "./t-spec.ts";

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

export type CTAgentId = "engine" | CTRole;
type Phase = CTResearch["phase"];
export const CT_AGENTS: ReadonlyArray<{ id: CTAgentId; name: string; duty: string; phases: Phase[] }> = [
  { id: "engine", name: "서버 엔진", duty: "데이터 동결 · 원문 읽기 · 측정 도구 · 백테스트", phases: ["data", "read", "experiment", "final"] },
  { id: "ctOrchestrator", name: "총괄", duty: "웹 검색으로 공개 접근법 탐색(선택)", phases: ["sources"] },
  { id: "ctAnalyst", name: "자료 분석", duty: "원문에서 원리 · 구현 가정 추출", phases: ["approaches"] },
  { id: "ctDesigner", name: "연구 · 설계", duty: "학습 구간 측정으로 가설 검증 · 규칙 설계와 수정", phases: ["design", "reflect"] },
  { id: "ctLessons", name: "교훈 증류", duty: "끝난 연구를 계열 단위 교훈으로 정리(모든 수치를 가린 입력 · 판정권 없음)", phases: ["done"] },
  { id: "ctRiskReviewer", name: "독립 위험 검토", duty: "누출 · 과최적화 · 데이터 스누핑 검토", phases: ["risk_review"] },
  { id: "ctEvidenceReviewer", name: "독립 최종 검토", duty: "최종 평가 증거 · 수치 게이트 확인", phases: ["evidence_review"] },
];
/** Runs before 2026-10-13 recorded the shared strategy roles; show them as the CT agent that did that job. */
const LEGACY_ROLE: Record<string, CTAgentId> = {
  orchestrator: "ctOrchestrator",
  dataAnalyst: "ctAnalyst",
  designer: "ctDesigner",
  riskReviewer: "ctRiskReviewer",
  evidenceReviewer: "ctEvidenceReviewer",
};
export function agentIdOf(role: string): CTAgentId {
  return LEGACY_ROLE[role] ?? (CT_AGENTS.some((a) => a.id === role) ? (role as CTAgentId) : "engine");
}
export const agentOf = (id: CTAgentId) => CT_AGENTS.find((a) => a.id === id)!;
const isRole = (id: CTAgentId): id is CTRole => id !== "engine";
/** The model an agent ran (from its last call — legacy runs keep their real models) or will run. */
export function agentModel(id: CTAgentId, call?: CTCall) {
  if (!isRole(id)) return { model: "모델 없음", provider: "로컬 계산" };
  const m = RESEARCH_MODELS[id];
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

/** "return_pct(3분)·volume_ratio" — the features a query measured. */
export function queryFeatures(input: Record<string, unknown>) {
  const query = input.query as { stages?: Array<{ conditions?: Array<{ feature: string; timeframe: number; unit?: string }> }>; entryWindows?: unknown[]; exitCompare?: unknown } | undefined;
  const stages = query?.stages ?? [];
  const names = stages.flatMap((s) => s.conditions ?? []).map((c) => `${c.timeframe > 1 ? `${c.feature}(${c.timeframe}분)` : c.feature}${c.unit === "atr" ? "[ATR]" : ""}`);
  return ([...new Set(names)].join(" · ") || "조건") + (query?.entryWindows?.length ? " · 시간 창" : "") + (query?.exitCompare ? " · 청산 구조 비교" : "");
}
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
    case "read_training_bars": return "무작위 학습 구간의 1분봉을 읽고 있습니다";
    case "cost_hurdle": return "학습 구간에서 비용 장벽 표(보유 시간 · 시간대 · 변동성별 MFE/MAE)를 계산하고 있습니다";
    case "bar_overview": return "학습 구간에서 봉별 개요(고를 수 있는 봉마다 비용 장벽 표와 라벨 기저율, 검정 아님)를 계산하고 있습니다";
    case "query_conditional_returns": return `조건부 수익을 조회하고 있습니다 · ${queryFeatures(i)}`;
    case "read_bars": return `조회 이벤트 주변 학습 1분봉을 읽고 있습니다 · ${((i.request as { anchors?: unknown[] } | undefined)?.anchors?.length ?? 0)}개 시각`;
    case "screen_rule": return `후보 규칙을 학습 구간에서 사전 검사하고 있습니다 · ${((i.spec as { name?: string } | undefined)?.name) ?? "후보"}`;
    case "label_moves": {
      const p = (i.params ?? {}) as { k?: number; m?: number; horizon?: unknown };
      return `거래할 가치가 있던 순간을 찾고 있습니다 · 목표 ${p.k ?? 3}× / 손절 ${p.m ?? 1}× 비용 · 보유 ${p.horizon === "day_end" || p.horizon === undefined ? "당일 끝까지" : `${p.horizon}봉`}`;
    }
    case "contrast_moves": return `이벤트 직전과 대조군의 차이를 재고 있습니다 · 특징 ${((i.request as { features?: unknown[] } | undefined)?.features?.length ?? 0)}개`;
    case "view_charts": {
      const r = (i.request ?? {}) as { anchors?: unknown[]; blind?: boolean };
      return `차트 ${r.anchors?.length ?? 0}장을 그리고 있습니다${r.blind ? " · 블라인드 세트" : ""}`;
    }
    case "grade_blind": return "블라인드 차트 예측을 채점하고 있습니다";
    case "diagnose_trades": return "학습 구간 거래의 손실 원인(진입 · 청산 · 시간대)을 분해하고 있습니다";
    case "playbook_summary": return "이전 연구의 플레이북(기각된 아이디어와 누적 검정 수)을 불러오고 있습니다";
    case "submit_candidates": return "제출된 후보를 검증하고 있습니다";
    case "compile_strategy": return "후보 규칙을 컴파일하고 실행 가능성을 검사하고 있습니다";
    case "backtest": return `${backtestKind(i.kind)} 백테스트를 실행하고 있습니다`;
    case "failure_diagnosis": return `${trialNo(i.trialId)}의 실패 원인을 진단하고 있습니다`;
    default: return `${t.name} 도구를 실행하고 있습니다`;
  }
}

/** What a model call is doing, as a sentence. Legacy role names read as their CT agent. */
export function callDoing(role: GenerationRole | string, ct: CTResearch, call?: Pick<CTCall, "label">) {
  const session = ct.sessions?.at(-1);
  switch (agentIdOf(role)) {
    case "ctOrchestrator": return "웹을 검색해 공개 차트 매매 접근법을 찾고 있습니다";
    case "ctAnalyst": return "읽은 원문에서 원리와 구현 가정을 추출하고 있습니다";
    case "ctDesigner":
      if (role === "ctDesigner" && session)
        return `${call?.label ?? `설계 세션 ${session.index + 1}`} · ${session.kind === "reflect" ? "측정 결과를 반영해 " : ""}가설을 세우고 학습 구간 측정으로 검증하고 있습니다`;
      return ct.trials.length || ct.phase === "reflect"
        ? "측정된 실패를 보고 후보 규칙을 수정하고 있습니다"
        : "첫 가설과 매매 규칙을 설계하고 있습니다";
    case "ctLessons": return "끝난 연구의 아이디어를 계열 단위 교훈 한 문장씩으로 정리하고 있습니다(수치 없이)";
    case "ctRiskReviewer": return "동결한 규칙의 누출 · 체결 · 과최적화 · 데이터 스누핑 위험을 독립 검토하고 있습니다";
    case "ctEvidenceReviewer": return "최종 평가 증거와 수치 게이트를 독립 검토하고 있습니다";
    default: return `${(RESEARCH_MODELS as Record<string, { label: string }>)[role]?.label ?? role} 모델이 응답하고 있습니다`;
  }
}
/** Session progress line for the designer, e.g. "세션 1/3 · 턴 4/12 · 도구 7/24 · 조회 5". */
export function sessionProgress(ct: CTResearch) {
  const s = ct.sessions?.at(-1);
  if (!s) return null;
  const p = ctSessionPolicy(ct.contract);
  const max = { turns: p.maxTurns, tools: p.maxToolCalls, sessions: p.maxSessions };
  const queries = (ct.queries ?? []).filter((q) => q.session === s.index).length;
  const tests = Object.keys(ct.tests?.signatures ?? {}).length;
  return `세션 ${s.index + 1}/${max.sessions} · 턴 ${s.turns}/${max.turns} · 도구 ${s.toolCalls}/${max.tools} · 조회 ${queries} · 사전 검사 ${s.screens}${p.traderTools ? ` · 차트 ${s.charts ?? 0}/${p.maxCharts}` : ""}${tests ? ` · 가설 검정 ${tests}회` : ""}`;
}

/**
 * What the trader tools found, from numbers the job already holds: labelled events, the strongest
 * contrast lift, charts viewed, the blind-set accuracy and the diagnoses' entry/exit verdict.
 * Null when no trader tool ran (older runs).
 */
export function traderSummary(ct: Pick<CTResearch, "labels" | "contrasts" | "charts" | "blinds" | "diagnoses">) {
  const labels = Object.values(ct.labels ?? {});
  const contrasts = ct.contrasts ?? [];
  const charts = ct.charts ?? [];
  const blinds = Object.values(ct.blinds ?? {});
  const diagnoses = ct.diagnoses ?? [];
  if (!labels.length && !contrasts.length && !charts.length && !blinds.length && !diagnoses.length) return null;
  const top = contrasts.map((c) => c.topLift).filter((x): x is NonNullable<typeof x> => Boolean(x)).sort((a, b) => Math.abs(Math.log(b.lift || 1)) - Math.abs(Math.log(a.lift || 1)))[0] ?? null;
  const graded = blinds.filter((b) => b.graded);
  const last = diagnoses.at(-1);
  return {
    labelSets: labels.length,
    events: labels.reduce((s, l) => s + l.events, 0),
    lastLabel: labels.at(-1) ?? null,
    topLift: top,
    chartsViewed: charts.length,
    blindSets: blinds.length,
    blindAccuracyPct: graded.length ? Math.round((graded.reduce((s, b) => s + b.graded!.correct, 0) / graded.reduce((s, b) => s + b.graded!.total, 0)) * 100) : null,
    blindP: graded.length ? graded.at(-1)!.graded!.pValue : null,
    diagnoses: diagnoses.length,
    lastDiagnosis: last ? { verdict: last.verdict, losersTouched1RPct: last.losersTouched1RPct, losersNeverProfitablePct: last.losersNeverProfitablePct } : null,
  };
}

/** Free-bar contracts hold one-minute data and let the designer choose each rule's bar. */
const barText = (c: CTResearch["contract"]) => (ctSessionPolicy(c).freeBars ? "1분 데이터 · 봉 주기는 설계자 선택" : `${c.minutes}분봉`);
/** Concrete context for the current phase, built from counts the job already has. */
export function phaseContext(ct: CTResearch) {
  const c = ct.contract;
  const next = Math.min((ct.submitted ?? ct.trials.length) + 1, c.policy.maxCandidates);
  switch (ct.phase) {
    case "data": return `${c.symbols.join(", ")} · ${barText(c)} · 학습/개발/최종 구간 고정`;
    case "sources": return `${c.symbols.join(", ")} · ${barText(c)} 관점으로 원문 2–6건 선정`;
    case "read": return `선정 URL ${ct.search?.urls.length ?? 0}건 중 ${ct.sources.length}건 읽음`;
    case "approaches": return `확인된 원문 ${ct.sources.length}건 · 원문에 실제 있는 인용만 허용`;
    case "design":
    case "reflect":
      return sessionProgress(ct) ??
        (ct.phase === "design"
          ? `후보 ${next}/${c.policy.maxCandidates} · 출처 ${ct.sources.length}건${ct.sourceNote ? " · 출처 없이 데이터로 설계" : ""} · 학습 구간 측정 도구만 사용`
          : `후보 ${next}/${c.policy.maxCandidates} · 이전 후보 ${ct.trials.length}개의 측정 실패 반영`);
    case "experiment": return `대기 후보 ${ct.queue?.length ?? 0}개 · 학습 게이트 → 개발 · 비용 2배 · 1봉 지연 · 손절 민감도 · 누적 백테스트 ${ct.backtests}회`;
    case "risk_review": return "규칙 해시 동결 후 독립 모델 검토 · 제공자 장애는 승인으로 대체하지 않음";
    case "final": return "최종 구간을 한 번만 열어 동결 규칙을 평가";
    case "evidence_review": return "독립 최종 검토와 서버 수치 게이트를 모두 통과해야 등록 가능";
    case "done": return ct.endReason ?? "연구 종료";
  }
}

export type CTNow =
  | { kind: "model"; agent: CTAgentId; call: CTCall; since: string; signalAt: string; maxTokens: number }
  | { kind: "tool"; agent: "engine"; trace: CTToolTrace; since: string; signalAt: string }
  | { kind: "retry"; agent: CTAgentId | null; error: string; retryAt: string; failures: number; signalAt: string; truncatedAt?: number; reasoningTokens?: number | null }
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
    return { kind: "model", agent: agentIdOf(call.role), call, since: call.startedAt, signalAt, maxTokens: call.maxOutputTokens ?? researchMaxTokens(call.role) };
  const trace = [...ct.tools].reverse().find((t) => t.status === "started");
  if (trace) return { kind: "tool", agent: "engine", trace, since: trace.at, signalAt };
  if (job.recovery?.retryAt) {
    const failed = calls.at(-1)?.status === "failed" ? calls.at(-1)! : null;
    // The provider's stop reason is authoritative; older calls fall back to "used the whole allowance".
    const cap = failed ? (failed.maxOutputTokens ?? researchMaxTokens(failed.role)) : 0;
    const truncated = failed && (failed.incompleteReason ? failed.incompleteReason === "max_output_tokens" : (failed.usage.output_tokens ?? 0) >= cap);
    return {
      kind: "retry",
      agent: failed ? agentIdOf(failed.role) : phaseAgent(ct.phase),
      ...(truncated ? { truncatedAt: cap, reasoningTokens: failed.reasoningTokens ?? null } : {}),
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
  cacheReadTokens: number;
  outputTokens: number;
  lastAt: string | null;
};
export function ctAgents(job: CTActivityJob, calls: CTCall[], now: CTNow): CTAgentRow[] {
  const { ct } = job;
  return CT_AGENTS.map((a) => {
    const mine = calls.filter((c) => agentIdOf(c.role) === a.id);
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
      inputTokens: mine.reduce((s, c) => s + (c.usage.input_tokens ?? 0) + (c.usage.cache_read_input_tokens ?? 0) + (c.usage.cache_creation_input_tokens ?? 0), 0),
      cacheReadTokens: mine.reduce((s, c) => s + (c.usage.cache_read_input_tokens ?? 0), 0),
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

/**
 * The designer's thinking per model turn, from the session's stored messages (t_session_messages — no separate store).
 * Stage-4 sessions ask for summarized thinking, so the text is there; earlier sessions stored only the signature (the API
 * default shows none), which is reported as an empty text and not guessed.
 * `messages` are the session's rows in order (the first is the user's context message).
 */
export function sessionThinking(messages: Array<{ role: string; content: unknown }>) {
  const out: Array<{ turn: number; text: string; tools: string[]; blocks: number }> = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const blocks = m.content as Array<{ type?: string; thinking?: string; name?: string }>;
    const thinking = blocks.filter((b) => b.type === "thinking");
    out.push({
      turn: out.length + 1,
      text: thinking.map((b) => (b.thinking ?? "").trim()).filter(Boolean).join("\n\n"),
      tools: blocks.filter((b) => b.type === "tool_use").map((b) => b.name ?? ""),
      blocks: thinking.length,
    });
  }
  return out;
}
