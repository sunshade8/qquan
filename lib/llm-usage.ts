import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { llmUsage } from "@/db/schema";

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type Price = { input: number; output: number; cacheWrite: number; cacheRead: number };

// USD per one million tokens. For Anthropic, cache write is 1.25x input, cache read is 0.1x input.
// Anthropic list prices as of 2026-06-24. OpenAI GPT-5.5 entry is a placeholder —
// TODO: confirm against the OpenAI pricing page (cacheWrite is unused for OpenAI, cacheRead ~= 0.1x input).
// GPT-6 Astra standard rates: https://developers.openai.com/api/docs/models/gpt-6-astra
const prices: Array<[RegExp, Price]> = [
  [/^gpt-6\.1-sol(?:-|$)/i, { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 }],
  [/^gpt-6-luna(?:-|$)/i, { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 }],
  [/^gpt-5\.6-luna(?:-|$)/i, { input: 0.2, output: 1.2, cacheWrite: 0.25, cacheRead: 0.02 }],
  [/^gpt-6-astra(?:-|$)/i, { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 }],
  [/claude-(?:fable|mythos)-5/i, { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 }],
  [/claude-opus-(?:4-(?:5|6|7|8)|5)/i, { input: 5, output: 25, cacheWrite: 6.25, cacheRead: .5 }],
  [/claude-sonnet-5/i, { input: 2, output: 10, cacheWrite: 2.5, cacheRead: .2 }],
  [/claude-sonnet-4-(?:5|6)/i, { input: 3, output: 15, cacheWrite: 3.75, cacheRead: .3 }],
  [/claude-haiku-4-5/i, { input: 1, output: 5, cacheWrite: 1.25, cacheRead: .1 }],
  [/gpt-5\.5/i, { input: 5, output: 25, cacheWrite: 5, cacheRead: .5 }],
];

export const CLAUDE_PRICING_SOURCE = "https://www.anthropic.com/pricing";
export const CLAUDE_PRICING_EFFECTIVE = "2026-06-24";

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
  const longContext = /^gpt-6(?:\.1-sol|-astra|-luna)(?:-|$)/i.test(model) && input + cacheWrite + cacheRead > 272_000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  return Number((((input * price.input + cacheWrite * price.cacheWrite + cacheRead * price.cacheRead) * inputMultiplier + output * price.output * outputMultiplier) / 1_000_000).toFixed(8));
}

export async function recordLlmUsage(ownerId: string, model: string, feature: string, usage: AnthropicUsage, provider: "Anthropic" | "OpenAI" = "Anthropic", role: string | null = null) {
  const costUsd = usageCostUsd(model, usage);
  try {
    await ensureSchema();
    await getDb().insert(llmUsage).values({
      id: crypto.randomUUID(), ownerId, provider, model, feature, role,
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
