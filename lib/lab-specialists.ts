/**
 * Non-frontier specialists the Lab orchestrator delegates to.
 *
 * The orchestrator is a single expensive model holding a 10-step budget. Two
 * kinds of work do not belong there: adversarially attacking a result it just
 * produced (a model reviewing itself in the same context agrees with itself),
 * and reading a large deterministic payload down to what matters. Both are
 * exposed as ordinary Lab tools, so the Anthropic and OpenAI orchestrator loops
 * pick them up identically and every call is recorded under its own role.
 */

import { z } from "zod";
import { claudeConfigured, generateStructured, generateText, modelForRole } from "@/lib/claude";
import type { SweepResult } from "@/lib/screener";

export const AuditSchema = z.object({
  verdict: z.enum(["supports", "weakens", "refutes", "insufficient"]),
  headline: z.string(),
  sampleAdequacy: z.string(),
  confounders: z.array(z.string()).max(5),
  counterHypotheses: z.array(z.string()).max(4),
  dataSnoopingRisk: z.enum(["low", "medium", "high"]),
  dataSnoopingReason: z.string(),
  survivorshipImpact: z.string(),
  decisiveTest: z.string(),
});

export type AuditReport = z.infer<typeof AuditSchema>;

export const AUDIT_VERDICT_LABELS: Record<AuditReport["verdict"], string> = {
  supports: "근거가 결론을 지지",
  weakens: "근거가 결론을 약화",
  refutes: "근거가 결론을 반박",
  insufficient: "판단하기에 근거 부족",
};

export const AUDIT_RISK_LABELS: Record<AuditReport["dataSnoopingRisk"], string> = {
  low: "낮음", medium: "보통", high: "높음",
};

const AUDIT_SYSTEM = `당신은 퀀트 리서치 감사관이다. 다른 에이전트가 도출한 결론과 그 근거 데이터를 받아, 그 결론을 무너뜨리려 시도하는 것이 임무다.

원칙
- 당신의 역할은 동의가 아니라 반증이다. 결론을 그대로 반복하거나 칭찬하지 않는다.
- 주어진 숫자만 근거로 삼는다. 데이터에 없는 값을 지어내지 않는다.
- 표본 적정성은 명목 n이 아니라 실효 n으로 판단한다. 관측 구간이 겹치는 전방 수익률은 독립 표본이 아니며, 같은 날 여러 종목이 동시에 조건을 만족하면(시장 전체 하락일 등) 표본은 사실상 하나에 가깝다. 이 점을 반드시 지적한다.
- 고정 종목 표본은 생존편향이 있다. 상장폐지·피인수 종목이 빠졌을 때 결과가 어느 방향으로 왜곡되는지 구체적으로 말한다.
- 데이터 스누핑 위험은 임계값·기간·유니버스가 몇 가지 후보 중에서 선택됐는지로 판단한다. 단일 셀 결과만 제시됐다면 위험은 최소 medium이다.
- decisiveTest는 실제로 실행 가능한 단일 검증이어야 한다. "더 많은 데이터가 필요하다" 같은 막연한 말은 금지한다.
- 베이스라인 대비 초과분이 일간 변동성에 비해 작으면 "구분되지 않는다"고 분명히 말한다.

한국어로, 간결하고 구체적으로 답한다.`;

const SWEEP_SYSTEM = `당신은 퀀트 리서치 분석가다. 조건의 임계값×기간 그리드 스윕 결과를 받아, 그 효과가 실재하는지 아니면 한 칸의 우연인지 판정한다.

판정 기준
- 진짜 효과는 인접한 임계값과 기간에서도 살아남는다. 한 칸만 크고 주변이 0 근처거나 부호가 뒤집히면 우연일 가능성이 높다.
- 진짜 효과는 보통 조건이 극단적일수록 강해진다(gt는 임계값이 클수록, lt는 작을수록). 이 단조성이 깨지면 그 사실을 지적한다.
- 표본 수가 급감하는 칸의 큰 수치는 신뢰하지 않는다.
- 부호 일관성(모든 칸이 같은 방향인가)을 명시적으로 평가한다.
- 최고 성적 칸을 "발견"으로 소개하지 않는다. 그것이 바로 과최적화다.

출력: 판정 한 줄 → 근거가 되는 그리드 패턴 → 이 결과로 할 수 있는 말과 할 수 없는 말. 한국어로 간결하게.`;

export type SpecialistOutcome<T> =
  | { ok: true; data: T; model: string; costUsd: number | null }
  | { ok: false; reason: string };

function unavailable(): SpecialistOutcome<never> {
  return { ok: false, reason: "감사·해석 전문가는 Anthropic balanced 티어(ANTHROPIC_API_KEY)가 필요합니다. 키가 연결되지 않아 건너뜁니다." };
}

/**
 * Adversarial review of a claim against the evidence that produced it. Runs on
 * the balanced tier under the `auditor` role — deliberately a different model
 * and a fresh context from the orchestrator that wrote the claim.
 */
