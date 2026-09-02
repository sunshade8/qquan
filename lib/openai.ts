import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { env } from "cloudflare:workers";
import type { z } from "zod";
import { recordLlmUsage, type AnthropicUsage } from "@/lib/llm-usage";
import { ClaudeApiError } from "@/lib/llm-error";
import type { StructuredCall, TextCall } from "@/lib/claude";

/**
 * OpenAI is used only for the *frontier* role tier (Lab JARVIS orchestrator,
 * News synthesizer, strategist) and only when `LLM_FRONTIER_PROVIDER=openai`.
 * The balanced (Sonnet) and fast (Haiku) tiers stay on Anthropic regardless.
 *
 * Everything runs through the Responses API so we can use the built-in
 * `web_search` tool and GPT-5.5 Thinking's `reasoning.effort` (xhigh).
 */

// OpenAI accepts "xhigh" for GPT-5.5 Thinking; the SDK's enum is narrower, so we
// keep our own and send the raw string over the wire.
export type OpenAiEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

function envValue(key: string) {
  return runtimeEnv()[key] ?? process.env[key];
}

/** Which provider serves the frontier tier. Defaults to Anthropic so nothing changes until the env var is set. */
export function frontierProvider(): "openai" | "anthropic" {
  return (envValue("LLM_FRONTIER_PROVIDER") ?? "").trim().toLowerCase() === "openai" ? "openai" : "anthropic";
}

export function openaiConfigured() {
  return Boolean(envValue("OPENAI_API_KEY"));
}

// "GPT-5.5 Thinking" on the API is the reasoning model `gpt-5.5` driven by
// reasoning.effort (there is no `-thinking` model id).
export function openaiFrontierModel() {
  return envValue("OPENAI_MODEL")?.trim() || "gpt-5.5";
}

export function openaiFrontierEffort(): OpenAiEffort {
  return (envValue("OPENAI_REASONING_EFFORT")?.trim() as OpenAiEffort) || "xhigh";
}

/** Responses API built-in web search tool type. `web_search` on current models; override if the account needs the dated slug. */
export function openaiWebSearchToolType() {
  return envValue("OPENAI_WEB_SEARCH_TOOL")?.trim() || "web_search";
}

let cachedClient: { key: string; client: OpenAI } | null = null;

export function openaiClient() {
  const apiKey = envValue("OPENAI_API_KEY");
  if (!apiKey) throw new ClaudeApiError("OpenAI 서버 키가 연결되지 않았습니다.", 503);
  if (cachedClient?.key !== apiKey) cachedClient = { key: apiKey, client: new OpenAI({ apiKey, maxRetries: 2, timeout: 180_000 }) };
  return cachedClient.client;
}

type OpenAiUsageShape = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | null | undefined;

/**
 * Map Responses usage into the Anthropic-shaped record the rest of the app uses.
 * OpenAI's `input_tokens` *includes* cached tokens, so we split them out to keep
 * cost math (input vs cache-read priced separately) consistent with Anthropic.
 */
