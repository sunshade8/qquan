import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { env } from "cloudflare:workers";
import type { z } from "zod";
import { recordLlmUsage, type AnthropicUsage } from "@/lib/llm-usage";
import { ClaudeApiError } from "@/lib/llm-error";
import {
  describeOpenAiError,
  frontierProvider,
  generateStructuredOpenAI,
  generateTextOpenAI,
  openaiFrontierModel,
} from "@/lib/openai";

/**
 * Every Claude call in the app goes through this module.
 *
 * Models are allocated by *role* rather than hard-coded per call site, so the
 * expensive frontier model is reserved for the work that needs it (orchestration,
 * final synthesis, strategy design) while high-volume or mechanical work
 * (headline scoring, auditing, routing, summarising) runs on cheaper tiers.
 */

export type ModelTier = "frontier" | "balanced" | "fast";
export type ModelRole =
  | "orchestrator" // Lab JARVIS: multi-step tool loop
  | "synthesizer" // final user-facing research answer
  | "strategist" // turns evidence into a falsifiable trading rule
  | "analyst" // headline sentiment scoring (structured)
  | "auditor" // adversarial checks on the analyst's output
  | "planner" // request → execution plan (structured)
  | "router" // cheap intent classification
  | "summarizer"; // compress tool output / conversation memory

const TIER_DEFAULTS: Record<ModelTier, string> = {
  frontier: "claude-opus-4-7",
  balanced: "claude-sonnet-5",
  fast: "claude-haiku-4-5",
};

export const ROLE_TIERS: Record<ModelRole, ModelTier> = {
  orchestrator: "frontier",
  synthesizer: "frontier",
  strategist: "frontier",
  analyst: "balanced",
  auditor: "balanced",
  planner: "balanced",
  router: "fast",
  summarizer: "fast",
};

export const ROLE_DESCRIPTIONS: Record<ModelRole, string> = {
  orchestrator: "Lab JARVIS · 도구 선택과 다단계 리서치 실행",
  synthesizer: "News JARVIS · 최종 결론 합성",
  strategist: "전략 설계 · 반증 가능한 규칙 작성",
  analyst: "헤드라인 감성 채점 (구조화 출력)",
  auditor: "패턴 감사 · 반례 탐색",
  planner: "요청 해석 · 실행 계획 (구조화 출력)",
  router: "의도 분류",
  summarizer: "도구 결과·대화 압축",
};

export { ClaudeApiError } from "@/lib/llm-error";
export { frontierProvider };

function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

function envValue(key: string) {
  return runtimeEnv()[key] ?? process.env[key];
}

export function modelForTier(tier: ModelTier) {
  // The frontier tier can be served by OpenAI (GPT-5.5 Thinking); balanced/fast stay on Anthropic.
  if (tier === "frontier" && frontierProvider() === "openai") return openaiFrontierModel();
  const override = tier === "frontier" ? envValue("ANTHROPIC_MODEL") : tier === "balanced" ? envValue("ANTHROPIC_MODEL_BALANCED") : envValue("ANTHROPIC_MODEL_FAST");
  return override?.trim() || TIER_DEFAULTS[tier];
}

export function providerForTier(tier: ModelTier): "OpenAI" | "Anthropic" {
  return tier === "frontier" && frontierProvider() === "openai" ? "OpenAI" : "Anthropic";
}

export function modelForRole(role: ModelRole) {
  return modelForTier(ROLE_TIERS[role]);
}

export function modelAllocation() {
  return (Object.keys(ROLE_TIERS) as ModelRole[]).map((role) => ({
    role, tier: ROLE_TIERS[role], model: modelForRole(role), provider: providerForTier(ROLE_TIERS[role]), purpose: ROLE_DESCRIPTIONS[role],
  }));
}

export function claudeConfigured() {
  return Boolean(envValue("ANTHROPIC_API_KEY"));
}

let cachedClient: { key: string; client: Anthropic } | null = null;

export function claudeClient() {
  const apiKey = envValue("ANTHROPIC_API_KEY");
  if (!apiKey) throw new ClaudeApiError("Claude 서버 키가 연결되지 않았습니다.", 503);
  if (cachedClient?.key !== apiKey) cachedClient = { key: apiKey, client: new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 }) };
  return cachedClient.client;
}

export type Effort = "low" | "medium" | "high";

/** Adaptive thinking is the only "on" mode on 4.6+ models; older models get no thinking and keep sampling params. */
export function supportsAdaptiveThinking(model: string) {
  return /claude-(?:opus-4-[678]|opus-5|sonnet-4-6|sonnet-5|fable|mythos)/i.test(model);
}

export function reasoningParams(model: string, effort: Effort): Pick<Anthropic.MessageCreateParams, "thinking" | "output_config"> {
  if (!supportsAdaptiveThinking(model)) return {};
  return { thinking: { type: "adaptive" }, output_config: { effort } };
}

export function usageOf(message: Pick<Anthropic.Message, "usage"> | null | undefined): AnthropicUsage {
  const usage = message?.usage;
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
  };
}