export async function auditResult(input: { claim: string; evidence: unknown; question?: string; ownerId: string }): Promise<SpecialistOutcome<AuditReport>> {
  if (!claudeConfigured()) return unavailable();
  const payload = JSON.stringify(input.evidence);
  try {
    const result = await generateStructured({
      role: "auditor",
      schema: AuditSchema,
      system: AUDIT_SYSTEM,
      ownerId: input.ownerId,
      feature: "lab.result_auditor",
      // Adaptive thinking spends the same max_tokens budget as the output, and
      // this schema has eight prose fields. A tight budget truncates the JSON
      // mid-string, which surfaces as a parse failure the orchestrator retries.
      maxTokens: 6000,
      effort: "medium",
      prompt: [
        input.question ? `원래 질문: ${input.question}` : null,
        `검증 대상 결론: ${input.claim}`,
        `근거 데이터(JSON):\n${payload.length > 20_000 ? `${payload.slice(0, 20_000)}…(이하 생략)` : payload}`,
        "이 결론을 무너뜨릴 수 있는 지점을 찾아 스키마에 맞춰 답하라.",
      ].filter(Boolean).join("\n\n"),
    });
    return { ok: true, data: result.data, model: result.model, costUsd: result.costUsd };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "감사 실행에 실패했습니다." };
  }
}

/** Reads a threshold x horizon grid and says whether the effect is real or one lucky cell. */
export async function interpretSweep(input: { sweep: SweepResult; conditionLabel: string; universeLabel: string; ownerId: string }): Promise<SpecialistOutcome<string>> {
  if (!claudeConfigured()) return unavailable();
  const { sweep } = input;
  const grid = sweep.cells.map((cell) => `임계값 ${cell.threshold} · ${cell.horizon}일: n=${cell.samples}, 조건부 ${cell.conditionalAvgPct ?? "—"}%, 기준 ${cell.baselineAvgPct ?? "—"}%, 초과 ${cell.edgePct ?? "—"}%p, 승률차 ${cell.positiveRateDiffPct ?? "—"}%p`).join("\n");
  try {
    const result = await generateText({
      role: "analyst",
      system: SWEEP_SYSTEM,
      ownerId: input.ownerId,
      feature: "lab.sweep_analyst",
      maxTokens: 3000,
      effort: "medium",
      prompt: [
        `유니버스: ${input.universeLabel} (${sweep.symbolsScanned}종목 스캔)`,
        `조건: ${input.conditionLabel}`,
        `그리드 (${sweep.thresholds.length}개 임계값 × ${sweep.horizons.length}개 기간):\n${grid}`,
        `결정론적 견고성 지표: 표본 있는 칸 ${sweep.robustness.cellsWithSamples}/${sweep.robustness.totalCells}, 초과분 양수 칸 ${sweep.robustness.positiveEdgeCells} (${sweep.robustness.positiveEdgeRatePct ?? "—"}%), 초과분 중앙값 ${sweep.robustness.medianEdgePct ?? "—"}%p (최소 ${sweep.robustness.minEdgePct ?? "—"} / 최대 ${sweep.robustness.maxEdgePct ?? "—"}), 부호 일관성 ${sweep.robustness.signConsistent ? "있음" : "없음"}, 극단으로 갈수록 강해짐 ${sweep.robustness.strengthensWithExtremity === null ? "판정 불가" : sweep.robustness.strengthensWithExtremity ? "그렇다" : "아니다"}`,
        "이 스윕이 실재하는 효과를 보여주는지 판정하라.",
      ].join("\n\n"),
    });
    return { ok: true, data: result.text, model: result.model, costUsd: result.costUsd };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "스윕 해석에 실패했습니다." };
  }
}

const COMPRESS_SYSTEM = `당신은 퀀트 도구 출력 압축기다. 오케스트레이터 모델에게 넘길 도구 결과를 요약한다.

규칙
- 숫자를 절대 바꾸거나 반올림하지 않는다. 원문 값을 그대로 인용한다.
- 결론을 내리거나 해석하지 않는다. 무엇이 관측됐는지만 남긴다.
- 남길 것: 식별자(종목·기간·날짜), 핵심 수치, 표본 크기, 실패·제한 사유, 상위 항목.
- 버릴 것: 반복되는 하위 항목, 차트용 원시 시계열, 중복 필드.
- 데이터가 잘렸거나 누락됐으면 그 사실을 반드시 남긴다.
- 순수 데이터 나열로 간결하게. 문장을 꾸미지 않는다.`;

/**
 * Compresses an oversized tool payload with the fast tier instead of cutting the
 * JSON mid-string. Hard truncation hands the orchestrator malformed JSON whose
 * tail is silently missing; a summary at least stays well-formed and says what
 * was dropped. Falls back to truncation when the fast tier is unavailable.
 */
export async function compressToolResult(toolName: string, value: unknown, ownerId: string, limit: number): Promise<string> {
  const text = JSON.stringify(value);
  if (text.length <= limit) return text;
  const truncated = `${text.slice(0, limit)}… (원본 ${text.length}자에서 잘림 · 뒷부분 손실)`;
  if (!claudeConfigured()) return truncated;
  console.info("[lab-specialists] compressing tool result", { toolName, chars: text.length, limit });
  try {
    const result = await generateText({
      role: "summarizer",
      system: COMPRESS_SYSTEM,
      ownerId,
      feature: "lab.tool_compression",
      maxTokens: 1800,
      effort: "low",
      prompt: `도구 ${toolName}의 결과(JSON, ${text.length}자)를 압축하라. 숫자는 그대로 유지한다.\n\n${text.slice(0, 60_000)}`,
    });
    return `[${toolName} 결과 요약 · 원본 ${text.length}자를 ${modelForRole("summarizer")}로 압축]\n${result.text}`;
  } catch (error) {
    // Falling back to truncation keeps the turn alive, but silently degrading
    // would hide a broken summariser behind merely worse answers.
    console.error("[lab-specialists] tool compression failed", { toolName, chars: text.length, error: error instanceof Error ? error.message : String(error) });
    return truncated;
  }
}
