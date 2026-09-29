import type { GenerationRole } from "./strategy-generation-models.ts";
import type { SurgeCandidate, SurgeCandidateSpec, SurgePlan, SurgePool, SurgeSpec } from "./surge-spec.ts";
import type { SurgeEvidence, SurgeEvidenceSlice } from "./surge-validation.ts";
import type { GenerationReview } from "./strategy-generation-spec.ts";

/**
 * The 급등주 pipeline. Same shape as the 전략 generator's stages — design by one
 * company's model, review by another's, deterministic replay in between — with
 * two differences that come from what this feature is for.
 *
 * 1. **Nothing is asked of the user after the button.** The research period is
 *    fixed in code (`SURGE_WINDOW`), the splits are fixed, and the backtest is
 *    a stage rather than a separate screen, so one click runs design → freeze →
 *    validation → holdout → stress → independent review end to end.
 * 2. **No model runs at trading time.** Every LLM call lives inside these
 *    stages. What ships is a frozen rule the deterministic engine executes, so
 *    a strategy that trades every day for a year costs exactly what it cost to
 *    create it.
 */
export const SURGE_STAGES = [
  { id: "market", label: "전 종목 원주가 · 당일 급등락 후보 추리기", role: null },
  { id: "bars", label: "후보 종목 1분봉 확보 · 당일 사건 복원", role: null },
  { id: "plan", label: "연구 계획", role: "orchestrator" },
  { id: "data_review", label: "급등락 관측 이후 당일 움직임 분석", role: "dataAnalyst" },
  { id: "design", label: "패턴 후보 설계 · 손익비 지정", role: "designer" },
  { id: "risk_review", label: "독립 위험 검증", role: "riskReviewer" },
  { id: "training", label: "학습 구간 실행 · 규칙 동결", role: null },
  { id: "validation", label: "미사용 구간 · 비용 2배 · 진입 지연 실행", role: null },
  { id: "evidence_review", label: "독립 기대값 검증", role: "evidenceReviewer" },
  { id: "report", label: "결과 요약", role: "reporter" },
  { id: "publish", label: "전략 등록", role: null },
] as const;

export type SurgeStage = (typeof SURGE_STAGES)[number]["id"];
export type SurgeStatus = "running" | "paused" | "completed" | "rejected" | "failed" | "cancelled";

/**
 * The research window, chosen here rather than asked of the user.
 *
 * Six months (~125 sessions) is the smallest window that clears the 120-session
 * floor for a 60/20/20 split. It is not longer because the same-day design has
 * to download one-minute bars for every name that could have been a ±10% event
 * that day — dozens a day — at five Massive calls a minute. A year would double
 * a first build already measured in many hours. The cache is account-wide, so
 * later runs over the same months start at the design stage.
 */
export const SURGE_WINDOW = {
  /** Calendar days back from the last complete session. */
  tradingDays: 190,
  capitalUsd: 1000,
  reason: "최근 6개월 · 학습 60% / 검증 20% / 최종 미사용 20%. 기간을 묻지 않고 코드가 고정합니다.",
} as const;

export type SurgeEvent = {
  at: string;
  stage: SurgeStage;
  state: "started" | "done" | "error";
  detail: string;
  role: GenerationRole | null;
};

export type SurgeActivity = {
  id: string;
  at: string;
  stage: SurgeStage;
  attempt: number;
  detail: string;
  kind: "update" | "done" | "error";
};

export type SurgeJob = {
  /** 3 = same-day events timed from the event. Earlier runs are kept for their reports and never resumed. */
  researchVersion?: 2 | 3;
  id: string;
  ownerId: string;
  pool: SurgePool;
  status: SurgeStatus;
  stageIndex: number;
  createdAt: string;
  updatedAt: string;
  /** First and last *trading* date of the research window. */
  from: string;
  to: string;
  capitalUsd: number;
  brief: string;
  costUsd: number;
  /** Legacy stored field, ignored by execution. New runs have no API spend cap. */
  budgetUsd?: number;
  error: string | null;
  events: SurgeEvent[];
  /** Bounded operational log; never model reasoning or simulated progress. */
  activities?: SurgeActivity[];
  attempt?: number;
  pauseReason?: "budget" | "interrupted" | "provider";
  nextAction?: string;
  /** How many times each stage was cut off mid-run (server restart, dropped connection). */
  interruptions?: Partial<Record<SurgeStage, number>>;
  /** Rate-limited or unreachable model provider: retried after `retryAt`, a few times per stage. */
  transientRetries?: Partial<Record<SurgeStage, number>>;
  retryAt?: string;

  /** Corporate actions for the window are fetched once, before any ranking is computed. */
  splitsLoaded?: boolean;
  splitEvents?: number;
  /** Sessions whose all-tickers daily prices still have to be downloaded. */
  marketTasks?: string[];
  marketCursor?: number;
  marketSessions?: number;
  /** Sessions in the window that have an event envelope, in order. */
  sessionDates?: string[];
  /** One one-minute download each: a symbol and the month it is needed in. */
  barTasks?: Array<{ symbol: string; from: string; to: string }>;
  barCursor?: number;
  barsDownloaded?: number;
  /** Symbols whose bars could not be fetched from Massive; their days simply produce no signal. */
  barFailures?: string[];

  dataSummary?: Record<string, unknown>;
  dataNote?: { summary: string; issues: string[] };
  plan?: SurgePlan;
  candidates?: SurgeCandidateSpec[];
  riskReview?: GenerationReview;
  selected?: SurgeSpec;
  training?: SurgeEvidenceSlice;
  trials?: Array<{ name: string; metrics: SurgeEvidenceSlice["metrics"]; expectancy: SurgeEvidenceSlice["expectancy"] }>;
  frozenAt?: string;
  frozenHash?: string;
  evidence?: SurgeEvidence;
  finalReview?: GenerationReview;
  report?: { summary: string; issues: string[] };
  attempts?: Array<{
    attempt: number;
    stage: SurgeStage;
    reasons: string[];
    candidates?: SurgeCandidateSpec[];
    trials?: SurgeJob["trials"];
    riskReview?: GenerationReview;
    evidence?: SurgeEvidence;
    finalReview?: GenerationReview;
  }>;
};

export type SurgeRegistration = {
  id: string;
  runId: string;
  pool: SurgePool;
  spec: SurgeSpec;
  evidence: {
    frozenHash: string | undefined;
    evidence: SurgeEvidence;
    review: GenerationReview;
    report: { summary: string; issues: string[] } | undefined;
  };
  createdAt: number;
};

export function publicSurgeJob(job: SurgeJob) {
  const { ownerId, ...rest } = job;
  void ownerId;
  return rest;
}

export type { SurgeCandidate, SurgePool };
