/**
 * Shared LLM error type. Lives in its own module so the Anthropic (`lib/claude`)
 * and OpenAI (`lib/openai`) layers can both throw it without an import cycle.
 * The historical name is kept because routes already catch `ClaudeApiError`.
 */
export class ClaudeApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
