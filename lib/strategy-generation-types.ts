import type {
  GenerationPlan,
  Candidate,
  GenerationReview,
  StrategySpec,
} from "./strategy-generation-spec.ts";
import type {
  EvidenceSlice,
  ValidationEvidence,
} from "./strategy-generation-validation.ts";
import type { GenerationRole } from "./strategy-generation-models.ts";
import type { SlotId } from "./trade-slots.ts";
import type { AnthropicUsage } from "./llm-usage.ts";
export type ResearchCall = {
  id: string;
  key: string;
  role: GenerationRole;
  model: string;
  provider: "OpenAI" | "Anthropic";
  status: "started" | "completed" | "failed" | "interrupted";
  startedAt: string;
  updatedAt: string;
  usage: AnthropicUsage;
  estimated: boolean;
  costUsd: number;
  reserveUsd: number;
  /** Missing final usage is budgeted at the reserved maximum, never treated as free. */
  uncertainUsd?: number;
  result?: unknown;
  error?: string;
};
export type ResearchMeter = {
  jobId: string;
  call: Omit<ResearchCall, "result" | "key">;
  costUsd: number;
  uncertainUsd: number;
};
export const GENERATION_STAGES = [
  { id: "data", label: "선택 종목 데이터 · 자본 사전 점검", role: null },
  { id: "plan", label: "연구 계획", role: "orchestrator" },
  { id: "data_review", label: "자료 품질 정리", role: "dataAnalyst" },
  { id: "design", label: "전략 후보 설계", role: "designer" },
  { id: "risk_review", label: "독립 위험 검증", role: "riskReviewer" },
  { id: "training", label: "학습 구간 실행 · 규칙 동결", role: null },
  { id: "validation", label: "미사용 구간 · 스트레스 실행", role: null },
  { id: "evidence_review", label: "독립 최종 검증", role: "evidenceReviewer" },
  { id: "report", label: "결과 요약", role: "reporter" },
  { id: "publish", label: "슬롯 등록", role: null },
] as const;
export type GenerationStage = (typeof GENERATION_STAGES)[number]["id"] | "discovery";
export type ResearchGoal = "discover" | "complement" | "idea";
export type ResearchOption = {
  id: string;
  title: string;
  hypothesis: string;
  rationale: string;
  slot: SlotId;
  universe: string[];
  status: "queued" | "running" | "passed" | "rejected";
  reasons: string[];
  selected?: StrategySpec;
  frozenHash?: string;
  riskReview?: GenerationReview;
  finalReview?: GenerationReview;
  evidence?: ValidationEvidence;
  training?: EvidenceSlice;
  report?: { summary: string; issues: string[] };
};
export type StrategyResearch = {
  goal: ResearchGoal;
  phase: "discovery" | "experiments" | "complete";
  /** Immutable calendar boundaries shared by every symbol and experiment. */
  trainingTo: string;
  windows: Array<{ validationFrom: string; validationTo: string; holdoutFrom: string; holdoutTo: string }>;
  consumedWindows: number;
  constraints: { universe?: string[]; slot?: SlotId };
  options: ResearchOption[];
  current: number;
  revisions: number;
  summary?: string;
  discovery?: { asOf: string; source: string; candidates: Array<{ symbol: string; price: number; dollarVolume: number; rangePct: number; cachedSessions: number }> };
};
export type GenerationStatus =
  "running" | "paused" | "completed" | "rejected" | "failed" | "cancelled";
export type GenerationEvent = {
  at: string;
  stage: GenerationStage;
  state: "started" | "done" | "error";
  detail: string;
  role: GenerationRole | null;
  model?: string;
};
export type GenerationJob = {
  search?: import("./slot-research.ts").SlotResearch;
  id: string;
  ownerId: string;
  slot: SlotId;
  status: GenerationStatus;
  stageIndex: number;
  createdAt: string;
  updatedAt: string;
  from: string;
  to: string;
  capitalUsd: number;
  brief: string;
  costUsd: number;
  budgetUsd: number;
  error: string | null;
  events: GenerationEvent[];
  calls?: ResearchCall[];
  liveMeter?: ResearchMeter;
  recovery?: { failures: number; retryAt?: string; message: string };
  research?: StrategyResearch;
  universe?: string[];
  /** New research derives each strategy's resolution from minutes; legacy jobs retain 5m evidence. */
  sourceBarMinutes?: 1 | 5;
  attempt?: number;
  validationWindow?: number;
  researchSessions?: number;
  pauseReason?: "budget" | "data" | "interrupted";
  nextAction?: string;
  attempts?: Array<{
    attempt: number;
    stage: GenerationStage;
    reasons: string[];
    candidates?: Candidate[];
    trials?: GenerationJob["trials"];
    riskReview?: GenerationReview;
    evidence?: ValidationEvidence;
    finalReview?: GenerationReview;
  }>;
  plan?: GenerationPlan;
  dataTasks?: Array<{ symbol: string; from: string; to: string }>;
  dataCursor?: number;
  dataSources?: Array<{
    symbol: string;
    provider: string;
    bars: number;
    from: string;
    to: string;
  }>;
  dataSummary?: Record<string, unknown>;
  dataNote?: { summary: string; issues: string[] };
  candidates?: Candidate[];
  riskReview?: GenerationReview;
  selected?: StrategySpec;
  training?: EvidenceSlice;
  trials?: Array<{ name: string; metrics: EvidenceSlice["metrics"] }>;
  frozenAt?: string;
  frozenHash?: string;
  evidence?: ValidationEvidence;
  finalReview?: GenerationReview;
  report?: { summary: string; issues: string[] };
};
export function publicJob(job: GenerationJob) {
  const { ownerId, ...rest } = job;
  void ownerId;
  return rest;
}