export function sumUsage(items: AnthropicUsage[]): AnthropicUsage {
  return items.reduce<AnthropicUsage>((total, item) => ({
    input_tokens: (total.input_tokens ?? 0) + (item.input_tokens ?? 0),
    output_tokens: (total.output_tokens ?? 0) + (item.output_tokens ?? 0),
    cache_creation_input_tokens: (total.cache_creation_input_tokens ?? 0) + (item.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (total.cache_read_input_tokens ?? 0) + (item.cache_read_input_tokens ?? 0),
  }), { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
}

/** Map SDK exceptions to a status + Korean message without string matching. */
export function describeClaudeError(error: unknown): ClaudeApiError {
  if (error instanceof ClaudeApiError) return error;
  const openai = describeOpenAiError(error);
  if (openai) return openai;
  if (error instanceof Anthropic.AuthenticationError) return new ClaudeApiError("Claude API 키가 유효하지 않습니다.", 401);
  if (error instanceof Anthropic.RateLimitError) return new ClaudeApiError("Claude 호출 한도를 잠시 초과했습니다. 잠시 후 다시 시도해주세요.", 429);
  if (error instanceof Anthropic.BadRequestError) return new ClaudeApiError(`Claude 요청이 거부되었습니다: ${error.message}`, 400);
  if (error instanceof Anthropic.APIConnectionError) return new ClaudeApiError("Claude API에 연결하지 못했습니다.", 502);
  if (error instanceof Anthropic.APIError) return new ClaudeApiError(`Claude API 오류 (${error.status ?? "?"}): ${error.message}`, typeof error.status === "number" ? error.status : 502);
  return new ClaudeApiError(error instanceof Error ? error.message : "Claude 호출에 실패했습니다.", 500);
}

type SystemInput = string | Array<{ text: string; cache?: boolean }>;

function systemBlocks(system: SystemInput | undefined): Anthropic.TextBlockParam[] | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  return system.map((block) => ({ type: "text", text: block.text, ...(block.cache ? { cache_control: { type: "ephemeral" as const } } : {}) }));
}

export type TextCall = {
  role: ModelRole;
  system?: SystemInput;
  messages?: Anthropic.MessageParam[];
  prompt?: string;
  maxTokens?: number;
  effort?: Effort;
  ownerId: string;
  feature: string;
};

/** One-shot text generation. Uses streaming under the hood so long outputs never hit HTTP timeouts. */
export async function generateText(call: TextCall) {
  if (ROLE_TIERS[call.role] === "frontier" && frontierProvider() === "openai") return generateTextOpenAI(call);
  const model = modelForRole(call.role);
  const client = claudeClient();
  const messages = call.messages ?? [{ role: "user", content: call.prompt ?? "" }];
  try {
    const stream = client.messages.stream({
      model,
      max_tokens: call.maxTokens ?? 4000,
      system: systemBlocks(call.system),
      messages,
      ...reasoningParams(model, call.effort ?? "medium"),
    });
    const message = await stream.finalMessage();
    const text = message.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("\n").trim();
    const costUsd = await recordLlmUsage(call.ownerId, model, call.feature, usageOf(message), "Anthropic", call.role);
    if (message.stop_reason === "refusal") throw new ClaudeApiError("Claude가 이 요청에 대한 응답을 거부했습니다.", 422);
    if (!text) throw new ClaudeApiError("Claude 응답이 비어 있습니다.", 502);
    return { text, model, usage: usageOf(message), costUsd, stopReason: message.stop_reason };
  } catch (error) {
    throw describeClaudeError(error);
  }
}

export type StructuredCall<T extends z.ZodType> = Omit<TextCall, "maxTokens"> & { schema: T; maxTokens?: number };

/** Structured generation validated against a Zod schema via output_config.format. */
export async function generateStructured<T extends z.ZodType>(call: StructuredCall<T>): Promise<{ data: z.infer<T>; model: string; usage: AnthropicUsage; costUsd: number | null }> {
  if (ROLE_TIERS[call.role] === "frontier" && frontierProvider() === "openai") return generateStructuredOpenAI(call);
  const model = modelForRole(call.role);
  const client = claudeClient();
  const messages = call.messages ?? [{ role: "user", content: call.prompt ?? "" }];
  try {
    const message = await client.messages.parse({
      model,
      max_tokens: call.maxTokens ?? 4000,
      system: systemBlocks(call.system),
      messages,
      output_config: { format: zodOutputFormat(call.schema), ...(supportsAdaptiveThinking(model) ? { effort: call.effort ?? "medium" } : {}) },
      ...(supportsAdaptiveThinking(model) ? { thinking: { type: "adaptive" as const } } : {}),
    });
    const costUsd = await recordLlmUsage(call.ownerId, model, call.feature, usageOf(message), "Anthropic", call.role);
    if (message.stop_reason === "refusal") throw new ClaudeApiError("Claude가 이 요청에 대한 응답을 거부했습니다.", 422);
    if (message.parsed_output === null || message.parsed_output === undefined) throw new ClaudeApiError("Claude 구조화 응답을 해석하지 못했습니다.", 502);
    return { data: message.parsed_output as z.infer<T>, model, usage: usageOf(message), costUsd };
  } catch (error) {
    throw describeClaudeError(error);
  }
}

export type { Anthropic };
