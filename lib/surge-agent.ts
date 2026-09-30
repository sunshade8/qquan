/**
 * The 급등락 사례 agent — its structure, fixed before the data exists.
 *
 * The owner's design, in order:
 *
 *   1. record      the owner hands over Toss TOP_GAINERS / TOP_LOSERS top 10 every
 *                  night at 00:00 KST as 날짜/종목/등락폭 — only these are the data
 *   2. collect     each case's own session in one-minute bars from Toss (raw prices),
 *                  once the session is over
 *   3. profile     deterministic facts per case, split at the snapshot minute
 *   4. similarity  do these surge days share a behaviour? (LLM analyst over the
 *                  profiles; every claim must name the cases it rests on)
 *   5. design      trading rules built on that behaviour (LLM designer)
 *   6. backtest    deterministic replay on cases the designer never saw
 *   7. review      independent check by the other company's model
 *   8. report
 *
 * Two constraints are written into the contracts rather than left to prompts:
 *
 * - **Time.** A case exists from its snapshot minute (00:00 KST = 11:00 ET in
 *   summer, 10:00 ET in winter). Live, the same trigger is the Toss ranking read
 *   at that minute. So a rule may condition on anything up to the snapshot and
 *   may only trade after it.
 * - **Held-out cases.** The newest 30% of case nights are never shown to the
 *   analyst or the designer; the backtest runs on them.
 *
 * Stages 4–8 are defined here (roles, gates, output schemas) but do not run yet:
 * with a few nights of cases there is nothing for them to find. They open when
 * the case count reaches their gate.
 */

import { z } from "zod";
import type { GenerationRole } from "./strategy-generation-models.ts";

export const SURGE_AGENT_GATES = {
  /** Collected cases before the similarity analyst runs. */
  similarity: 50,
  /** Collected cases before rules are designed — the owner's "10일이면 100종목". */
  design: 100,
  /** Share of the newest case nights kept from the analyst and designer for the backtest. */
  holdoutShare: 0.3,
} as const;

export const SURGE_AGENT_STAGES = [
  { id: "record", label: "기록 — 소유자가 준 토스 TOP10 목록 저장", role: null, kind: "deterministic" },
  { id: "collect", label: "수집 — 사례별 당일 1분봉 (토스 · 원주가)", role: null, kind: "deterministic" },
  { id: "profile", label: "사례 정리 — 스냅샷 전/후 경로 · 거래량 · 고저 시각", role: null, kind: "deterministic" },
  { id: "similarity", label: "행동 유사성 분석", role: "dataAnalyst", kind: "model" },
  { id: "design", label: "유사성 기반 매매 규칙 설계", role: "designer", kind: "model" },
  { id: "backtest", label: "미사용 사례로 규칙 재생", role: null, kind: "deterministic" },
  { id: "review", label: "독립 검증 (다른 회사 모델)", role: "evidenceReviewer", kind: "model" },
  { id: "report", label: "결과 요약", role: "reporter", kind: "model" },
] as const satisfies ReadonlyArray<{ id: string; label: string; role: GenerationRole | null; kind: "deterministic" | "model" }>;

export type SurgeAgentStage = (typeof SURGE_AGENT_STAGES)[number]["id"];

// ------------------------------------------------------------------ contracts

const caseRef = z.string().regex(/^\d{4}-\d{2}-\d{2}\|[A-Z0-9.-]+$/, "사례 ID는 YYYY-MM-DD|SYMBOL");

/** What the analyst must return: groups of cases that behaved alike, each backed by the cases themselves. */
export const similaritySchema = z.object({
  groups: z.array(z.object({
    name: z.string().min(3).max(80),
    /** Observable at or before the snapshot minute — what would let a live rule recognise the group. */
    signatureAtSnapshot: z.string().min(20).max(600),
    /** What the group's cases did after the snapshot. */
    behaviourAfterSnapshot: z.string().min(20).max(600),
    cases: z.array(caseRef).min(5),
    counterExamples: z.array(caseRef).max(50),
  }).strict()).max(8),
  noPattern: z.string().max(800).nullable(),
}).strict();

/** What the designer must return: rules triggered by the board at the snapshot, long only. */
export const surgeRuleSchema = z.object({
  name: z.string().min(3).max(100),
  basedOnGroup: z.string().min(3).max(80),
  board: z.enum(["gainers", "losers"]),
  /** Conditions on facts known at the snapshot, e.g. rank, move, premarket high, volume so far. */
  conditions: z.array(z.string().min(5).max(200)).min(1).max(6),
  /** Minutes after the snapshot the entry may happen within. */
  entryWindowMinutes: z.number().int().min(0).max(300),
  stopPct: z.number().min(1).max(30),
  targetPct: z.number().min(1).max(100).nullable(),
  exitBy: z.string().regex(/^(1[0-5]):[0-5]\d$/),
}).strict();

// ------------------------------------------------------------------ status

export type SurgeAgentCounts = { recorded: number; collected: number; pending: number; failed: number; nights: number };

/** Which stages have what they need. Nothing here runs a model. */
export function surgeAgentStatus(counts: SurgeAgentCounts) {
  const holdoutNights = Math.ceil(counts.nights * SURGE_AGENT_GATES.holdoutShare);
  return SURGE_AGENT_STAGES.map((stage) => {
    let state: "done" | "ready" | "waiting" = "waiting";
    let detail = "";
    switch (stage.id) {
      case "record":
        state = counts.recorded ? "done" : "waiting";
        detail = counts.recorded ? `사례 ${counts.recorded}건 · ${counts.nights}일` : "첫 목록을 기다립니다";
        break;
      case "collect":
        state = counts.collected ? (counts.pending ? "ready" : "done") : counts.pending ? "ready" : "waiting";
        detail = `수집 ${counts.collected} · 대기 ${counts.pending}${counts.failed ? ` · 실패 ${counts.failed}` : ""} (장 마감 20:00 ET 이후 수집)`;
        break;
      case "profile":
        state = counts.collected ? "done" : "waiting";
        detail = counts.collected ? "수집된 사례마다 자동 계산" : "수집된 사례가 없습니다";
        break;
      case "similarity":
        state = counts.collected >= SURGE_AGENT_GATES.similarity ? "ready" : "waiting";
        detail = `수집 사례 ${counts.collected}/${SURGE_AGENT_GATES.similarity}건 필요 · 최근 ${holdoutNights}일은 보지 않음`;
        break;
      case "design":
        state = counts.collected >= SURGE_AGENT_GATES.design ? "ready" : "waiting";
        detail = `수집 사례 ${counts.collected}/${SURGE_AGENT_GATES.design}건 필요`;
        break;
      default:
        detail = "앞 단계 결과가 필요합니다";
    }
    return { ...stage, state, detail };
  });
}
