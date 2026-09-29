/** Official standard API prices checked 2026-09-18; no same-vendor review fallback. */
export const GENERATION_MODELS = {
  orchestrator: {
    provider: "OpenAI",
    model: "gpt-6-astra",
    label: "총괄 · 연구 계획",
    input: 10,
    output: 50,
  },
  dataAnalyst: {
    provider: "OpenAI",
    model: "gpt-5.6-luna",
    label: "자료 정리 · 품질 보고",
    input: 0.2,
    output: 1.2,
  },
  designer: {
    provider: "OpenAI",
    model: "gpt-6-astra",
    label: "전략 설계",
    input: 10,
    output: 50,
  },
  riskReviewer: {
    provider: "Anthropic",
    model: "claude-opus-5",
    label: "독립 위험 · 실행 검증",
    input: 5,
    output: 25,
  },
  evidenceReviewer: {
    provider: "Anthropic",
    model: "claude-opus-5",
    label: "독립 통계 · 최종 검증",
    input: 5,
    output: 25,
  },
  reporter: {
    provider: "Anthropic",
    model: "claude-haiku-4-5-20251001",
    label: "검증 결과 요약",
    input: 1,
    output: 5,
  },
} as const;
export type GenerationRole = keyof typeof GENERATION_MODELS;
export function assertDifferentProvider(
  author: GenerationRole,
  reviewer: GenerationRole,
) {
  if (
    GENERATION_MODELS[author].provider === GENERATION_MODELS[reviewer].provider
  )
    throw new Error("검증자는 작성자와 다른 회사의 모델이어야 합니다.");
}
export const MODEL_SOURCES = [
  "https://developers.openai.com/api/docs/models/gpt-6-astra",
  "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  "https://platform.claude.com/docs/en/models/overview",
  "https://platform.claude.com/docs/en/about-claude/pricing",
];
