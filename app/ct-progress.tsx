"use client";
/**
 * CT 연구 진행 추적. 새 API 없이 이미 폴링하는 job/ct 데이터에서 파생한다.
 *  - LiveStatusBar: 상태, 단계, 경과, 후보, 백테스트, 비용, 러너, 제어 (연구 중에는 sticky)
 *  - PhaseStepper: 11단계 타임라인과 후보 수정 루프 표시, 남은 한도
 *  - ActivityFeed: ct.tools 최신순 타임라인
 *  - LatestTrialCard: 가장 최근 후보 요약
 *  - NowPanel: 지금 일하는 주체(모델 호출 · 서버 도구 · 재시도 대기), 실시간 토큰, 에이전트별 상태
 * "지금"의 판정은 lib/ct-activity.ts의 순수 함수가 한다.
 */
import "./ct.css";
import { memo, useEffect, useRef, useState, type ComponentType } from "react";
import BookMarked from "lucide-react/dist/esm/icons/book-marked";
import BookOpenText from "lucide-react/dist/esm/icons/book-open-text";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Cpu from "lucide-react/dist/esm/icons/cpu";
import Download from "lucide-react/dist/esm/icons/download";
import FileCheck from "lucide-react/dist/esm/icons/file-check";
import Minus from "lucide-react/dist/esm/icons/minus";
import Pause from "lucide-react/dist/esm/icons/pause";
import PencilRuler from "lucide-react/dist/esm/icons/pencil-ruler";
import Play from "lucide-react/dist/esm/icons/play";
import Repeat from "lucide-react/dist/esm/icons/repeat";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw";
import ScanSearch from "lucide-react/dist/esm/icons/scan-search";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import X from "lucide-react/dist/esm/icons/x";
import type { GenerationJob } from "@/lib/strategy-generation-types";
import type { CTResearch, CTToolTrace, CTTrial } from "@/lib/ct-research";
import { ctCostProfileText, ctCostsRoundTripPct } from "@/lib/ct-costs";
import {
  agentIdOf,
  agentOf,
  backtestKind,
  callDoing,
  ctAgents,
  ctNow,
  ctTimeline,
  hostOf,
  phaseContext,
  queryFeatures,
  stalledFor,
  toolDoing,
  type CTAgentId,
  type CTAgentRow,
  type CTCall,
  type CTNow,
} from "@/lib/ct-activity";

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
  design: "학습 구간 측정 도구로 가설을 검증하고 규칙을 설계합니다",
  experiment: "서버 엔진으로 학습·개발·스트레스 실험을 실행합니다",
  reflect: "측정 결과를 반영한 새 설계 세션을 엽니다",
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
    case "design": case "experiment": case "reflect": return ct.trials.length > 0 || Boolean(ct.pending) || Boolean(ct.sessions?.length);
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
export function describeTool(t: CTToolTrace) {
  const i = (t.input ?? {}) as Record<string, unknown>;
  switch (t.name) {
    case "collect_market_data": return `시세 수집 · ${i.symbol ?? ""}`;
    case "inspect_data": return "데이터 스냅샷 확인";
    case "allowed_research_memory": return "이전 연구 기억 조회";
    case "search_public_approaches": {
      const q = Array.isArray(i.queries) ? (i.queries as string[]) : [];
      return `공개 접근법 검색 · 질의 ${q.length}개`;
    }
    case "read_public_source": return `원문 읽기 · ${hostOf(i.url)}`;
    case "read_source_failure": return `원문 읽기 실패 · ${hostOf(i.url)}`;
    case "approach_quote_rejected": return `원문에 없는 인용 제외 · ${(i.sourceIds as unknown[] | undefined)?.length ?? 0}건`;
    case "compile_strategy": {
      const name = ((i.candidate as { spec?: { name?: string } } | undefined)?.spec?.name) ?? "후보";
      return `후보 컴파일 · ${name}`;
    }
    case "backtest": return `백테스트 · ${backtestKind(i.kind)}`;
    case "failure_diagnosis": {
      const n = Number(String(i.trialId ?? "").split(":").at(-1));
      return `실패 진단 · 후보 ${Number.isFinite(n) ? n + 1 : ""}`;
    }
    case "analyze_training": return "학습 구간 통계 분석";
    case "read_training_bars": return `학습 구간 1분봉 열람 · ${(i.windows as unknown[] | undefined)?.length ?? 0}구간`;
    case "cost_hurdle": return "비용 장벽 표 계산 · 학습 구간";
    case "bar_overview": return "봉별 개요 계산 · 학습 구간 · 검정 아님";
    case "query_conditional_returns": return `조건부 수익 조회 · ${queryFeatures(i)}`;
    case "read_bars": return `학습 1분봉 열람 · ${((i.request as { anchors?: unknown[] } | undefined)?.anchors?.length ?? 0)}개 시각`;
    case "screen_rule": return `학습 구간 사전 검사 · ${((i.spec as { name?: string } | undefined)?.name) ?? "후보"}`;
    case "label_moves": return `움직임 라벨 · 목표 ${((i.params as { k?: number } | undefined)?.k ?? 3)}× 비용`;
    case "contrast_moves": return `직전 특징 대조 · ${((i.request as { features?: unknown[] } | undefined)?.features?.length ?? 0)}개 특징`;
    case "view_charts": return `차트 열람 · ${((i.request as { anchors?: unknown[]; blind?: boolean } | undefined)?.anchors?.length ?? 0)}장${(i.request as { blind?: boolean } | undefined)?.blind ? " · 블라인드" : ""}`;
    case "grade_blind": return "블라인드 채점";
    case "diagnose_trades": return "손실 거래 복기";
    case "playbook_summary": return "플레이북 조회";
    case "playbook_record": return "플레이북 기록 실패";
    case "lessons_summary": return "교훈·커버리지 조회";
    case "lessons_record": return t.status === "failed" ? "교훈 증류 실패" : "교훈 증류";
    case "submit_candidates": {
      const n = ((i.submission as { candidates?: unknown[] } | undefined)?.candidates?.length) ?? 0;
      return n ? `후보 제출 · ${n}개` : "후보 0개 제출 · 우위 없음 보고";
    }
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
          <div><dt>후보</dt><dd className="ui-num">{ct.submitted ?? ct.trials.length}/{ct.contract.policy.maxCandidates}</dd></div>
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
      <p className="ui-sub ct-live-profile">
        비용 {ctCostProfileText(ct.contract, ctCostsRoundTripPct(ct.contract.costs))} · 기간 {new Date(ct.contract.fromMs).toISOString().slice(0, 10)}–{new Date(ct.contract.toMs).toISOString().slice(0, 10)} · {ct.contract.symbols.join(", ")}
        {ct.contract.repeat ? ` · 같은 판 ${ct.contract.repeat.n}번째 실행 · 사유: ${ct.contract.repeat.reason}` : ""}
      </p>
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
    { label: "후보", value: `${ct.submitted ?? ct.trials.length} / ${policy.maxCandidates}`, ratio: (ct.submitted ?? ct.trials.length) / policy.maxCandidates },
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
                {state === "done" ? <Check size={12} strokeWidth={2.4} /> : state === "failed" ? "!" : state === "stopped" ? <Minus size={12} strokeWidth={2.4} /> : state === "skipped" ? "·" : <span className="ct-step-num ui-num">{i + 1}</span>}
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
    <li className={`ct-feed-item${fresh ? " is-new" : ""}`} data-kind="tool">
      <div className="ct-feed-inner">
        <details className="ct-feed-details">
          <summary>
            <span className="ct-feed-text"><span className="ct-feed-kind" aria-hidden="true">도구</span>{describeTool(trace)}</span>
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
const CALL_STATUS: Record<CTCall["status"], string> = { started: "응답 중", completed: "완료", failed: "실패", interrupted: "중단" };
const tokens = (n: number) => n.toLocaleString("ko-KR");
function CallItem({ call, now, fresh }: { call: CTCall; now: number; fresh: boolean }) {
  const agent = agentOf(agentIdOf(call.role));
  const live = call.status === "started";
  const tone = live ? "accent" : call.status === "completed" ? undefined : "warn";
  const out = call.usage.output_tokens ?? 0;
  const input = (call.usage.input_tokens ?? 0) + (call.usage.cache_read_input_tokens ?? 0) + (call.usage.cache_creation_input_tokens ?? 0);
  const cached = call.usage.cache_read_input_tokens ?? 0;
  const seconds = Math.max(0, Math.round((Date.parse(call.updatedAt) - Date.parse(call.startedAt)) / 1000));
  return (
    <li className={`ct-feed-item${fresh ? " is-new" : ""}`} data-kind="call">
      <div className="ct-feed-inner">
        <details className="ct-feed-details">
          <summary>
            <span className="ct-feed-text">
              <span className="ct-feed-kind" aria-hidden="true">모델</span>
              {agent?.name ?? call.role}{call.label ? ` · ${call.label}` : ""} · {call.model}
              {out ? <span className="ct-feed-aside ui-num"> · 출력 {tokens(out)}</span> : null}
            </span>
            <time className="ct-feed-time ui-num" dateTime={call.startedAt}>{relativeTime(call.startedAt, now)}</time>
            <span className="ui-badge" data-tone={tone}>{CALL_STATUS[call.status]}</span>
            <ChevronDown size={14} className="ct-feed-chevron" aria-hidden="true" />
          </summary>
          <div className="ct-feed-raw">
            <p className="ct-feed-meta">
              {call.provider} · <code>{call.model}</code> · {agent?.duty} · {new Date(call.startedAt).toLocaleString("ko-KR")} 시작 · {seconds}초
            </p>
            <dl className="ct-feed-usage ui-num">
              <div><dt>입력</dt><dd>{tokens(input)}</dd></div>
              {cached ? <div><dt>캐시 읽기</dt><dd>{tokens(cached)}</dd></div> : null}
              <div><dt>출력</dt><dd>{tokens(out)}</dd></div>
              <div><dt>비용{call.estimated ? " (추정)" : ""}</dt><dd>${call.costUsd.toFixed(4)}</dd></div>
              {call.searchCalls ? <div><dt>웹 검색</dt><dd>{call.searchCalls}회</dd></div> : null}
            </dl>
            {call.error ? <p className="ct-feed-error">{call.error}</p> : null}
            {call.sources?.length ? (
              <ul className="ct-feed-sources">
                {call.sources.map((s) => (
                  <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title || hostOf(s.url)}</a></li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>
      </div>
    </li>
  );
}
type FeedProps = { jobId: string; tools: CTToolTrace[]; calls: CTCall[]; live: boolean; onDownload: (v: unknown, name: string) => void; onError: (m: string) => void };
function FeedBase({ jobId, tools, calls, live, onDownload, onError }: FeedProps) {
  const now = useNow(10_000, live);
  const [shown, setShown] = useState(PAGE);
  const ordered = ctTimeline(tools, calls).reverse();
  // Rows present at mount are history; only rows that arrive while watching animate in.
  const [initial] = useState(() => new Set(ordered.map((e) => e.key)));
  const visible = ordered.slice(0, shown);
  return (
    <section className="ct-feed" aria-label="활동 피드">
      <header className="ui-card-head">
        <h3 className="ui-title">활동 피드</h3>
        <span className="ui-sub ui-num">도구 호출 {tools.length}건 · 모델 호출 {calls.length}건</span>
      </header>
      {ordered.length ? (
        <ol className="ct-feed-list">
          {visible.map((e) =>
            e.kind === "call" ? (
              <CallItem key={e.key} call={e.call} now={now} fresh={!initial.has(e.key)} />
            ) : (
              <ToolItem key={e.key} trace={e.trace} jobId={jobId} now={now} fresh={!initial.has(e.key)} onDownload={onDownload} onError={onError} />
            ),
          )}
        </ol>
      ) : (
        <p className="ui-sub">아직 기록이 없습니다. 첫 단계가 시작되면 도구와 모델 호출이 여기에 쌓입니다.</p>
      )}
      {ordered.length > shown ? (
        <button className="ui-btn sm ghost" onClick={() => setShown((n) => n + 20)}>이전 {Math.min(20, ordered.length - shown)}건 더 보기</button>
      ) : null}
    </section>
  );
}
export const ActivityFeed = memo(FeedBase, (a, b) => {
  const la = a.tools.at(-1), lb = b.tools.at(-1);
  const ca = a.calls.at(-1), cb = b.calls.at(-1);
  return a.jobId === b.jobId && a.live === b.live && a.tools.length === b.tools.length && la?.id === lb?.id && la?.status === lb?.status
    && a.calls.length === b.calls.length && ca?.status === cb?.status && ca?.updatedAt === cb?.updatedAt
    && a.onDownload === b.onDownload && a.onError === b.onError;
});

/* -------------------------------------------------------- LatestTrialCard */

const sign = (n: number) => (n > 0 ? "positive" : n < 0 ? "negative" : "");
const pctText = (n: number, digits = 2) => `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
/** Mean daily net return; results saved before the field existed derive it from daily rows. */
const dayMean = (r: CTTrial["development"]) =>
  r.meanDailyReturnPct ?? (r.daily.length ? r.daily.reduce((s, d) => s + d.returnPct, 0) / r.daily.length : 0);
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
        <div className="ui-metric"><span>개발 일평균 순수익</span><b className={sign(dayMean(dev))}>{pctText(dayMean(dev), 3)}</b><small>학습 {pctText(dayMean(trial.training), 3)} · 기준 0% 초과</small></div>
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

/* --------------------------------------------------------------- NowPanel */

type Icon = ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean | "true" }>;
const AGENT_ICON: Record<CTAgentId, Icon> = {
  engine: Cpu,
  ctOrchestrator: ScanSearch,
  ctAnalyst: BookOpenText,
  ctDesigner: PencilRuler,
  ctLessons: BookMarked,
  ctRiskReviewer: ShieldCheck,
  ctEvidenceReviewer: FileCheck,
};
const AGENT_STATE: Record<CTAgentRow["state"], string> = {
  working: "작업 중",
  retry: "재시도 대기",
  waiting: "준비 중",
  done: "완료",
  failed: "실패",
  idle: "대기",
};
export type CTDriver = "here" | "runner";
const DRIVER: Record<CTDriver, string> = { here: "이 화면이 진행", runner: "백그라운드 러너가 진행" };
const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}초` : `${Math.floor(ms / 60_000)}분`);

function headline(now: CTNow, job: CTJob) {
  const { ct } = job;
  switch (now.kind) {
    case "model": return callDoing(now.call.role, ct, now.call);
    case "tool": return toolDoing(now.trace);
    case "retry": return "일시적 오류 · 같은 단계를 자동으로 다시 시도합니다";
    case "between": return `${CT_PHASES[ct.phase]} 단계를 준비하고 있습니다`;
    case "paused": return "일시정지됨 · 저장된 단계에서 재개할 수 있습니다";
    case "ended":
      return job.status === "completed" ? (ct.passed ? "연구가 끝났습니다 · 검증 통과 전략이 있습니다" : "연구가 끝났습니다 · 통과 전략 없음")
        : job.status === "cancelled" ? "취소된 연구입니다"
        : job.status === "failed" ? "연구가 오류로 멈췄습니다"
        : "연구가 종료되었습니다";
  }
}

function Roster({ agents, job }: { agents: CTAgentRow[]; job: CTJob }) {
  return (
    <ol className="ct-agents" aria-label="연구 에이전트">
      {agents.map((a) => {
        const Icon = AGENT_ICON[a.id];
        const tone = a.state === "working" ? "accent" : a.state === "retry" || a.state === "failed" ? "warn" : a.state === "done" ? "done" : undefined;
        return (
          <li key={a.id} className="ct-agent" data-state={a.state}>
            <span className="ct-agent-icon" aria-hidden="true"><Icon size={15} strokeWidth={1.9} /></span>
            <span className="ct-agent-body">
              <span className="ct-agent-top">
                <b>{a.name}</b>
                <span className="ct-agent-state"><span className="ui-dot" data-tone={tone} aria-hidden="true" />{AGENT_STATE[a.state]}</span>
              </span>
              <span className="ct-agent-duty">{a.duty}</span>
              <span className="ct-agent-stat ui-num">
                {a.id === "engine"
                  ? `도구 ${a.tools}회 · 백테스트 ${job.ct.backtests}회`
                  : a.calls
                    ? `호출 ${a.calls}회 · 출력 ${tokens(a.outputTokens)} · $${a.costUsd.toFixed(3)}`
                    : "아직 호출 없음"}
              </span>
              <code className="ct-agent-model">{a.model}</code>
            </span>
            {a.state === "working" && job.status === "running" ? <span className="ct-step-bar ct-agent-bar" aria-hidden="true" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 지금 누가 무엇을 하고 있는지: 현재 모델 호출(실시간 토큰) 또는 서버 도구, 재시도 대기,
 * 멈춤 감지, 그리고 연구에 참여하는 에이전트별 상태.
 */
export function NowPanel({ job, calls, driver }: { job: CTJob; calls: CTCall[]; driver: CTDriver | null }) {
  const running = job.status === "running";
  const nowMs = useNow(1000, running);
  const now = ctNow(job, calls);
  const stalled = stalledFor(now, nowMs);
  const agents = ctAgents(job, calls, now);
  const actor = now.agent ? agentOf(now.agent) : null;
  const ActorIcon = now.agent ? AGENT_ICON[now.agent] : running ? RotateCw : Check;
  const live = running && !stalled;
  const quiet = nowMs - Date.parse(now.signalAt);
  const title = headline(now, job);
  // Changes only when the work itself changes, so a poll or the clock never re-announces it.
  const workKey = `${now.kind}:${now.kind === "model" ? now.call.id : now.kind === "tool" ? now.trace.id : job.ct.phase}:${job.status}`;
  const retryLeft = now.kind === "retry" ? Date.parse(now.retryAt) - nowMs : 0;
  return (
    <section className="ct-now ui-card" data-kind={now.kind} data-stalled={stalled ? "true" : undefined} aria-labelledby="ct-now-h">
      <header className="ct-now-head">
        <h3 className="ui-label" id="ct-now-h">{running || job.status === "paused" ? "지금 하는 일" : "에이전트 작업 기록"}</h3>
        {running ? (
          <span className="ct-now-signal" data-tone={stalled ? "warn" : undefined}>
            <span className={`ui-dot${live ? " ct-live-dot pulse" : ""}`} data-tone={stalled ? "warn" : "accent"} aria-hidden="true" />
            {stalled ? `${minutes(stalled)}째 새 기록 없음` : `실시간 · 마지막 기록 ${relativeTime(now.signalAt, nowMs)}`}
          </span>
        ) : null}
        {running && driver ? <span className="ct-now-driver">{DRIVER[driver]}</span> : null}
      </header>

      <div className="ct-now-body">
        <span className="ct-now-icon" data-busy={now.kind === "model" || now.kind === "tool" ? "true" : undefined} aria-hidden="true">
          <ActorIcon size={20} strokeWidth={1.8} />
        </span>
        <div className="ct-now-text">
          <p className="ct-now-actor">
            {actor ? <b>{actor.name}</b> : <b>{CT_PHASES[job.ct.phase]}</b>}
            {now.kind === "model" ? <> · <code>{now.call.model}</code> · {now.call.provider}</> : null}
            {now.kind === "tool" ? <> · 로컬 계산 · <code>{now.trace.name}</code></> : null}
            {now.kind === "retry" ? <> · {now.truncatedAt ? "출력 한도 조정 재시도" : `${now.failures}회차 재시도`}</> : null}
          </p>
          {/* key: the sentence cross-fades in when the work changes, never on a mere poll. */}
          <p className="ct-now-title" key={workKey}>{title}</p>
          <p className="ct-now-detail">
            {now.kind === "retry"
              ? now.truncatedAt
                ? `출력 한도 ${tokens(now.truncatedAt)}토큰을 모두 써서 응답이 잘렸습니다${now.reasoningTokens != null ? ` (추론 ${tokens(now.reasoningTokens)}토큰)` : ""} · ${now.error}`
                : now.error
              : now.kind === "ended" ? (job.ct.endReason ?? job.error ?? phaseContext(job.ct)) : now.kind === "paused" ? (job.error ?? job.nextAction ?? phaseContext(job.ct)) : phaseContext(job.ct)}
          </p>
        </div>
        {now.kind === "model" || now.kind === "tool" ? (
          <div className="ct-now-clock">
            <b className="ui-mono">{formatClock(nowMs - Date.parse(now.since))}</b>
            <small>{now.kind === "model" ? "응답 대기" : "실행 중"}</small>
          </div>
        ) : now.kind === "retry" ? (
          <div className="ct-now-clock" data-tone="warn">
            <b className="ui-mono">{retryLeft > 0 ? formatClock(retryLeft) : "—"}</b>
            <small>{retryLeft > 0 ? "재시도까지" : "재시도 시각 지남"}</small>
          </div>
        ) : null}
      </div>
      <span className="ui-sr-only" role="status" aria-live="polite">{running ? `${actor?.name ?? CT_PHASES[job.ct.phase]}: ${title}` : ""}</span>

      {now.kind === "model" ? (() => {
        const out = now.call.usage.output_tokens ?? 0;
        const cached = now.call.usage.cache_read_input_tokens ?? 0;
        const input = (now.call.usage.input_tokens ?? 0) + cached + (now.call.usage.cache_creation_input_tokens ?? 0);
        const ratio = out / now.maxTokens;
        return (
          <dl className="ct-now-usage ui-num">
            <div><dt>입력 토큰{cached ? " · 캐시" : ""}</dt><dd>{tokens(input)}{cached ? <small> / 캐시 {tokens(cached)}</small> : null}</dd></div>
            <div className="ct-now-out" data-tone={ratio >= 0.8 ? "warn" : undefined}>
              <dt>출력 토큰{ratio >= 0.8 ? " · 한도 임박" : ""}</dt>
              <dd>
                <span>{tokens(out)} <small>/ {tokens(now.maxTokens)}</small></span>
                <span className="ui-meter" data-tone={ratio >= 0.8 ? "warn" : undefined} style={{ "--v": Math.min(1, ratio) } as React.CSSProperties} role="img" aria-label={`출력 한도 ${Math.round(ratio * 100)}% 사용`}><i /></span>
              </dd>
            </div>
            <div><dt>이번 호출{now.call.estimated ? " (추정)" : ""}</dt><dd>${now.call.costUsd.toFixed(4)}</dd></div>
            <div><dt>마지막 수신</dt><dd>{out || input ? relativeTime(now.call.updatedAt, nowMs) : "추론 중 · 아직 없음"}</dd></div>
          </dl>
        );
      })() : null}

      {stalled ? (
        <div className="ui-alert" role="status">
          <TriangleAlert size={16} aria-hidden="true" />
          <div>
            <strong>{minutes(quiet)}째 진행 기록이 없습니다</strong>
            <p>
              {now.kind === "model"
                ? "모델 응답이 길어지고 있거나 진행 연결이 끊겼을 수 있습니다. 완료된 응답과 도구 결과는 저장되어 있어 같은 단계에서 이어집니다."
                : driver === "here"
                  ? "이 화면이 3.5초마다 다음 단계를 요청하고 있습니다. 계속 멈춰 있으면 위의 오류 표시나 서버 로그를 확인하세요."
                  : "진행하는 화면이나 러너가 없을 수 있습니다. 저장된 단계에서 이어집니다."}
            </p>
          </div>
        </div>
      ) : null}

      <Roster agents={agents} job={job} />
    </section>
  );
}
