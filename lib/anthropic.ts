import { recordLlmUsage, type AnthropicUsage } from "@/lib/llm-usage";

export class ClaudeApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function callClaude(options: {
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens: number;
  ownerId: string;
  feature: string;
}) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: options.model, max_tokens: options.maxTokens, messages: [{ role: "user", content: options.prompt }] }),
  });
  if (!response.ok) throw new ClaudeApiError("Claude 호출에 실패했습니다.", response.status);
  const result = await response.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?: AnthropicUsage;
  };
  const text = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
  if (!text) throw new ClaudeApiError("Claude 응답이 비어 있습니다.", 502);
  const costUsd = await recordLlmUsage(options.ownerId, options.model, options.feature, result.usage ?? {});
  return { text, usage: result.usage ?? {}, costUsd };
}

export async function callClaudeTool<T>(options: {
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens: number;
  ownerId: string;
  feature: string;
  tool: { name: string; description: string; inputSchema: Record<string, unknown> };
}) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{ role: "user", content: options.prompt }],
      tools: [{ name: options.tool.name, description: options.tool.description, input_schema: options.tool.inputSchema }],
      tool_choice: { type: "tool", name: options.tool.name },
    }),
  });
  if (!response.ok) throw new ClaudeApiError("Claude 구조화 호출에 실패했습니다.", response.status);
  const result = await response.json() as {
    content?: Array<{ type: string; name?: string; input?: unknown }>;
    usage?: AnthropicUsage;
  };
  const toolUse = result.content?.find((item) => item.type === "tool_use" && item.name === options.tool.name);
  if (!toolUse?.input || typeof toolUse.input !== "object") throw new ClaudeApiError("Claude 구조화 응답이 비어 있습니다.", 502);
  const costUsd = await recordLlmUsage(options.ownerId, options.model, options.feature, result.usage ?? {});
  return { input: toolUse.input as T, usage: result.usage ?? {}, costUsd };
}
