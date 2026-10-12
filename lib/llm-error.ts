/**
 * Shared LLM error type. Lives in its own module so the Anthropic (`lib/claude`)
 * and OpenAI (`lib/openai`) layers can both throw it without an import cycle.
 * The historical name is kept because routes already catch `ClaudeApiError`.
 */
export class ClaudeApiError extends Error {
  // A plain field rather than a parameter property so Node's type stripping can load this in tests.
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * A structured response that stopped before completion. `max_output_tokens` (OpenAI's
 * reason, also used for Claude's `max_tokens`) means the output allowance — which for
 * OpenAI includes hidden reasoning — ran out; other reasons such as `content_filter`
 * are kept distinct. The status stays 502 so callers without a truncation policy keep
 * their previous retry behaviour.
 */
export class IncompleteResponseError extends ClaudeApiError {
  reason: string;
  maxOutputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  effort: string;

  constructor(provider: "OpenAI" | "Claude", detail: { reason: string; maxOutputTokens: number; outputTokens: number; reasoningTokens: number | null; effort: string }) {
    const n = (value: number) => value.toLocaleString("en-US");
    super(
      detail.reason === "max_output_tokens"
        ? `출력 한도 ${n(detail.maxOutputTokens)}토큰 초과 · 출력 ${n(detail.outputTokens)}토큰${detail.reasoningTokens != null ? ` 중 추론 ${n(detail.reasoningTokens)}토큰` : ""} · 추론 ${detail.effort}`
        : detail.reason === "content_filter" || detail.reason === "refusal"
          ? `${provider} ${detail.reason === "refusal" ? "응답 거부" : "콘텐츠 필터"}로 구조화 응답이 완성되지 않았습니다.`
          : `${provider} 구조화 응답이 완성되지 않았습니다 (${detail.reason}).`,
      502,
    );
    this.reason = detail.reason;
    this.maxOutputTokens = detail.maxOutputTokens;
    this.outputTokens = detail.outputTokens;
    this.reasoningTokens = detail.reasoningTokens;
    this.effort = detail.effort;
  }

  get truncated() {
    return this.reason === "max_output_tokens";
  }
}
