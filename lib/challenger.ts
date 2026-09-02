/**
 * Cross-model review of frontier output.
 *
 * The `orchestrator`, `synthesizer` and `strategist` roles all sit on the
 * frontier tier, which resolves to a single model id — so any review one of them
 * performs on another's work is self-review under a different prompt. These
 * reviewers run on the `counter` tier instead, which is defined as "whichever
 * vendor does not serve frontier", making a different model a structural
 * guarantee rather than a convention.
 *
 * Two things get reviewed here that nothing else covers:
 * a strategy spec (whose author also wrote the criteria it is judged by) and a
 * final synthesised answer (which reaches the user with no other check).
 */

import { z } from "zod";
import { challengerIsIndependent, generateStructured, modelForTier } from "@/lib/claude";
import type { BacktestResult, StrategySpec } from "@/lib/strategy";

export const StrategyChallengeSchema = z.object({
  verdict: z.enum(["sound", "flawed", "unfalsifiable"]),
  headline: z.string(),
  mechanismMatch: z.string(),
  criteriaFairness: z.string(),
  falsifiabilityCheck: z.string(),
  overfittingRisk: z.enum(["low", "medium", "high"]),
  missingRisks: z.array(z.string()).max(5),
  decisiveTest: z.string(),
});

export const SynthesisChallengeSchema = z.object({
  verdict: z.enum(["accurate", "overclaimed", "unsupported"]),
  headline: z.string(),
  overclaims: z.array(z.string()).max(5),
  unsupportedNumbers: z.array(z.string()).max(5),
  missingCaveats: z.array(z.string()).max(4),
  suggestedConfidence: z.enum(["high", "medium", "low"]),
});

export type StrategyChallenge = z.infer<typeof StrategyChallengeSchema>;
export type SynthesisChallenge = z.infer<typeof SynthesisChallengeSchema>;

export const STRATEGY_VERDICT_LABELS: Record<StrategyChallenge["verdict"], string> = {
  sound: "규칙과 가설이 정합",
  flawed: "결함 있음",
  unfalsifiable: "반증 불가 — 가설로 성립하지 않음",
};

export const SYNTHESIS_VERDICT_LABELS: Record<SynthesisChallenge["verdict"], string> = {
  accurate: "근거 범위 내",
  overclaimed: "근거를 넘어선 주장 있음",
  unsupported: "핵심 주장이 근거 없음",
};

export const RISK_LABELS: Record<StrategyChallenge["overfittingRisk"], string> = { low: "낮음", medium: "보통", high: "높음" };

const STRATEGY_SYSTEM = `당신은 다른 모델이 작성한 퀀트 전략 사양을 검토하는 독립 심사관이다. 작성자와 다른 모델이며, 작성자의 추론 과정을 보지 못한다.

반드시 확인할 것
- 메커니즘 정합성: entry/exit 규칙이 hypothesis.mechanism이 말한 그 현상을 실제로 포착하는가? 서술은 그럴듯한데 규칙은 전혀 다른 것을 재는 경우가 흔하다. 어긋나면 구체적으로 어디가 어긋나는지 말한다.
- 통과 기준의 공정성: successCriteria가 이 전략이 쉽게 통과하도록 맞춰졌는가? 시스템이 최소 기준을 강제하지만, 작성자가 그 위에서 자기에게 유리하게 설정할 수 있다. 기간·유니버스가 규칙에 유리하게 선택된 흔적도 본다.
- 반증 가능성: hypothesis.falsification이 실제로 관측 가능한 결과인가, 아니면 "성과가 나쁘면 기각" 수준의 공허한 문장인가. 공허하면 verdict를 unfalsifiable로 한다.
- 규칙에 드러나지 않은 리스크: 유동성, 갭 리스크, 레짐 의존성, 소수 종목 집중, 비용 가정의 낙관성.

원칙
- 작성자에게 동의하는 것이 목적이 아니다. 결함을 찾지 못했다면 그때만 sound로 판정한다.
- 주어진 사양과 백테스트 숫자만 근거로 삼는다. 없는 값을 지어내지 않는다.
- decisiveTest는 실행 가능한 단일 검증이어야 한다.

한국어로 간결하고 구체적으로 답한다.`;

