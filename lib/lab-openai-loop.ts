import { openaiClient, openaiFrontierEffort, openaiFrontierModel, openaiWebSearchToolType, mapOpenAiUsage } from "@/lib/openai";
import { executeLabTool, LAB_TOOLS, TOOL_LABELS } from "@/lib/lab-tools";
import { compressToolResult } from "@/lib/lab-specialists";
import type { ToolContext } from "@/lib/lab-tools";
import type { LabArtifact, LabStreamEvent, LabToolTrace } from "@/lib/lab-types";
import type { AnthropicUsage } from "@/lib/llm-usage";

/**
 * Lab JARVIS orchestrator loop on the OpenAI Responses API, used when
 * `LLM_FRONTIER_PROVIDER=openai`. It mirrors the Anthropic tool loop in
 * `app/api/lab/agent/route.ts`: same SSE phase events, same deterministic tools
 * (`lib/lab-tools.ts`), same artifact/trace collection. Web search is the
 * Responses built-in `web_search` tool instead of Anthropic's server tool.
 */

/**
 * Rebuild a model output item into the minimal shape the Responses API accepts
 * back as `input`. The SDK decorates items with helper fields (`parsed_arguments`
 * on function calls, annotations on text) that the API rejects on the way in.
 * Reasoning items are dropped entirely: with `store: false` they need
 * encrypted_content to round-trip, and GPT re-reasons each tool round anyway.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function carryForward(item: any): any | null {
  if (!item || typeof item !== "object") return null;
  if (item.type === "reasoning") return null;
  if (item.type === "function_call") {
    return { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments, ...(item.id ? { id: item.id } : {}) };
  }
  if (item.type === "message") {
    const content = Array.isArray(item.content)
      ? item.content.map((part: any) => (part?.type === "output_text" ? { type: "output_text", text: part.text ?? "" } : part))
      : item.content;
    return { type: "message", role: item.role ?? "assistant", content };
  }
  if (item.type === "web_search_call") {
    return { type: "web_search_call", id: item.id, status: item.status ?? "completed", action: item.action };
  }
  return item;
}

const FUNCTION_TOOLS = LAB_TOOLS.map((tool) => ({
  type: "function" as const,
  name: tool.name,
  description: tool.description ?? undefined,
  parameters: (tool.input_schema ?? { type: "object", properties: {} }) as Record<string, unknown>,
  strict: false,
}));

const TOOL_RESULT_LIMIT = 14_000;

function summarizeInput(input: unknown) {
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>).slice(0, 4)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : typeof value === "object" ? JSON.stringify(value).slice(0, 80) : String(value)}`)
    .join(" · ").slice(0, 160);
}

function safeArgs(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function webSearchArtifacts(output: any[]): LabArtifact[] {
  const citations = new Map<string, { title: string; url: string }>();
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type !== "output_text" || !Array.isArray(part.annotations)) continue;
      for (const annotation of part.annotations) {
        if (annotation?.type === "url_citation" && typeof annotation.url === "string") {
          citations.set(annotation.url, { title: annotation.title ?? annotation.url, url: annotation.url });
        }
      }
    }
  }
  const results = [...citations.values()].slice(0, 8).map((entry) => ({ title: entry.title, url: entry.url, snippet: "" }));
  const artifacts: LabArtifact[] = [];
  for (const item of output) {
    if (item?.type !== "web_search_call") continue;
    const action = item.action ?? {};
    const query = Array.isArray(action.queries) && action.queries.length ? action.queries.join(", ") : (typeof action.query === "string" ? action.query : "웹 검색");
    artifacts.push({ id: crypto.randomUUID(), type: "web-search", title: `웹 검색 · ${query}`, query, results, notes: ["OpenAI web search · 출처는 답변에서 인용"] });
  }
  return artifacts;
}

export type LabOpenAiLoopParams = {
  emit: (event: LabStreamEvent) => void;
  initialMessages: Array<{ role: "user" | "assistant"; content: string }>;
  instructions: string;
  context: ToolContext;
  artifacts: LabArtifact[];
  traces: LabToolTrace[];
  maxSteps: number;
};

export async function runLabOpenAiLoop(params: LabOpenAiLoopParams): Promise<{ answer: string; usages: AnthropicUsage[]; model: string }> {
  const { emit, instructions, context, artifacts, traces, maxSteps } = params;
  const client = openaiClient();
  const model = openaiFrontierModel();
  const tools = [...FUNCTION_TOOLS, { type: openaiWebSearchToolType() as "web_search" }];
  const input: any[] = params.initialMessages.map((message) => ({ role: message.role, content: message.content }));
  const usages: AnthropicUsage[] = [];
  let answer = "";

  emit({ type: "status", phase: "planning", label: "질문 해석·실행 계획", detail: "필요한 데이터와 분석 도구를 선택하고 있습니다." });

  for (let step = 0; step < maxSteps; step += 1) {
    if (step > 0) emit({ type: "status", phase: "verifying", label: "도구 결과 검증·해석", detail: `${traces.length}개 실행 결과를 질문과 대조하고 있습니다.` });

    const turn = client.responses.stream({
      model,
      instructions,
      input,
      tools,
      reasoning: { effort: openaiFrontierEffort() as never },
      max_output_tokens: 32_000,
      parallel_tool_calls: true,
      store: false,
    });

    let stepText = "";
    let writingStarted = false;
    let webSearchAnnounced = false;

    turn.on("response.output_text.delta", (event: any) => {
      const delta: string = event?.delta ?? "";
      if (!delta) return;
      stepText += delta;
      if (!writingStarted) {
        writingStarted = true;
        emit({ type: "status", phase: "writing", label: "답변 작성 중", detail: "검증된 숫자와 근거를 읽기 쉬운 답변으로 정리하고 있습니다." });
      }
      emit({ type: "text", delta });
    });
    turn.on("response.output_item.added", (event: any) => {
      const item = event?.item;
      if (!item) return;
      if (item.type === "function_call") {
        const label = TOOL_LABELS[item.name] ?? item.name;
        emit({ type: "status", phase: "tools", label: `${label} 준비`, detail: "분석에 필요한 입력값을 구성하고 있습니다." });
      } else if (item.type === "web_search_call" && !webSearchAnnounced) {
        webSearchAnnounced = true;
        emit({ type: "status", phase: "tools", label: "웹 검색", detail: "최신 정보를 검색하고 있습니다." });
      }
    });

    const response = await turn.finalResponse();
    usages.push(mapOpenAiUsage(response.usage));
    const output: any[] = response.output ?? [];
    if (stepText) answer = answer ? `${answer}\n\n${stepText}` : stepText;

    for (const artifact of webSearchArtifacts(output)) {
      artifacts.push(artifact);
      emit({ type: "artifact", artifact });
      traces.push({ id: (artifact as { id: string }).id, name: "web_search", label: "웹 검색", status: "complete", detail: (artifact as { query?: string }).query ?? "", startedAt: new Date().toISOString(), durationMs: 0 });
    }

    const functionCalls = output.filter((item) => item?.type === "function_call");
    if (!functionCalls.length) {
      if (!writingStarted) emit({ type: "status", phase: "writing", label: "답변 마무리 중", detail: "최종 응답과 생성된 결과를 저장하고 있습니다." });
      break;
    }

    for (const item of output) {
      const carried = carryForward(item);
      if (carried) input.push(carried);
    }

    const results = await Promise.all(functionCalls.map(async (call: any) => {
      const traceId: string = call.id ?? call.call_id ?? crypto.randomUUID();
      const label = TOOL_LABELS[call.name] ?? call.name;
      const startedAt = Date.now();
      const args = safeArgs(call.arguments);
      emit({ type: "tool_start", id: traceId, name: call.name, label, detail: summarizeInput(args) });
      try {
        const outcome = await executeLabTool(call.name, args, context);
        const durationMs = Date.now() - startedAt;
        for (const artifact of outcome.artifacts) { artifacts.push(artifact); emit({ type: "artifact", artifact }); }
        const trace: LabToolTrace = { id: traceId, ...outcome.trace, startedAt: new Date(startedAt).toISOString(), durationMs };
        traces.push(trace);
        emit({ type: "tool_end", id: traceId, name: call.name, label: trace.label, status: trace.status === "failed" ? "failed" : "complete", detail: trace.detail, durationMs });
        return { type: "function_call_output" as const, call_id: call.call_id, output: await compressToolResult(call.name, outcome.result, context.ownerId, TOOL_RESULT_LIMIT) };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "도구 실행 실패";
        const durationMs = Date.now() - startedAt;
        traces.push({ id: traceId, name: call.name, label, status: "failed", detail, startedAt: new Date(startedAt).toISOString(), durationMs });
        emit({ type: "tool_end", id: traceId, name: call.name, label, status: "failed", detail, durationMs });
        return { type: "function_call_output" as const, call_id: call.call_id, output: JSON.stringify({ error: detail }) };
      }
    }));
    for (const result of results) input.push(result);
    emit({ type: "status", phase: "verifying", label: "결과 종합", detail: `${traces.length}개 도구 결과를 교차 확인하고 있습니다.` });

    if (response.status === "incomplete") break;
  }

  return { answer, usages, model };
}
