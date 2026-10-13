import { z } from "zod";
import { ctSpecSchema, type CTContract, type CTSpec } from "./ct-spec.ts";
import { ctSummary, type CTResult } from "./ct-engine.ts";
import type { GenerationReview } from "./strategy-generation-spec.ts";
export const ctRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    market: z.enum(["stock", "crypto"]).default("stock"),
    brief: z.string().max(1500).default(""),
    symbols: z.array(z.string().max(20)).min(1).max(4).optional(),
    // Research is fixed to 1-minute bars; the field stays only to reject other values clearly.
    minutes: z.literal(1).optional(),
    budgetUsd: z.union([z.literal(8), z.literal(16), z.literal(24)]).default(8),
    capital: z.number().positive().max(100000000).optional(),
    days: z.number().int().min(90).max(365).default(180),
  })
  .strict();
export const ctSearchSchema = z
  .object({
    queries: z.array(z.string().max(300)).min(1).max(3),
    urls: z.array(z.string()).min(1).max(6),
    rationale: z.string().max(1800),
  })
  .strict();
export const ctApproachSchema = z
  .object({
    approaches: z
      .array(
        z.object({
          sourceId: z.string(),
          trader: z.string().max(120),
          principle: z.string().max(1500),
          quote: z.string().min(20).max(300),
          structure: z.string().max(1000),
          regime: z.string().max(600),
          approximation: z.string().max(1000),
          discretionary: z.string().max(1000),
          publishedAt: z.string().nullable(),
        }),
      )
      .min(1)
      .max(6),
  })
  .strict();
export const ctCandidateSchema = z
  .object({
    spec: ctSpecSchema,
    hypothesis: z.object({
      phenomenon: z.string().min(10).max(1500),
      mechanism: z.string().min(10).max(1500),
      falsification: z.string().min(10).max(1000),
      failureRegimes: z.array(z.string()).min(1).max(6),
    }),
    mapping: z
      .array(
        z.object({
          stage: z.number().int().min(0).max(3),
          condition: z.number().int().min(0).max(5),
          feature: z.string(),
          sourceId: z.string(),
          implementationAssumption: z.string().min(5).max(500),
        }),
      )
      .min(1)
      .max(24),
    parentId: z.string().nullable(),
    observedProblem: z.string().max(1500),
    changes: z.array(z.string()).max(10),
    expectedEffect: z.string().max(1000),
    memoryIds: z.array(z.string()).max(12),
  })
  .strict();
export type CTCandidate = z.infer<typeof ctCandidateSchema>;
export type CTSource = {
  id: string;
  url: string;
  title: string;
  fetchedAt: string;
  hash: string;
  text: string;
  publishedAt: string | null;
};
export type CTTrial = CTCandidate & {
  id: string;
  hash: string;
  at: string;
  training: CTResult;
  development: CTResult;
  stress: CTResult;
  delayed: CTResult;
  sensitivity: Array<{
    change: string;
    result: ReturnType<typeof import("./ct-engine.ts").ctSummary>;
  }>;
  reasons: string[];
};
export type CTToolTrace = {
  id: string;
  name: string;
  at: string;
  status: "started" | "completed" | "failed";
  input: unknown;
  output?: unknown;
  error?: string;
};
export type CTResearch = {
  version: 1;
  phase:
    | "data"
    | "sources"
    | "read"
    | "approaches"
    | "design"
    | "experiment"
    | "reflect"
    | "risk_review"
    | "final"
    | "evidence_review"
    | "done";
  contract: CTContract;
  dataProvider?: "massive-unadjusted-1m";
  dataCursor: { symbol: number; before: number; pages: number };
  dataHash?: string;
  inventory?: Record<string, unknown>;
  search?: z.infer<typeof ctSearchSchema>;
  sources: CTSource[];
  approaches?: z.infer<typeof ctApproachSchema>["approaches"];
  pending?: CTCandidate;
  trials: CTTrial[];
  tools: CTToolTrace[];
  memory: Array<{
    id: string;
    market: string;
    dataHash: string;
    developmentToMs: number;
    rules: CTSpec;
    diagnostics: string[];
    netReturnPct: number;
  }>;
  selectedId?: string;
  frozenHash?: string;
  frozenAt?: string;
  riskReview?: GenerationReview;
  finalReview?: GenerationReview;
  final?: CTResult;
  finalStress?: CTResult;
  finalDelayed?: CTResult;
  finalConsumed?: boolean;
  passed?: boolean;
  endReason?: string;
  computeMs: number;
  activeMs: number;
  backtests: number;
  duplicateCount: number;
};
const daily = (r: CTResult) => {
  const s = ctSummary(r);
  return {
    meanDailyReturnPct: s.meanDailyReturnPct,
    positiveDayPct: s.positiveDayPct,
    worstDayPct: s.worstDayPct,
  };
};
export function ctDesignContext(
  ct: CTResearch,
  brief: string,
  statistics: unknown,
  minuteBars: unknown = [],
) {
  // Allowlist only. Do not spread CT state: final data/results never enter author input.
  return {
    contract: ct.contract,
    brief,
    statistics,
    minuteBars,
    sources: ct.sources.map((s) => ({
      id: s.id,
      url: s.url,
      title: s.title,
      text: s.text.slice(0, 12000),
      fetchedAt: s.fetchedAt,
      publishedAt: s.publishedAt,
    })),
    approaches: ct.approaches,
    memory: ct.memory,
    trials: ct.trials.map((t) => ({
      id: t.id,
      spec: t.spec,
      hypothesis: t.hypothesis,
      training: {
        netReturnPct: t.training.netReturnPct,
        trades: t.training.trades.length,
        diagnostics: t.training.diagnostics,
        blocked: t.training.blocked,
        ...daily(t.training),
      },
      development: {
        netReturnPct: t.development.netReturnPct,
        trades: t.development.trades.length,
        maxDrawdownPct: t.development.maxDrawdownPct,
        diagnostics: t.development.diagnostics,
        ...daily(t.development),
      },
      stress: { netReturnPct: t.stress.netReturnPct, ...daily(t.stress) },
      delayed: { netReturnPct: t.delayed.netReturnPct, ...daily(t.delayed) },
      sensitivity: t.sensitivity.map((x) => ({
        change: x.change,
        result: {
          netReturnPct: x.result.netReturnPct,
          meanDailyReturnPct: x.result.meanDailyReturnPct,
        },
      })),
      reasons: t.reasons,
    })),
  };
}
export function validateCTCandidate(candidate: CTCandidate, ct: CTResearch) {
  if (candidate.parentId && !ct.trials.some((t) => t.id === candidate.parentId))
    throw new Error("알 수 없는 부모 후보");
  if (
    ct.trials.length &&
    (!candidate.parentId ||
      !candidate.observedProblem ||
      !candidate.changes.length ||
      !candidate.expectedEffect)
  )
    throw new Error("수정의 부모·실측 문제·변경·기대 효과 필요");
  if (candidate.memoryIds.some((id) => !ct.memory.some((m) => m.id === id)))
    throw new Error("허용되지 않은 연구 기억");
  for (let stage = 0; stage < candidate.spec.stages.length; stage++)
    for (
      let condition = 0;
      condition < candidate.spec.stages[stage].conditions.length;
      condition++
    ) {
      const map = candidate.mapping.find(
        (m) => m.stage === stage && m.condition === condition,
      );
      if (
        !map ||
        map.feature !==
          candidate.spec.stages[stage].conditions[condition].feature ||
        !candidate.spec.sourceIds.includes(map.sourceId)
      )
        throw new Error("서술·실행 규칙 추적 불일치");
    }
  return candidate;
}
