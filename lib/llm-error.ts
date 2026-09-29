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