const SYNTHESIS_SYSTEM = `당신은 다른 모델이 작성한 최종 리서치 답변을 검토하는 독립 심사관이다. 작성자와 다른 모델이며, 작성자의 추론 과정을 보지 못한다.

임무: 답변이 주어진 근거가 실제로 뒷받침하는 범위를 넘어섰는지 찾는다.
- overclaims: 근거보다 강한 표현. 상관을 인과로 말했거나, 표본 한계를 지우고 일반화했거나, 확률적 결과를 단정한 곳.
- unsupportedNumbers: 근거 데이터에 없는데 답변에 등장한 수치. 반올림 왜곡과 재계산된 값도 포함한다.
- missingCaveats: 근거에는 있었으나 답변에서 빠진 한계(표본 크기, 겹치는 관측, 생존편향, 기간 특수성).
- 근거를 충실히 반영했고 한계도 전달했다면 accurate로 판정한다. 트집을 위한 트집은 금지한다.

한국어로 간결하게 답한다.`;

export type ChallengeOutcome<T> =
  | { ok: true; data: T; model: string; independent: boolean; costUsd: number | null }
  | { ok: false; reason: string };

function describeSpecForReview(spec: StrategySpec) {
  return JSON.stringify({
    name: spec.name, hypothesis: spec.hypothesis, universe: spec.universe, benchmark: spec.benchmark,
    entry: spec.entry, exit: spec.exit, holding: spec.holding, sizing: spec.sizing,
    costBps: spec.costBps, period: spec.period, successCriteria: spec.successCriteria, notes: spec.notes,
  });
}

/** Reviews a strategy spec written by the frontier `strategist`, on a different model. */
export async function challengeStrategy(input: { spec: StrategySpec; backtest: BacktestResult | null; ownerId: string }): Promise<ChallengeOutcome<StrategyChallenge>> {
  const backtest = input.backtest
    ? JSON.stringify({ verdict: input.backtest.verdict, metrics: input.backtest.metrics, robustness: input.backtest.robustness, period: input.backtest.period, missingSymbols: input.backtest.missingSymbols })
    : "백테스트 미실행";
  try {
    const result = await generateStructured({
      role: "challenger",
      schema: StrategyChallengeSchema,
      system: STRATEGY_SYSTEM,
      ownerId: input.ownerId,
      feature: "strategy.spec_challenger",
      maxTokens: 6000,
      effort: "medium",
      prompt: `전략 사양(JSON):\n${describeSpecForReview(input.spec)}\n\n백테스트 결과:\n${backtest}\n\n이 사양의 결함을 찾아 스키마에 맞춰 답하라.`,
    });
    return { ok: true, data: result.data, model: result.model, independent: challengerIsIndependent(), costUsd: result.costUsd };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "전략 심사에 실패했습니다." };
  }
}

/** Reviews a final synthesised answer against the evidence it was built from, on a different model. */
export async function challengeSynthesis(input: { answer: string; evidence: unknown; question: string; ownerId: string; feature?: string }): Promise<ChallengeOutcome<SynthesisChallenge>> {
  const payload = JSON.stringify(input.evidence);
  try {
    const result = await generateStructured({
      role: "challenger",
      schema: SynthesisChallengeSchema,
      system: SYNTHESIS_SYSTEM,
      ownerId: input.ownerId,
      feature: input.feature ?? "news.synthesis_challenger",
      maxTokens: 5000,
      effort: "medium",
      prompt: `사용자 질문: ${input.question}\n\n검토 대상 답변:\n${input.answer.slice(0, 12_000)}\n\n답변이 근거로 삼아야 할 데이터(JSON):\n${payload.length > 20_000 ? `${payload.slice(0, 20_000)}…(이하 생략)` : payload}\n\n답변이 근거 범위를 넘어섰는지 판정하라.`,
    });
    return { ok: true, data: result.data, model: result.model, independent: challengerIsIndependent(), costUsd: result.costUsd };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "답변 심사에 실패했습니다." };
  }
}

/** Human-readable note about who reviewed whom, for artifacts and answers. */
export function describeChallengerPairing(independent: boolean) {
  return independent
    ? `심사 모델 ${modelForTier("counter")} · 작성 모델 ${modelForTier("frontier")} (서로 다른 모델)`
    : `⚠️ 심사 모델과 작성 모델이 ${modelForTier("frontier")}로 동일합니다. 교차 검증 효과가 없으니 ANTHROPIC_MODEL 또는 OPENAI_API_KEY를 확인하세요.`;
}
