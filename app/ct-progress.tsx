"use client";
/**
 * CT 연구 진행 추적. 새 API 없이 이미 폴링하는 job/ct 데이터에서 파생한다.
 *  - LiveStatusBar: 상태, 단계, 경과, 후보, 백테스트, 비용, 러너, 제어 (연구 중에는 sticky)
 *  - PhaseStepper: 11단계 타임라인과 후보 수정 루프 표시, 남은 한도
 *  - ActivityFeed: ct.tools 최신순 타임라인
 *  - LatestTrialCard: 가장 최근 후보 요약
 */
import { memo, useEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Download from "lucide-react/dist/esm/icons/download";
import Pause from "lucide-react/dist/esm/icons/pause";
import Play from "lucide-react/dist/esm/icons/play";
import Repeat from "lucide-react/dist/esm/icons/repeat";
import X from "lucide-react/dist/esm/icons/x";
import type { GenerationJob } from "@/lib/strategy-generation-types";
import type { CTResearch, CTToolTrace, CTTrial } from "@/lib/ct-research";

export type CTJob = Omit<GenerationJob, "ownerId"> & { ct: CTResearch };
export type CTPhaseId = CTResearch["phase"];

export const CT_PHASES: Record<CTPhaseId, string> = {
  data: "데이터·연구 계약",
  sources: "공개 접근법 검색",
  read: "원문 확인",
  approaches: "원리·구현 가정",
  design: "가설·규칙 설계",
  experiment: "실제 엔진 실험",
  reflect: "실패 진단·수정",
  risk_review: "독립 위험 검토",
  final: "동결 규칙 최종 평가",
  evidence_review: "독립 최종 검토",
  done: "연구 종료",
};
const PHASE_HINT: Record<CTPhaseId, string> = {
  data: "시세 데이터를 확인하고 연구 계약을 고정합니다",
  sources: "공개 자료를 검색해 접근법 후보를 찾습니다",
  read: "검색된 원문을 읽고 본문과 해시를 저장합니다",
  approaches: "원문에서 원리와 가격·거래량 구조를 정리합니다",
  design: "학습 구간 통계로 가설과 규칙을 설계합니다",
  experiment: "서버 엔진으로 학습·개발·스트레스 실험을 실행합니다",
  reflect: "측정된 실패를 진단하고 부모 후보를 수정합니다",
  risk_review: "규칙을 동결하고 독립 모델이 검토합니다",
  final: "최종 구간을 한 번만 열어 동결 규칙을 평가합니다",
  evidence_review: "독립 최종 검토와 서버 수치 게이트를 확인합니다",
  done: "연구가 종료되었습니다",
};
export const PHASE_IDS = Object.keys(CT_PHASES) as CTPhaseId[];
const LOOP: ReadonlySet<CTPhaseId> = new Set(["design", "experiment", "reflect"]);

export const STATUS_LABEL: Record<string, string> = {
  running: "실행 중",
  paused: "일시정지",
  completed: "완료",
  rejected: "종료",
  failed: "오류",
  cancelled: "취소됨",
};
export type StatusTone = "accent" | "warn" | "danger" | "done" | "idle";
export function statusTone(status: string): StatusTone {
  if (status === "running") return "accent";
  if (status === "paused") return "warn";
  if (status === "failed") return "danger";
  if (status === "completed" || status === "rejected") return "done";
  return "idle";
}
export const isLive = (status: string) => status === "running" || status === "paused";

/* ---------------------------------------------------------------- helpers */

function useNow(intervalMs: number, enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}
export function formatClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
export function relativeTime(iso: string, now: number) {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 10) return "방금";
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`;

export type StepState = "done" | "active" | "pending" | "failed" | "stopped" | "skipped";
function reached(phase: CTPhaseId, ct: CTResearch) {
  switch (phase) {
    case "sources": return Boolean(ct.search) || ct.sources.length > 0;
    case "read": return ct.sources.length > 0;
    case "approaches": return Boolean(ct.approaches?.length);
    case "design": case "experiment": case "reflect": return ct.trials.length > 0 || Boolean(ct.pending);
    case "risk_review": return Boolean(ct.riskReview) || Boolean(ct.frozenHash);
    case "final": return Boolean(ct.final) || Boolean(ct.finalConsumed);
    case "evidence_review": return Boolean(ct.finalReview);
    default: return true;
  }
}
export function deriveSteps(job: CTJob) {
  const { ct } = job;
  const cur = PHASE_IDS.indexOf(ct.phase);
  return PHASE_IDS.map((id, i): { id: CTPhaseId; state: StepState } => {
    if (ct.phase === "done") return { id, state: id === "done" ? "done" : reached(id, ct) ? "done" : "skipped" };
    if (i < cur) return { id, state: "done" };
    if (i > cur) return { id, state: "pending" };
    if (job.status === "failed") return { id, state: "failed" };
    if (job.status === "cancelled") return { id, state: "stopped" };
    return { id, state: "active" };
  });
}
export const revisionCount = (ct: CTResearch) => ct.trials.filter((t) => t.parentId).length;

/** Plain-language one-liner for a raw tool trace. */
const BACKTEST_KIND: Record<string, string> = {
  training: "학습 구간",
  development: "개발 구간",
  development_stress: "개발 · 비용 2배",
  development_delay: "개발 · 진입 1봉 지연",
  "sensitivity_0.9": "민감도 · 손절 ×0.9",
  "sensitivity_1.1": "민감도 · 손절 ×1.1",
  final: "최종 구간",
  final_stress: "최종 · 비용 2배",
  final_delay: "최종 · 진입 1봉 지연",
};
const host = (u: unknown) => {
  try { return new URL(String(u)).hostname.replace(/^www\./, ""); } catch { return String(u ?? ""); }
};
export function describeTool(t: CTToolTrace) {
  const i = (t.input ?? {}) as Record<string, unknown>;
  switch (t.name) {
    case "collect_market_data": return `시세 수집 · ${i.symbol ?? ""}`;
    case "allowed_research_memory": return "이전 연구 기억 조회";
    case "search_public_approaches": {
      const q = Array.isArray(i.queries) ? (i.queries as string[]) : [];
      return `공개 접근법 검색 · 질의 ${q.length}개`;
    }
    case "read_public_source": return `원문 읽기 · ${host(i.url)}`;
    case "read_source_failure": return `원문 읽기 실패 · ${host(i.url)}`;
    case "compile_strategy": {
      const name = ((i.candidate as { spec?: { name?: string } } | undefined)?.spec?.name) ?? "후보";
      return `후보 컴파일 · ${name}`;
    }
    case "backtest": return `백테스트 · ${BACKTEST_KIND[String(i.kind)] ?? String(i.kind ?? "")}`;
    case "failure_diagnosis": {
      const n = Number(String(i.trialId ?? "").split(":").at(-1));
      return `실패 진단 · 후보 ${Number.isFinite(n) ? n + 1 : ""}`;
    }
    case "analyze_training": return "학습 구간 통계 분석";
    default: return t.name;
  }
}

/* --------------------------------------------------------- LiveStatusBar */

type StatusProps = {
  job: CTJob;
  runnerOnline: boolean;
  busy: boolean;
  onAct: (action: "pause" | "resume" | "cancel") => void;
};
export function LiveStatusBar({ job, runnerOnline, busy, onAct }: StatusProps) {
  const { ct } = job;
  const live = isLive(job.status);
  const now = useNow(1000, job.status === "running");
  const end = job.status === "running" ? now : Date.parse(job.updatedAt);
  const elapsed = end - Date.parse(job.createdAt);
  const stepIndex = PHASE_IDS.indexOf(ct.phase) + 1;
  const total = PHASE_IDS.length;
  const costRatio = job.budgetUsd > 0 ? job.costUsd / job.budgetUsd : 0;
  const costWarn = costRatio >= 0.8;
  const tone = statusTone(job.status);
  const announce = `${STATUS_LABEL[job.status] ?? job.status}, ${total}단계 중 ${stepIndex}단계 ${CT_PHASES[ct.phase]}`;
  return (
    <div className={`ct-live${live ? " is-live" : ""}`} data-status={job.status}>
      <div className="ct-live-main">
        <div className="ct-live-state">
          <span className={`ui-dot ct-live-dot${job.status === "running" ? " pulse" : ""}`} data-tone={tone === "idle" ? undefined : tone} aria-hidden="true" />
          <div className="ct-live-title">
            <strong>{CT_PHASES[ct.phase]}</strong>
            <span>
              <b className="ui-num">{stepIndex}/{total}</b> · {STATUS_LABEL[job.status] ?? job.status}
            </span>
          </div>
        </div>
        <dl className="ct-live-stats">
          <div><dt>경과</dt><dd className="ui-mono">{formatClock(elapsed)}</dd></div>
          <div><dt>후보</dt><dd className="ui-num">{ct.trials.length}/{ct.contract.policy.maxCandidates}</dd></div>
          <div><dt>백테스트</dt><dd className="ui-num">{ct.backtests}회</dd></div>
          <div className="ct-live-cost" data-tone={costWarn ? "warn" : undefined}>
            <dt>비용{costWarn ? " · 예산 임박" : ""}</dt>
            <dd>
              <span className="ui-num">{usd(job.costUsd)} <small>/ {usd(job.budgetUsd)}</small></span>
              <span className="ui-meter" data-tone={costWarn ? "warn" : undefined} style={{ "--v": Math.min(1, costRatio) } as React.CSSProperties} role="img" aria-label={`예산 ${Math.round(costRatio * 100)}% 사용`}><i /></span>
            </dd>
          </div>
          <div><dt>러너</dt><dd className="ct-live-runner" data-online={runnerOnline}><span className="ui-dot" data-tone={runnerOnline ? "done" : "warn"} aria-hidden="true" />{runnerOnline ? "온라인" : "오프라인"}</dd></div>
        </dl>
        <div className="ct-live-actions">
          {job.status === "running" ? (
            <button className="ui-btn sm" disabled={busy} onClick={() => onAct("pause")}><Pause size={13} aria-hidden="true" />일시정지</button>
          ) : null}
          {job.status === "paused" ? (
            <button className="ui-btn sm primary" title="저장된 단계부터 재개" disabled={busy} onClick={() => onAct("resume")}><Play size={13} aria-hidden="true" />재개</button>
          ) : null}
          {live ? (
            <button className="ui-btn sm ghost" disabled={busy} onClick={() => onAct("cancel")}><X size={13} aria-hidden="true" />취소</button>
          ) : null}
        </div>
      </div>
      {live ? <div className="ct-live-rail" role="progressbar" aria-label="연구 단계 진행" aria-valuemin={1} aria-valuemax={total} aria-valuenow={stepIndex} aria-valuetext={announce}>
        <i style={{ "--v": stepIndex / total } as React.CSSProperties} data-tone={tone === "idle" ? undefined : tone} />
      </div> : null}
      {/* The text only changes when the phase or status changes, so polling never re-announces. */}
      <span className="ui-sr-only" aria-live="polite" role="status">{announce}</span>
    </div>
  );
}

/* ----------------------------------------------------------- PhaseStepper */

export function PhaseStepper({ job }: { job: CTJob }) {
  const { ct } = job;
  const steps = deriveSteps(job);
  const policy = ct.contract.policy;
  const rev = revisionCount(ct);
  const list = useRef<HTMLOListElement>(null);
  // On narrow screens the stepper scrolls sideways; keep the active step centered when the phase changes.
  useEffect(() => {
    const ol = list.current;
    const el = ol?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!ol || !el || ol.scrollWidth <= ol.clientWidth) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ol.scrollTo({ left: el.offsetLeft - (ol.clientWidth - el.offsetWidth) / 2, behavior: calm ? "auto" : "smooth" });
  }, [ct.phase]);
  const activeLeft = Math.max(0, policy.maxActiveMs - ct.activeMs);
  const limits = [
    { label: "비용", value: `${usd(job.costUsd)} / ${usd(job.budgetUsd)}`, ratio: job.costUsd / (job.budgetUsd || 1) },
    { label: "후보", value: `${ct.trials.length} / ${policy.maxCandidates}`, ratio: ct.trials.length / policy.maxCandidates },
    { label: "활성 시간", value: `${formatClock(ct.activeMs)} / ${formatClock(policy.maxActiveMs)}`, ratio: ct.activeMs / policy.maxActiveMs },
  ];
  return (
    <div className="ct-stepper-wrap">
      <ol className="ct-stepper" aria-label="연구 단계" ref={list}>
        {steps.map(({ id, state }, i) => {
          const inLoop = LOOP.has(id);
          const first = inLoop && id === "design";
          return (
            <li key={id} className="ct-step" data-state={state} data-loop={inLoop || undefined} data-loop-first={first || undefined} aria-current={state === "active" ? "step" : undefined}>
              <span className="ct-step-mark" aria-hidden="true">
                {state === "done" ? <Check size={12} strokeWidth={2.4} /> : state === "failed" ? "!" : state === "stopped" ? "–" : state === "skipped" ? "·" : <span className="ct-step-num ui-num">{i + 1}</span>}
              </span>
              <span className="ct-step-body">
                <span className="ct-step-name">{CT_PHASES[id]}</span>
                {state === "active" ? <span className="ct-step-hint">{PHASE_HINT[id]}</span> : null}
                {state === "skipped" ? <span className="ct-step-hint">{ct.passed ? "해당 없음" : "통과 후보가 없어 실행하지 않음"}</span> : null}
                {state === "active" && job.status === "running" ? <span className="ct-step-bar" aria-hidden="true" /> : null}
                {first && ct.trials.length > 0 ? (
                  <span className="ct-step-loop"><Repeat size={11} aria-hidden="true" />후보 {ct.trials.length} · 수정 {rev}회차</span>
                ) : null}
              </span>
              <span className="ct-sr-state ui-sr-only">{{ done: "완료", active: "진행 중", pending: "대기", failed: "실패", stopped: "중단", skipped: "건너뜀" }[state]}</span>
            </li>
          );
        })}
      </ol>
      <div className="ct-limits" role="group" aria-label="한도 사용량">
        <span className="ui-label">한도 사용량</span>
        {limits.map((l) => (
          <div className="ct-limit" key={l.label}>
            <span>{l.label}</span>
            <b className="ui-num">{l.value}</b>
            <span className="ui-meter" data-tone={l.ratio >= 0.8 ? "warn" : undefined} style={{ "--v": Math.min(1, l.ratio) } as React.CSSProperties}><i /></span>
          </div>
        ))}
        {job.status === "running" ? <p className="ct-limits-note">활성 시간 한도까지 약 {formatClock(activeLeft)} 남음</p> : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- ActivityFeed */

const PAGE = 12;
function ToolItem({ trace, jobId, now, fresh, onDownload, onError }: { trace: CTToolTrace; jobId: string; now: number; fresh: boolean; onDownload: (v: unknown, name: string) => void; onError: (m: string) => void }) {
  const bad = trace.status === "failed" || Boolean(trace.error);
  const tone = trace.status === "started" ? "accent" : bad ? "warn" : undefined;
  const label = trace.status === "started" ? "실행 중" : trace.status === "failed" ? "실패" : trace.error ? "경고" : "완료";
  return (
    <li className={`ct-feed-item${fresh ? " is-new" : ""}`}>
      <div className="ct-feed-inner">
        <details className="ct-feed-details">
          <summary>
            <span className="ct-feed-text">{describeTool(trace)}</span>
            <time className="ct-feed-time ui-num" dateTime={trace.at}>{relativeTime(trace.at, now)}</time>
            <span className="ui-badge" data-tone={tone}>{label}</span>
            <ChevronDown size={14} className="ct-feed-chevron" aria-hidden="true" />
          </summary>
          <div className="ct-feed-raw">
            <p className="ct-feed-meta"><code>{trace.name}</code> · {new Date(trace.at).toLocaleString("ko-KR")}</p>
            {trace.status === "completed" ? (
              <button
                className="ui-btn sm"
                onClick={() =>
                  void fetch(`/api/invest/ct?id=${encodeURIComponent(jobId)}&artifact=${trace.id}`)
                    .then(async (r) => {
                      const p = (await r.json()) as { error?: string };
                      if (!r.ok) throw new Error(p.error);
                      onDownload(p, `ct-tool-${trace.id}.json`);
                    })
                    .catch((e) => onError(String(e)))
                }
              >
                <Download size={13} aria-hidden="true" />도구 결과·전체 거래 다운로드
              </button>
            ) : null}
            <pre>{JSON.stringify({ input: trace.input, output: trace.output, error: trace.error }, null, 2)}</pre>
          </div>
        </details>
      </div>
    </li>
  );
}
type FeedProps = { jobId: string; tools: CTToolTrace[]; modelCalls: number; live: boolean; onDownload: (v: unknown, name: string) => void; onError: (m: string) => void };
function FeedBase({ jobId, tools, modelCalls, live, onDownload, onError }: FeedProps) {
  const now = useNow(10_000, live);
  const [shown, setShown] = useState(PAGE);
  const [initial] = useState(tools.length);
  const ordered = tools.map((t, i) => ({ t, i })).reverse();
  const visible = ordered.slice(0, shown);
  return (
    <section className="ct-feed" aria-label="활동 피드">
      <header className="ui-card-head">
        <h3 className="ui-title">활동 피드</h3>
        <span className="ui-sub ui-num">도구 호출 {tools.length}건 · 모델 호출 {modelCalls}건</span>
      </header>
      {tools.length ? (
        <ol className="ct-feed-list">
          {visible.map(({ t, i }) => (
            <ToolItem key={`${t.id}:${i}`} trace={t} jobId={jobId} now={now} fresh={i >= initial} onDownload={onDownload} onError={onError} />
          ))}
        </ol>
      ) : (
        <p className="ui-sub">아직 도구 호출이 없습니다. 첫 단계가 시작되면 여기에 기록됩니다.</p>
      )}
      {ordered.length > shown ? (
        <button className="ui-btn sm ghost" onClick={() => setShown((n) => n + 20)}>이전 {Math.min(20, ordered.length - shown)}건 더 보기</button>
      ) : null}
    </section>
  );
}
export const ActivityFeed = memo(FeedBase, (a, b) => {
  const la = a.tools.at(-1), lb = b.tools.at(-1);
  return a.jobId === b.jobId && a.live === b.live && a.modelCalls === b.modelCalls && a.tools.length === b.tools.length && la?.id === lb?.id && la?.status === lb?.status && a.onDownload === b.onDownload && a.onError === b.onError;
});

/* -------------------------------------------------------- LatestTrialCard */

const sign = (n: number) => (n > 0 ? "positive" : n < 0 ? "negative" : "");
const pctText = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
export function trialPassed(t: CTTrial) {
  return t.reasons.length === 0;
}
function LatestBase({ trial, index, total }: { trial: CTTrial | undefined; index: number; total: number }) {
  if (!trial) {
    return (
      <section className="ct-latest ui-card pad" aria-label="최신 후보">
        <h3 className="ui-title">최신 후보</h3>
        <p className="ui-sub">아직 후보가 없습니다. 데이터와 출처를 확인한 뒤 모델이 후보를 설계합니다.</p>
      </section>
    );
  }
  const dev = trial.development;
  const pass = trialPassed(trial);
  return (
    <section className="ct-latest ui-card pad" aria-label="최신 후보">
      <header className="ui-card-head">
        <div className="ct-latest-id">
          <span className="ui-label">후보 {index}/{total}</span>
          <h3 className="ui-title">{trial.spec.name}</h3>
        </div>
        <span className="ui-badge" data-tone={pass ? "accent" : undefined}>{pass ? "개발 기준 통과" : "검증 미달"}</span>
      </header>
      <div className="ui-metrics">
        <div className="ui-metric"><span>개발 순수익</span><b className={sign(dev.netReturnPct)}>{pctText(dev.netReturnPct)}</b><small>학습 {pctText(trial.training.netReturnPct)}</small></div>
        <div className="ui-metric"><span>거래 수</span><b>{dev.tradeCount ?? dev.trades.length}</b><small>무거래 {dev.emptyDays}일</small></div>
        <div className="ui-metric"><span>최대 낙폭</span><b>{dev.maxDrawdownPct.toFixed(2)}%</b><small>기준 15% 이내</small></div>
        <div className="ui-metric"><span>승률</span><b>{dev.winRatePct.toFixed(1)}%</b><small>손익비 {dev.payoff.toFixed(2)}</small></div>
      </div>
      {trial.reasons.length ? (
        <ul className="ct-reasons" aria-label="미달 사유">
          {trial.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      ) : (
        <p className="ui-sub">서버 개발 기준을 충족했습니다. 독립 검토와 최종 평가는 별도입니다.</p>
      )}
    </section>
  );
}
export const LatestTrialCard = memo(LatestBase, (a, b) => a.trial?.id === b.trial?.id && a.index === b.index && a.total === b.total);
