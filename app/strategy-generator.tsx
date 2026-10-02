"use client";

import "./strategy-research.css";
import { SlotResearchResults } from "./slot-research-results";
import { useCallback, useEffect, useRef, useState } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import Check from "lucide-react/dist/esm/icons/check";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle";
import { GENERATION_STAGES, type GenerationJob, type ResearchGoal, type ResearchOption, type ResearchMeter } from "@/lib/strategy-generation-types";
import { researchFailure, uncertainResearchCost } from "@/lib/research-recovery";
import { GENERATION_MODELS } from "@/lib/strategy-generation-models";
import type { ValidationEvidence } from "@/lib/strategy-generation-validation";

type Job = Omit<GenerationJob, "ownerId">;
type Props = { slots: Array<{ id: string; label: string; strategy: unknown | null }>; onRegistered: () => void };
type State = {
  jobs: Job[];
  availability: { ready: boolean; missing: string[] };
  registeredIds: string[];
  inventory: Array<{ symbol: string; interval: string; provider: string; sessions: number; firstDate: string; lastDate: string; bars: number }>;
  error?: string;
};
const GOALS: Array<{ id: ResearchGoal; label: string; description: string }> = [
  { id: "discover", label: "자동 탐색", description: "종목과 시간대부터 알아서" },
  { id: "complement", label: "빈 시간대 보완", description: "현재 전략 구성을 참고해서" },
];
const searchLabels = { data: "자료·시험 구간 동결", design: "에이전트 전략 일괄 설계", reflect: "실측 실패 진단·재설계", search: "학습·개발 반복 탐색", freeze: "최종 후보·결합 규칙 동결", review: "독립 위험 검토", final: "공통 최종 구간 검증", done: "실행 종료", blocked: "데이터·실행 장애" };
const percent = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(2)}%`;
function runLabel(job: Job) {
  if (job.search) return job.status === "completed" ? (job.search.evaluation === "partial" ? "실행 종료 · 일부 슬롯 측정 미완료" : "연구 실행 종료 · 성과 판정 별도") : job.status === "failed" ? "측정 미완료 · 데이터/실행 장애" : job.status === "paused" ? "저장된 연구 일시정지" : `슬롯 연구 · ${searchLabels[job.search.phase]}`;
  if (job.status === "completed" && job.research && !job.research.options.some(o => o.training || o.evidence)) return "연구 종료 · 실측 평가 없음";
  if (job.status === "completed") return job.research ? "연구 완료" : "슬롯 등록 완료";
  if (job.status === "paused") return job.pauseReason === "budget" ? "연구 예산 대기" : job.pauseReason === "interrupted" ? "연구 복구 대기" : "새 데이터 대기";
  if (job.recovery?.retryAt) return "일시적 오류 · 자동 복구 대기";
  if (job.status === "failed") return "연구 중단";
  if (job.status === "cancelled") return "취소된 연구";
  if (job.status === "rejected") return "검증 기준 미달";
  return job.research?.phase === "discovery" ? "종목과 시간대를 찾고 있어요" : GENERATION_STAGES[job.stageIndex]?.label ?? "연구 준비 중";
}
function EvidenceTable({ evidence }: { evidence: ValidationEvidence }) {
  return <div className="lab-table-wrap"><table className="lab-table research-evidence">
    <thead><tr><th scope="col">검증 구간</th><th scope="col">기간</th><th scope="col">거래 수</th><th scope="col">순수익률</th><th scope="col">최대 낙폭</th></tr></thead>
    <tbody>{(["training", "validation", "holdout", "stress", "delayed"] as const).map((key, index) => {
      const slice = evidence[key];
      return <tr key={key}><th scope="row">{["학습", "검증", "최종 미사용", "비용 2배", "진입 1봉 지연"][index]}</th><td>{slice.from}–{slice.to}</td><td>{slice.metrics.totalTrades}</td><td>{percent(slice.metrics.totalReturnPct)}</td><td>{percent(slice.metrics.maxDrawdownPct)}</td></tr>;
    })}</tbody>
  </table></div>;
}
function OptionCard({ option, slotLabel, registered, occupied, canRegister, busy, onRegister }: {
  option: ResearchOption; slotLabel: string; registered: boolean; occupied: boolean; canRegister: boolean; busy: boolean; onRegister: () => void;
}) {
  const metrics = option.evidence?.holdout.metrics;
  const status = registered ? "배정됨" : { queued: "연구 예정", running: "검증 중", passed: "검증 통과", rejected: "채택 보류" }[option.status];
  return <article className={`research-option ${option.status}`}>
    <div className="research-option-top"><span className={`research-badge ${registered ? "passed" : option.status}`}>{option.status === "running" && <LoaderCircle size={12} className="spin" />}{registered && <Check size={12} />}{status}</span><span>{slotLabel}</span></div>
    <h3>{option.selected?.candidate.name ?? option.title}</h3>
    <p className="research-symbols">{option.universe.join(" · ")}{option.selected && <span> / {option.selected.candidate.barInterval ?? "5m"}봉</span>}</p>
    <p className="research-hypothesis">{option.hypothesis}</p>
    {metrics && <><dl className="research-metrics"><div><dt>순수익률</dt><dd>{percent(metrics.totalReturnPct)}</dd></div><div><dt>최대 낙폭</dt><dd>{percent(metrics.maxDrawdownPct)}</dd></div><div><dt>거래 수</dt><dd>{metrics.totalTrades}<small>회</small></dd></div></dl><p className="research-period">최종 미사용 구간 · {option.evidence!.holdout.from}–{option.evidence!.holdout.to}</p></>}
    {!!option.reasons.length && <p className="research-reasons">{option.reasons.join(" · ")}</p>}
    <details className="research-option-detail"><summary>선정 이유와 검증 근거</summary>
      <p>{option.rationale}</p>
      {option.report && <p>{option.report.summary}</p>}
      {option.evidence && <EvidenceTable evidence={option.evidence} />}
      {!!option.selected?.candidate.cautions.length && <ul>{option.selected.candidate.cautions.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      {!option.evidence && <p>{option.status === "queued" || option.status === "running" ? "아직 검증 결과가 없습니다." : "최종 검증에 도달하지 못했습니다."}</p>}
    </details>
    {option.status === "passed" && <div className="research-option-action"><button type="button" disabled={busy || registered || occupied || !canRegister} onClick={onRegister}>{registered ? "슬롯에 배정됨" : occupied ? "이미 사용 중인 시간대" : !canRegister ? "연구 완료 후 배정 가능" : "이 시간대에 배정"}{!registered && !occupied && canRegister && <ArrowRight size={14} />}</button><small>배정 후 모의·실전 실행을 선택합니다.</small></div>}
  </article>;
}

function UsageMeter({ job, streamed }: { job: Job; streamed: ResearchMeter | null }) {
  const saved = job.liveMeter;
  const meter = streamed?.jobId === job.id && (!saved || streamed.call.updatedAt >= saved.call.updatedAt) ? streamed : saved;
  const calls = [...(job.calls ?? [])];
  if (meter) {
    const index = calls.findIndex(call => call.id === meter.call.id);
    if (index < 0) calls.push({ ...meter.call, key: "" });
    else if (calls[index].updatedAt <= meter.call.updatedAt) calls[index] = { ...calls[index], ...meter.call };
  }
  const current = calls.at(-1);
  const active = current?.status === "started" && job.status === "running";
  const totals = calls.reduce((sum, call) => ({
    input: sum.input + (call.usage.input_tokens ?? 0),
    output: sum.output + (call.usage.output_tokens ?? 0),
    cache: sum.cache + (call.usage.cache_creation_input_tokens ?? 0) + (call.usage.cache_read_input_tokens ?? 0),
  }), { input: 0, output: 0, cache: 0 });
  const settled = Math.max(job.costUsd, meter?.costUsd ?? 0);
  const uncertain = Math.max(uncertainResearchCost(calls), meter?.uncertainUsd ?? 0);
  const liveCost = active ? current.costUsd : 0;
  const estimated = calls.some(call => call.estimated);
  return <div className="research-usage" aria-label="실시간 연구 사용량">
    <div className="research-usage-title"><span><i className={active ? "live" : ""} aria-hidden="true" />{active ? "실시간 사용량" : "누적 사용량"}</span><span>{current?.model ?? (job.search ? "로컬 계산 · 모델 호출 없음" : "호출 대기")}{current && ` · ${GENERATION_MODELS[current.role].label}`}</span></div>
    <dl><div><dt>입력 토큰{estimated ? " (추정 포함)" : ""}</dt><dd>{totals.input.toLocaleString("ko-KR")}</dd></div><div><dt>출력 토큰{estimated ? " (추정 포함)" : ""}</dt><dd>{totals.output.toLocaleString("ko-KR")}</dd></div><div><dt>캐시 토큰</dt><dd>{totals.cache.toLocaleString("ko-KR")}</dd></div><div><dt>연구 비용 USD{active ? " (생성 중 포함)" : ""}</dt><dd>${(settled + liveCost).toFixed(5)}<small> / ${job.budgetUsd}</small></dd></div></dl>
    <p>확정 사용량 환산 ${settled.toFixed(5)}{active && ` · 현재 호출 ${current.estimated ? "추정 " : ""}$${liveCost.toFixed(5)}`}{uncertain > 0 && ` · 청구 미확인 한도 예약 $${uncertain.toFixed(5)}`}</p>
    <p>생성 중 토큰·비용은 수신된 응답 기준 추정이며, 완료 시 제공자 사용량으로 정산합니다. 숨겨진 추론은 완료 전 집계되지 않을 수 있습니다. 기존 기록에 없는 과거 토큰은 제외됩니다.</p>
    {current && <p>최근 수신 {new Date(current.updatedAt).toLocaleTimeString("ko-KR")} · {active ? "응답 수신 시 자동 갱신" : "호출 기록 저장됨"}</p>}
  </div>;
}

export function StrategyGenerator({ slots, onRegistered }: Props) {
  const [data, setData] = useState<State | null>(null);
  const [goal, setGoal] = useState<ResearchGoal>("discover");
  const [brief, setBrief] = useState("");
  const [symbols, setSymbols] = useState("");
  const [slot, setSlot] = useState("");
  const [budget, setBudget] = useState(8);
  const [target, setTarget] = useState("");
  const [targetSlots, setTargetSlots] = useState<string[]>([]);
  const [sourceMinutes, setSourceMinutes] = useState(5);
  const [maxPerSlot, setMaxPerSlot] = useState(16);
  const [designMode, setDesignMode] = useState("agent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meter, setMeter] = useState<ResearchMeter | null>(null);
  const loading = useRef(false), retryLoadAt = useRef(0), loadFailures = useRef(0);
  const [progress, setProgress] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const nextAdvanceAt = useRef(0), advanceFailures = useRef(0);
  const advancing = useRef(false), requestId = useRef<string | null>(null), knownCompleted = useRef(new Set<string>());
  const load = useCallback(async () => {
    if (loading.current || Date.now() < retryLoadAt.current) return;
    loading.current = true;
    try {
      const response = await fetch("/api/strategy-generation", { cache: "no-store" });
      const body = await response.json() as State;
      if (!response.ok) throw new Error(body.error ?? "연구 상태를 불러오지 못했습니다.");
      setData(body);
      setLoadError(null);
      loadFailures.current = 0;
      for (const job of body.jobs) if (job.status === "completed" && !knownCompleted.current.has(job.id)) {
        knownCompleted.current.add(job.id);
        onRegistered();
      }
    } catch (cause) {
      retryLoadAt.current = Date.now() + Math.min(30_000, 3000 * 2 ** loadFailures.current++);
      setLoadError(cause instanceof Error ? cause.message : "상태 조회 실패");
    } finally { loading.current = false; }
  }, [onRegistered]);
  useEffect(() => {
    queueMicrotask(() => void load());
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 3000);
    return () => clearInterval(timer);
  }, [load]);
  const active = data?.jobs.find(job => job.status === "running");
  const pending = active ?? data?.jobs.find(job => job.status === "paused");
  const latest = data?.jobs.find(job => job.id === selectedJob) ?? active ?? data?.jobs[0];
  const activeId = active?.id ?? data?.jobs.find(job => job.status === "paused" && job.pauseReason === "data")?.id;
  useEffect(() => {
    if (!activeId) return;
    let disposed = false;
    const advance = async () => {
      if (advancing.current || disposed || Date.now() < nextAdvanceAt.current) return;
      advancing.current = true;
      try {
        const response = await fetch("/api/strategy-generation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "advance", id: activeId }) });
        if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "연구 진행 실패");
        if (!disposed) setError(null);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("진행 응답을 받지 못했습니다.");
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) if (line.trim()) {
            const message = JSON.parse(line);
            if (message.type === "result") {
              advanceFailures.current = 0;
              nextAdvanceAt.current = message.job?.recovery?.retryAt ? Date.parse(message.job.recovery.retryAt) : Date.now() + 1000;
            }
            if (message.type === "usage" && !disposed) setMeter(message.meter);
            if (message.type === "result" && message.job && !disposed) setData(current => current ? { ...current, jobs: current.jobs.map(job => job.id === message.job.id ? message.job : job) } : current);
            if (message.type === "progress" && !disposed) setProgress(message.message);
            if (message.type === "error") throw new Error(message.message);
          }
          if (done) break;
        }
        if (!disposed) await load();
      } catch (cause) {
        nextAdvanceAt.current = Date.now() + Math.min(30_000, 3000 * 2 ** advanceFailures.current++);
        if (!disposed) setError(cause instanceof Error ? cause.message : "연결을 다시 확인하고 있습니다.");
      }
      finally { advancing.current = false; }
    };
    void advance();
    const timer = setInterval(() => void advance(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [activeId, load]);

  const perform = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/strategy-generation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { error?: string; job?: Job };
      if (!response.ok) throw new Error(result.error ?? "요청을 처리하지 못했습니다.");
      if (body.action === "research" && result.job) { requestId.current = null; setSelectedJob(result.job.id); setProgress(""); }
      if (body.action === "resume" || body.action === "resume_budget") { nextAdvanceAt.current = 0; setProgress("저장된 단계에서 재개합니다."); }
      if (body.action === "register") onRegistered();
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "요청 실패"); }
    finally { setBusy(false); }
  };
  const universe = [...new Set(symbols.toUpperCase().split(/[\s,]+/).filter(Boolean))];
  const validSymbols = !symbols.trim() || (universe.length <= 10 && universe.every(symbol => /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)));
  const invalidIdea = goal === "idea" && brief.trim().length < 5;
  const resetRequest = () => { requestId.current = null; };
  const research = latest?.research;
  const phase = latest?.search ? ({data:0,design:1,reflect:2,search:2,freeze:3,review:3,final:3,done:4,blocked:0}[latest.search.phase]) : !latest || research?.phase === "discovery" ? 0 : latest.status === "completed" ? 4 : latest.stageIndex === 0 ? 1 : latest.stageIndex < 5 ? 2 : latest.stageIndex < 8 ? 3 : 4;
  const options = research?.options ?? [];
  return <section className="strategy-generator research-studio" aria-label="전략 연구">
    <header className="research-heading"><div><span className="research-eyebrow">STRATEGY RESEARCH</span><h2>슬롯 목표를 향해 전략을 연구합니다.</h2><p>에이전트가 실행 규칙을 설계하고 보유 데이터로 시험하며, 실패 원인을 반영해 개선합니다.</p></div><span className="research-capital">운용 예산 <strong>$1,000</strong></span></header>
    <form onSubmit={event => { event.preventDefault(); if (busy || pending || !data || !validSymbols || invalidIdea) return; requestId.current ??= crypto.randomUUID(); void perform({ action: "research", goal, brief, designMode, budgetUsd: budget, target: target ? { dailyTargetPct: Number(target), slots: targetSlots.length || (slot ? 1 : slots.filter(s => goal !== "complement" || !s.strategy).length) } : null, sourceMinutes, config: { maxPerSlot }, ...(targetSlots.length ? { slots: targetSlots } : {}), ...(universe.length ? { universe } : {}), ...(slot ? { slot } : {}), requestId: requestId.current }); }}>
      <fieldset className="research-goals" disabled={busy || !!pending}><legend className="sr-only">연구 방향</legend>{GOALS.map(item => <label key={item.id} aria-label={item.label} htmlFor={`research-goal-${item.id}`} className={goal === item.id ? "selected" : ""}><input id={`research-goal-${item.id}`} type="radio" name="research-goal" value={item.id} checked={goal === item.id} onChange={() => { setGoal(item.id); resetRequest(); }} /><span><strong>{item.label}</strong><small>{item.description}</small></span></label>)}</fieldset>
      <label className="research-brief"><span>{goal === "idea" ? "검증할 아이디어" : "반영할 생각이 있나요?"}<small>{goal === "idea" ? "필수" : "선택"}</small></span><textarea value={brief} maxLength={1500} disabled={busy || !!pending} required={goal === "idea"} minLength={goal === "idea" ? 5 : undefined} onChange={event => { setBrief(event.target.value); resetRequest(); }} placeholder={goal === "idea" ? "예: 개장 직후 크게 오른 종목은 잠시 조정한 뒤 다시 오를까?" : "예: 거래가 너무 잦지 않고, 급등을 추격하지 않는 전략이면 좋겠어요."} rows={2} /></label>
      <details className="research-settings"><summary>탐색 범위 직접 설정 <span>{universe.length || slot ? "직접 지정" : "종목·시간대 자동"}</span></summary><div className="research-fields"><label>종목 제한<input value={symbols} disabled={busy || !!pending} onChange={event => { setSymbols(event.target.value); resetRequest(); }} placeholder="비워두면 자동 · 예: AAPL, QQQ" maxLength={170} aria-invalid={!validSymbols} /></label><label>시간대 제한<select value={slot} disabled={busy || !!pending} onChange={event => { setSlot(event.target.value); resetRequest(); }}><option value="">자동으로 탐색</option>{slots.map(item => <option key={item.id} value={item.id}>{item.label}{item.strategy ? " · 기존 전략 있음" : ""}</option>)}</select></label></div>{!validSymbols && <p className="generator-error">올바른 종목코드를 최대 10개까지 입력해 주세요.</p>}<p>지정한 종목 안에서 후보별 종목군을 선택합니다. 기존 전략이 있는 시간대도 비교할 수 있습니다.</p></details>
      <div className="research-fields"><label>설계 방식<select aria-label="설계 방식" value={designMode} disabled={busy || !!pending} onChange={e=>{setDesignMode(e.target.value);resetRequest();}}><option value="agent">에이전트 설계·실측 진단·재설계</option><option value="local">내장 규칙 비교 · 모델 설계 없음</option></select></label><label>저장할 목표<select aria-label="저장할 목표" value={target} disabled={busy || !!pending} onChange={e=>{setTarget(e.target.value);resetRequest();}}><option value="">미선택 · 기존 12개 시나리오 모두 비교</option><option value="1">계좌 일 1%</option><option value="1.5">계좌 일 1.5%</option><option value="2">계좌 일 2%</option></select></label><label>보유 원본 봉<select value={sourceMinutes} disabled={busy || !!pending} onChange={e=>{setSourceMinutes(Number(e.target.value));resetRequest();}}><option value={5}>5분봉 · 개발 연구 (실행 검증 별도)</option><option value={1}>1분봉 · 실행 검증 가능</option></select></label><label>슬롯당 후보 상한<select value={maxPerSlot} disabled={busy || !!pending} onChange={e=>{setMaxPerSlot(Number(e.target.value));resetRequest();}}><option value={8}>8개</option><option value={12}>12개</option><option value={16}>16개</option></select></label></div>
      <fieldset disabled={busy || !!pending} className="research-settings"><legend>대상 슬롯 (미선택 시 가능한 전체 슬롯)</legend>{slots.filter(s=>goal!=="complement"||!s.strategy).map(s=><label key={s.id} style={{display:'inline-flex',gap:6,margin:8}}><input type="checkbox" checked={targetSlots.includes(s.id)} onChange={e=>{setTargetSlots(e.target.checked?[...targetSlots,s.id]:targetSlots.filter(id=>id!==s.id));setSlot("");resetRequest();}}/>{s.label}</label>)}</fieldset>
      <p className="research-caption">목표는 정상 무거래일을 포함한 슬롯 일평균 순수익률입니다. 선택 시 계좌 목표를 대상 슬롯 수로 환산해 저장합니다. 에이전트는 입력한 생각과 학습 자료로 네 계열을 일괄 설계하고, 실측 진단으로 한 차례 재설계합니다. 각 배치의 여러 변형은 로컬 계산으로 비교합니다. 최종 시험 결과는 재설계에 사용하지 않습니다.</p>
      <div className="research-submit"><label>연구 비용 한도<select aria-label="연구 비용 한도" value={budget} disabled={busy || !!pending} onChange={event => { setBudget(Number(event.target.value)); resetRequest(); }}><option value={8}>$8</option><option value={16}>$16</option><option value={24}>$24</option></select></label><span>슬롯당 8–16개 후보 · 네 계열 · 전체 연구 한도</span><button className="research-primary" type="submit" disabled={busy || !!pending || !data || !validSymbols || invalidIdea}>{busy ? "처리 중" : pending ? "연구 진행 중" : "연구 시작"}{busy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}</button></div>
      {data && !data.availability.ready && <p className="research-caption">에이전트 설계와 독립 검토에는 모델 연결이 필요합니다. 연결 오류는 기록을 보존하고 복구 대기로 표시합니다: {data.availability.missing.join(", ")}</p>}
      {!data && !loadError && <p className="research-caption" role="status">연구 환경을 확인하고 있습니다.</p>}
    </form>
    {(error || loadError) && <div className="research-error" role="alert"><p>{error ?? loadError}</p><button type="button" onClick={() => { setError(null); void load(); }}>다시 확인</button></div>}
    {latest && <section className="research-run" aria-label="연구 진행과 결과">
      <header className="research-run-heading"><div><span className="research-eyebrow">{latest.status === "completed" ? "RESULTS" : "RESEARCH LOG"}</span><h3>{runLabel(latest)}</h3></div>{(data?.jobs.length ?? 0) > 1 && <select aria-label="연구 기록" value={latest.id} onChange={event => setSelectedJob(event.target.value)}>{data?.jobs.map(job => <option key={job.id} value={job.id}>{new Date(job.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {runLabel(job)}</option>)}</select>}</header>
      <div className="research-run-meta"><span>연구비 <strong>${latest.costUsd.toFixed(3)}</strong> / ${latest.budgetUsd}</span>{research && <span>{options.filter(option => ["passed", "rejected"].includes(option.status)).length} / {options.length || "—"}개 가설 검토</span>}{(latest.status === "running" || latest.status === "paused") && <button type="button" disabled={busy} onClick={() => void perform({ action: "cancel", id: latest.id })}>연구 취소</button>}</div>
      {latest.search && latest.status === "running" && <button type="button" className="research-secondary" onClick={() => void perform({ action: "pause", id: latest.id })}>연구 일시정지</button>}
      {latest.search && <SlotResearchResults job={latest} />}
      <UsageMeter job={latest} streamed={meter} />
      {latest.status === "running" && <><ol className="research-phases">{(latest.search ? ["자료 동결", "개발 탐색", "규칙 동결", "최종 검증", "결과"] : ["탐색", "자료 확보", "설계", "검증", "결과"]).map((label, index) => <li key={label} className={index === phase ? "current" : index < phase ? "done" : ""} aria-current={index === phase ? "step" : undefined}><span>{index < phase ? <Check size={12} /> : index + 1}</span>{label}</li>)}</ol><p className="research-progress" role="status"><LoaderCircle size={13} className="spin" />{latest.id === activeId ? progress || runLabel(latest) : runLabel(latest)}</p><p className="research-caption">처음 확보하는 과거 데이터는 시간이 걸릴 수 있습니다. 실행 중인 러너가 있으면 탭을 닫아도 이어집니다.</p></>}
      {research?.summary && <p className="research-summary">{research.summary}</p>}
      {research?.discovery && <p className="research-caption">{research.discovery.source} · {research.discovery.asOf} 기준 {research.discovery.candidates.length}종목 탐색</p>}
      {latest.error && <p className="generator-error">{latest.error}</p>}{latest.nextAction && <p className="research-caption">{latest.nextAction}</p>}
      {((latest.status === "paused" && latest.pauseReason === "interrupted") || (latest.status === "failed" && researchFailure(new Error(latest.error ?? "")).recoverable)) && <button type="button" className="research-secondary" disabled={busy || !!active} onClick={() => void perform({ action: "resume", id: latest.id })}>저장된 단계부터 이어서 연구 <ArrowRight size={14} /></button>}
      {latest.status === "paused" && latest.pauseReason === "budget" && <button type="button" className="research-secondary" disabled={busy || !!active} onClick={() => void perform({ action: "resume_budget", id: latest.id })}>예산 $8 추가하고 이어서 연구</button>}
      {research?.phase === "complete" && !options.some(option => option.status === "passed") && <div className="research-no-result"><strong>이번 연구에서 검증을 통과한 전략은 없습니다.</strong><p>아래 후보별 측정 결과와 보류 이유를 확인할 수 있습니다.</p></div>}
      {!!options.length && <><div className="research-options">{options.map(option => <OptionCard key={option.id} option={option} slotLabel={slots.find(item => item.id === option.slot)?.label ?? option.slot} registered={!!option.selected && !!data?.registeredIds?.includes(option.selected.id)} occupied={!!slots.find(item => item.id === option.slot)?.strategy} canRegister={latest.status === "completed"} busy={busy} onRegister={() => void perform({ action: "register", id: latest.id, optionId: option.id })} />)}</div><p className="research-caption">후보별 검증 기간이 다릅니다. 수익률과 함께 거래 수·낙폭·조건을 비교하세요. 과거 성과는 미래 수익을 보장하지 않습니다.</p></>}
      {!research && latest.selected && <div className="research-legacy"><strong>{latest.selected.candidate.name}</strong><p>{latest.report?.summary ?? latest.selected.candidate.hypothesis}</p>{latest.evidence && <EvidenceTable evidence={latest.evidence} />}</div>}
      <details className="research-log"><summary>전체 연구 기록 <span>{latest.events.length}개 기록</span></summary><ol>{latest.events.slice(-80).map((event, index) => <li key={index}><span className={event.state}>{event.state === "done" ? "완료" : event.state === "error" ? "확인" : "시작"}</span><div>{event.detail}{event.role && <small>{event.model ?? GENERATION_MODELS[event.role].model}</small>}</div></li>)}</ol><a href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(latest, null, 2))}`} download={`strategy-research-${latest.id}.json`}>연구 기록 다운로드</a></details>
    </section>}
    {!latest && data && <div className="research-empty-state"><span>01 탐색</span><i aria-hidden="true">→</i><span>02 가설과 검증</span><i aria-hidden="true">→</i><span>03 옵션 비교</span><p>종목을 몰라도 시작할 수 있습니다. 결과를 확인한 뒤 실행할 전략을 고르세요.</p></div>}
    <details className="research-method"><summary>연구 방식과 모델</summary><div className="generator-models">{Object.entries(GENERATION_MODELS).map(([key, model]) => <div key={key}><b>{model.label}</b><span>{model.model}{"effort" in model ? ` · ${model.effort}` : ""}</span><small>100만 토큰 입력 ${model.input} / 출력 ${model.output}</small></div>)}</div><p>새 연구는 보유 데이터로 네 전략 계열과 실패별 수정안을 로컬 비교합니다. 슬롯당 최소 8개·최대 16개, 백테스트 400회·계산 10분을 상한으로 두어 각 슬롯의 탐색 기회를 확보합니다. 최소 탐색 이후 최근 8회에서 0.005%p 초과 개선이 없으면 정체로 종료합니다. 독립 검토는 유망 후보에만 호출하며 전체 예산을 공유합니다. 기존 연구의 모델·비용 예약 기록도 유지됩니다. 검증 기준은 코드로 고정되며 모든 후보가 연구 예산과 검증 기간 이력을 공유합니다. 일시적 오류는 10초·30초 대기 후 재시도하며, Claude 오류가 반복되면 Sonnet 5로 독립 검증합니다. 총 3회 실패 시 기록을 보존하고 일시정지합니다.</p></details>
  </section>;
}
