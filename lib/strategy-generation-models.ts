/** OpenAI standard API prices checked 2026-10-01; strategy-tab independent reviews stay on Anthropic. */
export const GENERATION_MODELS = {
  orchestrator: {
    provider: "OpenAI",
    model: "gpt-6.1-sol",
    label: "총괄 · 연구 계획",
    input: 2,
    output: 10,
    effort: "high",
  },
  dataAnalyst: {
    provider: "OpenAI",
    model: "gpt-6-luna",
    label: "자료 정리 · 품질 보고",
    input: 0.1,
    output: 0.5,
    effort: "low",
  },
  designer: {
    provider: "OpenAI",
    model: "gpt-6.1-sol",
    label: "전략 설계",
    input: 2,
    output: 10,
    effort: "high",
  },
  riskReviewer: {
    provider: "Anthropic",
    model: "claude-opus-5-5",
    label: "독립 위험 · 실행 검증",
    input: 4,
    output: 20,
  },
  evidenceReviewer: {
    provider: "Anthropic",
    model: "claude-opus-5-5",
    label: "독립 통계 · 최종 검증",
    input: 4,
    output: 20,
  },
  reporter: {
    provider: "OpenAI",
    model: "gpt-6-luna",
    label: "검증 결과 요약",
    input: 0.1,
    output: 0.5,
    effort: "low",
  },
} as const;
/**
 * CT-only roles (2026-10-13). The strategy tab and surge keep GENERATION_MODELS above.
 * In CT the hardest, most creative work — finding where an edge survives costs — runs on
 * Claude Opus 5.5 with training-only measurement tools; the independent reviewers move to
 * OpenAI so author and reviewer stay at different companies.
 */
export const CT_MODELS = {
  ctOrchestrator: {
    provider: "OpenAI",
    model: "gpt-6.1-sol",
    label: "CT 총괄 · 웹 검색",
    input: 2,
    output: 10,
    effort: "medium",
  },
  ctAnalyst: {
    provider: "OpenAI",
    model: "gpt-6-luna",
    label: "CT 자료 분석 · 원리 추출",
    input: 0.1,
    output: 0.5,
    effort: "low",
  },
  ctDesigner: {
    provider: "Anthropic",
    model: "claude-opus-5-5",
    label: "CT 연구 · 설계 · 수정",
    input: 4,
    output: 20,
    effort: "high",
  },
  ctRiskReviewer: {
    provider: "OpenAI",
    model: "gpt-6.1-sol",
    label: "CT 독립 위험 검토",
    input: 2,
    output: 10,
    effort: "high",
  },
  ctEvidenceReviewer: {
    provider: "OpenAI",
    model: "gpt-6.1-sol",
    label: "CT 독립 최종 검토",
    input: 2,
    output: 10,
    effort: "high",
  },
} as const;
export const RESEARCH_MODELS = { ...GENERATION_MODELS, ...CT_MODELS };
export type GenerationRole = keyof typeof RESEARCH_MODELS;
export type CTRole = keyof typeof CT_MODELS;
/** The models a new CT run calls; only these are checked before a paid CT run. */
export const CT_ROLES = Object.keys(CT_MODELS) as CTRole[];
/**
 * Provider outages fall back inside the same company only, so an Anthropic author or
 * reviewer never silently becomes the other side of an independence check.
 */
export function researchModel(role: GenerationRole, failures = 0) {
  const primary = RESEARCH_MODELS[role];
  return failures >= 2 && primary.provider === "Anthropic"
    ? { ...primary, model: "claude-sonnet-5-5", input: 2, output: 10 }
    : primary;
}
/** CT designer output per session turn (thinking + tool call); Opus streams it. */
export const CT_DESIGNER_TURN_MAX_TOKENS = 32000;
export function researchMaxTokens(role: GenerationRole) {
  if (role === "ctDesigner") return CT_DESIGNER_TURN_MAX_TOKENS;
  return role === "dataAnalyst" || role === "ctAnalyst" ? 4000 : role === "reporter" ? 3000 : RESEARCH_MODELS[role].provider === "OpenAI" ? 16000 : 12000;
}
export type ResearchEffort = "low" | "medium" | "high" | "xhigh";
/** CT designer allowance after one max-output truncation; the cost reserve is priced on it. */
export const CT_DESIGNER_RETRY_MAX_TOKENS = 32000;
/** Opus designer session turn after a truncation: more room, one step less thinking. */
export const CT_DESIGNER_TURN_RETRY_MAX_TOKENS = 64000;
/**
 * Output allowance and reasoning effort for one call. OpenAI counts reasoning inside
 * max_output_tokens, so a truncated CT call is retried once with less reasoning (and,
 * for the designer, a larger allowance). Slot and legacy research keep the defaults.
 */
export function researchCallLimits(role: GenerationRole, options: { ct?: boolean; truncated?: boolean } = {}) {
  const primary = RESEARCH_MODELS[role];
  const base = { maxOutputTokens: researchMaxTokens(role), effort: ("effort" in primary ? primary.effort : "high") as ResearchEffort };
  if (!options.ct || !options.truncated) return base;
  const lower: Record<ResearchEffort, ResearchEffort> = { xhigh: "high", high: "medium", medium: "low", low: "low" };
  return {
    maxOutputTokens: role === "designer" ? CT_DESIGNER_RETRY_MAX_TOKENS : role === "ctDesigner" ? CT_DESIGNER_TURN_RETRY_MAX_TOKENS : base.maxOutputTokens,
    effort: lower[base.effort],
  };
}
export function assertDifferentProvider(
  author: GenerationRole,
  reviewer: GenerationRole,
) {
  if (
    RESEARCH_MODELS[author].provider === RESEARCH_MODELS[reviewer].provider
  )
    throw new Error("검증자는 작성자와 다른 회사의 모델이어야 합니다.");
}
export const MODEL_SOURCES = [
  "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
  "https://developers.openai.com/api/docs/models/gpt-6-luna",
  "https://platform.claude.com/docs/en/models/overview",
  "https://platform.claude.com/docs/en/about-claude/pricing",
];

/** Provider tool tariff; kept with the existing research model/cost configuration. */
export const RESEARCH_WEB_SEARCH={maxCalls:3,usdPerCall:0.01,source:"https://openai.com/api/pricing/"} as const;