export function mapOpenAiUsage(usage: OpenAiUsageShape): AnthropicUsage {
  const cached = Math.max(0, Number(usage?.input_tokens_details?.cached_tokens) || 0);
  const input = Math.max(0, Number(usage?.input_tokens) || 0);
  return {
    input_tokens: Math.max(0, input - cached),
    output_tokens: Math.max(0, Number(usage?.output_tokens) || 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

/** Map an OpenAI SDK exception to a ClaudeApiError, or null if it is not one. */
export function describeOpenAiError(error: unknown): ClaudeApiError | null {
  if (error instanceof OpenAI.AuthenticationError) return new ClaudeApiError("OpenAI API 키가 유효하지 않습니다.", 401);
  if (error instanceof OpenAI.RateLimitError) return new ClaudeApiError("OpenAI 호출 한도를 잠시 초과했습니다. 잠시 후 다시 시도해주세요.", 429);
  if (error instanceof OpenAI.APIConnectionError) return new ClaudeApiError("OpenAI API에 연결하지 못했습니다.", 502);
  if (error instanceof OpenAI.APIError) {
    const status = typeof error.status === "number" ? error.status : 502;
    return new ClaudeApiError(`OpenAI API 오류 (${error.status ?? "?"}): ${error.message}`, status);
  }
  return null;
}

function toOpenAiError(error: unknown): ClaudeApiError {
  return describeOpenAiError(error)
    ?? (error instanceof ClaudeApiError ? error : new ClaudeApiError(error instanceof Error ? error.message : "OpenAI 호출에 실패했습니다.", 500));
}

export function instructionsFrom(system: TextCall["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

type PlainMessage = { role: "user" | "assistant"; content: string };

/** Flatten the (Anthropic-shaped) call messages into plain role/text items for the Responses `input`. */
export function inputFrom(call: Pick<TextCall, "messages" | "prompt">): PlainMessage[] {
  const source = call.messages ?? [{ role: "user" as const, content: call.prompt ?? "" }];
  const items: PlainMessage[] = [];
  for (const message of source) {
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const content = typeof message.content === "string"
      ? message.content
      : (message.content as Array<{ type: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    if (content.trim()) items.push({ role, content });
  }
  return items;
}

// Reasoning + visible output share this budget on the Responses API, and xhigh
// effort spends a lot on reasoning, so a low cap yields empty completions.
function outputBudget(maxTokens: number | undefined) {
  return Math.max((maxTokens ?? 4000) + 12_000, 16_000);
}

/** Frontier one-shot text generation via the Responses API (streamed to dodge HTTP timeouts). */
export async function generateTextOpenAI(call: TextCall) {
  const client = openaiClient();
  const model = openaiFrontierModel();
  try {
    const stream = client.responses.stream({
      model,
      instructions: instructionsFrom(call.system),
      input: inputFrom(call),
      reasoning: { effort: openaiFrontierEffort() as never },
      max_output_tokens: outputBudget(call.maxTokens),
      store: false,
    });
    const response = await stream.finalResponse();
    const text = (response.output_text ?? "").trim();
    const usage = mapOpenAiUsage(response.usage);
    const costUsd = await recordLlmUsage(call.ownerId, model, call.feature, usage, "OpenAI", call.role);
    if (!text && response.status === "incomplete") throw new ClaudeApiError("OpenAI 응답이 토큰 한도에서 잘렸습니다.", 502);
    if (!text) throw new ClaudeApiError("OpenAI 응답이 비어 있습니다.", 502);
    return { text, model, usage, costUsd, stopReason: String(response.status ?? "completed") };
  } catch (error) {
    throw toOpenAiError(error);
  }
}

/** Frontier structured generation validated against a Zod schema. */
export async function generateStructuredOpenAI<T extends z.ZodType>(
  call: StructuredCall<T>,
): Promise<{ data: z.infer<T>; model: string; usage: AnthropicUsage; costUsd: number | null }> {
  const client = openaiClient();
  const model = openaiFrontierModel();
  try {
    const response = await client.responses.parse({
      model,
      instructions: instructionsFrom(call.system),
      input: inputFrom(call),
      reasoning: { effort: openaiFrontierEffort() as never },
      max_output_tokens: outputBudget(call.maxTokens),
      store: false,
      text: { format: zodTextFormat(call.schema, "output") },
    });
    const usage = mapOpenAiUsage(response.usage);
    const costUsd = await recordLlmUsage(call.ownerId, model, call.feature, usage, "OpenAI", call.role);
    const data = response.output_parsed;
    if (data === null || data === undefined) throw new ClaudeApiError("OpenAI 구조화 응답을 해석하지 못했습니다.", 502);
    return { data: data as z.infer<T>, model, usage, costUsd };
  } catch (error) {
    throw toOpenAiError(error);
  }
}
