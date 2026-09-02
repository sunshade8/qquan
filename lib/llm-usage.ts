import { getDb } from "@/db";
import { llmUsage } from "@/db/schema";

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type Price = { input: number; output: number; cacheWrite: number; cacheRead: number };

// USD per one million tokens. The deployed default is Claude Opus 4.7.
// Source: Anthropic list prices effective 2026-05-27.
const prices: Array<[RegExp, Price]> = [
  [/claude-opus-4-(?:5|6|7|8)/i, { input: 5, output: 25, cacheWrite: 6.25, cacheRead: .5 }],
  [/claude-sonnet-4-(?:5|6)/i, { input: 3, output: 15, cacheWrite: 3.75, cacheRead: .3 }],
  [/claude-haiku-4-5/i, { input: 1, output: 5, cacheWrite: 1.25, cacheRead: .1 }],
];

export const CLAUDE_PRICING_SOURCE = "https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf";
export const CLAUDE_PRICING_EFFECTIVE = "2026-05-27";

export function modelPrice(model: string) {
  return prices.find(([pattern]) => pattern.test(model))?.[1] ?? null;
}

export function usageCostUsd(model: string, usage: AnthropicUsage) {
  const price = modelPrice(model);
  if (!price) return null;
  const input = Math.max(0, Number(usage.input_tokens) || 0);
  const output = Math.max(0, Number(usage.output_tokens) || 0);
  const cacheWrite = Math.max(0, Number(usage.cache_creation_input_tokens) || 0);
  const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens) || 0);
  return Number(((input * price.input + output * price.output + cacheWrite * price.cacheWrite + cacheRead * price.cacheRead) / 1_000_000).toFixed(8));
}

export async function recordLlmUsage(ownerId: string, model: string, feature: string, usage: AnthropicUsage) {
  const costUsd = usageCostUsd(model, usage);
  try {
    await getDb().insert(llmUsage).values({
      id: crypto.randomUUID(), ownerId, provider: "Anthropic", model, feature,
      inputTokens: Math.max(0, Number(usage.input_tokens) || 0),
      outputTokens: Math.max(0, Number(usage.output_tokens) || 0),
      cacheCreationInputTokens: Math.max(0, Number(usage.cache_creation_input_tokens) || 0),
      cacheReadInputTokens: Math.max(0, Number(usage.cache_read_input_tokens) || 0),
      costUsd: costUsd ?? 0,
      priced: costUsd !== null,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error("[llm-usage] record failed", { model, feature, error: error instanceof Error ? error.message : String(error) });
  }
  return costUsd;
}
