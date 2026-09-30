"use client";

import "./strategy-research.css";
import { useCallback, useEffect, useRef, useState } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import Check from "lucide-react/dist/esm/icons/check";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle";
import { GENERATION_STAGES, type GenerationJob, type ResearchGoal, type ResearchOption } from "@/lib/strategy-generation-types";
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
  { id: "idea", label: "아이디어 검증", description: "떠오른 가설을 실제 데이터로" },
];
const percent = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(2)}%`;
function runLabel(job: Job) {
  if (job.status === "completed") return job.research ? "연구 완료" : "슬롯 등록 완료";
  if (job.status === "paused") return job.pauseReason === "budget" ? "연구 예산 대기" : "새 데이터 대기";
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

export function StrategyGenerator({ slots, onRegistered }: Props) {
  const [data, setData] = useState<State | null>(null);
  const [goal, setGoal] = useState<ResearchGoal>("discover");
  const [brief, setBrief] = useState("");
  const [symbols, setSymbols] = useState("");
  const [slot, setSlot] = useState("");
  const [budget, setBudget] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const advancing = useRef(false), requestId = useRef<string | null>(null), knownCompleted = useRef(new Set<string>());
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/strategy-generation", { cache: "no-store" });
      const body = await response.json() as State;
      if (!response.ok) throw new Error(body.error ?? "연구 상태를 불러오지 못했습니다.");
      setData(body);
      setLoadError(null);
      for (const job of body.jobs) if (job.status === "completed" && !knownCompleted.current.has(job.id)) {
        knownCompleted.current.add(job.id);
        onRegistered();
      }
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : "상태 조회 실패"); }
  }, [onRegistered]);
  useEffect(() => {
    queueMicrotask(() => void load());
    const timer = setInterval(() => void load(), 5000);
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
      if (advancing.current || disposed) return;
      advancing.current = true;
      try {
        const response = await fetch("/api/strategy-generation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "advance", id: activeId }) });
        if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "연구 진행 실패");
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
            if (message.type === "progress" && !disposed) setProgress(message.message);
            if (message.type === "error") throw new Error(message.message);
          }
          if (done) break;
        }
        if (!disposed) await load();
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : "연결을 다시 확인하고 있습니다."); }
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
  const phase = !latest || research?.phase === "discovery" ? 0 : latest.status === "completed" ? 4 : latest.stageIndex === 0 ? 1 : latest.stageIndex < 5 ? 2 : latest.stageIndex < 8 ? 3 : 4;
  const options = research?.options ?? [];
  return <section className="strategy-generator research-studio" aria-label="전략 연구">
    <header className="research-heading"><div><span className="research-eyebrow">STRATEGY RESEARCH</span><h2>다음 전략을 찾아보세요.</h2><p>종목과 시간대 탐색부터 검증까지. 근거를 갖춘 전략 옵션을 비교하세요.</p></div><span className="research-capital">운용 예산 <strong>$1,000</strong></span></header>
    <form onSubmit={event => { event.preventDefault(); if (busy || pending || !data?.availability.ready || !validSymbols || invalidIdea) return; requestId.current ??= crypto.randomUUID(); void perform({ action: "research", goal, brief, budgetUsd: budget, ...(universe.length ? { universe } : {}), ...(slot ? { slot } : {}), requestId: requestId.current }); }}>
      <fieldset className="research-goals" disabled={busy || !!pending}><legend className="sr-only">연구 방향</legend>{GOALS.map(item => <label key={item.id} aria-label={item.label} htmlFor={`research-goal-${item.id}`} className={goal === item.id ? "selected" : ""}><input id={`research-goal-${item.id}`} type="radio" name="research-goal" value={item.id} checked={goal === item.id} onChange={() => { setGoal(item.id); resetRequest(); }} /><span><strong>{item.label}</strong><small>{item.description}</small></span></label>)}</fieldset>
      <label className="research-brief"><span>{goal === "idea" ? "검증할 아이디어" : "반영할 생각이 있나요?"}<small>{goal === "idea" ? "필수" : "선택"}</small></span><textarea value={brief} maxLength={1500} disabled={busy || !!pending} required={goal === "idea"} minLength={goal === "idea" ? 5 : undefined} onChange={event => { setBrief(event.target.value); resetRequest(); }} placeholder={goal === "idea" ? "예: 개장 직후 크게 오른 종목은 잠시 조정한 뒤 다시 오를까?" : "예: 거래가 너무 잦지 않고, 급등을 추격하지 않는 전략이면 좋겠어요."} rows={2} /></label>
      <details className="research-settings"><summary>탐색 범위 직접 설정 <span>{universe.length || slot ? "직접 지정" : "종목·시간대 자동"}</span></summary><div className="research-fields"><label>종목 제한<input value={symbols} disabled={busy || !!pending} onChange={event => { setSymbols(event.target.value); resetRequest(); }} placeholder="비워두면 자동 · 예: AAPL, QQQ" maxLength={170} aria-invalid={!validSymbols} /></label><label>시간대 제한<select value={slot} disabled={busy || !!pending} onChange={event => { setSlot(event.target.value); resetRequest(); }}><option value="">자동으로 탐색</option>{slots.map(item => <option key={item.id} value={item.id}>{item.label}{item.strategy ? " · 기존 전략 있음" : ""}</option>)}</select></label></div>{!validSymbols && <p className="generator-error">올바른 종목코드를 최대 10개까지 입력해 주세요.</p>}<p>지정한 종목 안에서 후보별 종목군을 선택합니다. 기존 전략이 있는 시간대도 비교할 수 있습니다.</p></details>
      <div className="research-submit"><label>연구 비용 한도<select aria-label="연구 비용 한도" value={budget} disabled={busy || !!pending} onChange={event => { setBudget(Number(event.target.value)); resetRequest(); }}><option value={8}>$8</option><option value={16}>$16</option><option value={24}>$24</option></select></label><span>최대 3개 가설 · 전체 연구가 한도를 공유</span><button className="research-primary" type="submit" disabled={busy || !!pending || !data?.availability.ready || !validSymbols || invalidIdea}>{busy ? "처리 중" : pending ? "연구 진행 중" : "연구 시작"}{busy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}</button></div>
      {data && !data.availability.ready && <p className="generator-error" role="status">연구 모델 연결이 필요합니다: {data.availability.missing.join(", ")}</p>}
      {!data && !loadError && <p className="research-caption" role="status">연구 환경을 확인하고 있습니다.</p>}
    </form>
    {(error || loadError) && <div className="research-error" role="alert"><p>{error ?? loadError}</p><button type="button" onClick={() => { setError(null); void load(); }}>다시 확인</button></div>}
    {latest && <section className="research-run" aria-label="연구 진행과 결과">
      <header className="research-run-heading"><div><span className="research-eyebrow">{latest.status === "completed" ? "RESULTS" : "RESEARCH LOG"}</span><h3>{runLabel(latest)}</h3></div>{(data?.jobs.length ?? 0) > 1 && <select aria-label="연구 기록" value={latest.id} onChange={event => setSelectedJob(event.target.value)}>{data?.jobs.map(job => <option key={job.id} value={job.id}>{new Date(job.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {runLabel(job)}</option>)}</select>}</header>
      <div className="research-run-meta"><span>연구비 <strong>${latest.costUsd.toFixed(3)}</strong> / ${latest.budgetUsd}</span>{research && <span>{options.filter(option => ["passed", "rejected"].includes(option.status)).length} / {options.length || "—"}개 가설 검토</span>}{(latest.status === "running" || latest.status === "paused") && <button type="button" disabled={busy} onClick={() => void perform({ action: "cancel", id: latest.id })}>연구 취소</button>}</div>
      {latest.status === "running" && <><ol className="research-phases">{["탐색", "자료 확보", "설계", "검증", "결과"].map((label, index) => <li key={label} className={index === phase ? "current" : index < phase ? "done" : ""} aria-current={index === phase ? "step" : undefined}><span>{index < phase ? <Check size={12} /> : index + 1}</span>{label}</li>)}</ol><p className="research-progress" role="status"><LoaderCircle size={13} className="spin" />{latest.id === activeId ? progress || runLabel(latest) : runLabel(latest)}</p><p className="research-caption">처음 확보하는 과거 데이터는 시간이 걸릴 수 있습니다. 실행 중인 러너가 있으면 탭을 닫아도 이어집니다.</p></>}
      {research?.summary && <p className="research-summary">{research.summary}</p>}
      {research?.discovery && <p className="research-caption">{research.discovery.source} · {research.discovery.asOf} 기준 {research.discovery.candidates.length}종목 탐색</p>}
      {latest.error && <p className="generator-error">{latest.error}</p>}{latest.nextAction && <p className="research-caption">{latest.nextAction}</p>}
      {latest.status === "paused" && latest.pauseReason === "budget" && <button type="button" className="research-secondary" disabled={busy || !!active} onClick={() => void perform({ action: "resume_budget", id: latest.id })}>예산 $8 추가하고 이어서 연구</button>}
      {research?.phase === "complete" && !options.some(option => option.status === "passed") && <div className="research-no-result"><strong>이번 연구에서 검증을 통과한 전략은 없습니다.</strong><p>아래 후보별 측정 결과와 보류 이유를 확인할 수 있습니다.</p></div>}
      {!!options.length && <><div className="research-options">{options.map(option => <OptionCard key={option.id} option={option} slotLabel={slots.find(item => item.id === option.slot)?.label ?? option.slot} registered={!!option.selected && !!data?.registeredIds?.includes(option.selected.id)} occupied={!!slots.find(item => item.id === option.slot)?.strategy} canRegister={latest.status === "completed"} busy={busy} onRegister={() => void perform({ action: "register", id: latest.id, optionId: option.id })} />)}</div><p className="research-caption">후보별 검증 기간이 다릅니다. 수익률과 함께 거래 수·낙폭·조건을 비교하세요. 과거 성과는 미래 수익을 보장하지 않습니다.</p></>}
      {!research && latest.selected && <div className="research-legacy"><strong>{latest.selected.candidate.name}</strong><p>{latest.report?.summary ?? latest.selected.candidate.hypothesis}</p>{latest.evidence && <EvidenceTable evidence={latest.evidence} />}</div>}
      <details className="research-log"><summary>전체 연구 기록 <span>{latest.events.length}개 기록</span></summary><ol>{latest.events.slice(-80).map((event, index) => <li key={index}><span className={event.state}>{event.state === "done" ? "완료" : event.state === "error" ? "확인" : "시작"}</span><div>{event.detail}{event.role && <small>{GENERATION_MODELS[event.role].model}</small>}</div></li>)}</ol><a href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(latest, null, 2))}`} download={`strategy-research-${latest.id}.json`}>연구 기록 다운로드</a></details>
    </section>}
    {!latest && data && <div className="research-empty-state"><span>01 탐색</span><i aria-hidden="true">→</i><span>02 가설과 검증</span><i aria-hidden="true">→</i><span>03 옵션 비교</span><p>종목을 몰라도 시작할 수 있습니다. 결과를 확인한 뒤 실행할 전략을 고르세요.</p></div>}
    <details className="research-method"><summary>연구 방식과 모델</summary><div className="generator-models">{Object.entries(GENERATION_MODELS).map(([key, model]) => <div key={key}><b>{model.label}</b><span>{model.model}{"effort" in model ? ` · ${model.effort}` : ""}</span><small>100만 토큰 입력 ${model.input} / 출력 ${model.output}</small></div>)}</div><p>가설을 적극적으로 탐색하고, 실제 측정 결과로 비교합니다. 종목·시간대 선택과 설계는 GPT-6.1 Sol, 자료·결과 정리는 GPT-6 Luna, 독립 검증은 Claude Opus가 담당합니다. 검증 기준은 코드로 고정되며 모든 후보가 연구 예산과 검증 기간 이력을 공유합니다.</p></details>
  </section>;
}
