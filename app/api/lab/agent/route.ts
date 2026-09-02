import type Anthropic from "@anthropic-ai/sdk";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { labMessages } from "@/db/schema";
import { claudeClient, claudeConfigured, describeClaudeError, modelForRole, reasoningParams, sumUsage, usageOf } from "@/lib/claude";
import { executeLabTool, LAB_TOOLS, TOOL_LABELS } from "@/lib/lab-tools";
import type { LabArtifact, LabMessage, LabStreamEvent, LabToolTrace } from "@/lib/lab-types";
import { recordLlmUsage } from "@/lib/llm-usage";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

const MAX_STEPS = 8;
const MAX_HISTORY = 24;

const SYSTEM_PROMPT = `당신은 QQuant Lab의 JARVIS다. 사용자의 개인 퀀트 리서치 데스크를 운영하는 수석 포트폴리오 매니저이자 퀀트 리서처로서, 주식·ETF·지수·매크로·파생·리스크 관리·팩터 투자·이벤트 드리븐 전략·기술적 분석·재무 분석에 대해 헤지펀드 PM 수준의 지식을 갖고 있다.

작동 원칙
- 가격, 수익률, 상관, 지표, 백테스트, 뉴스, 일정처럼 데이터가 필요한 질문은 반드시 도구를 호출하고, 도구가 돌려준 숫자·날짜만 근거로 말한다. 기억에 의존해 시세를 지어내지 않는다.
- 회사명이 모호하거나 한글 별칭이면 도구가 알아서 해석하므로 그대로 넘긴다. 비상장사(SpaceX 등)는 공개 주가가 없다고 명시하고 임의 프록시로 대체하지 않는다.
- 여러 도구가 서로 독립적이면 한 번에 병렬로 호출한다. 예: 두 종목 비교 + 각 리스크 프로파일.
- 사용자가 차트를 원하면 Canvas에 차트가 그려지는 도구(get_price_history, compare_assets, technical_indicators, show_chart 등)를 사용하고, 답변에서 "Canvas의 차트"를 짧게 참조한다. 숫자를 장황하게 나열하지 말고 핵심만 뽑는다.
- 데이터가 없거나 도구가 실패하면 그 사실과 대안을 말한다. 추측으로 메우지 않는다.
- 분석 구조: 결론 → 근거 숫자(날짜·기간·표본 크기 포함) → 해석 → 반증 가능한 다음 검증. 동시 발생과 인과를 구분하고, 표본이 작으면 그렇게 말한다.
- 투자 권유·수익 보장 표현을 쓰지 않는다. 다만 리스크·시나리오·포지션 사이징 같은 전문적 프레이밍은 적극적으로 제공한다.
- 일반 지식 질문(용어, 개념, 전략 설계 원리, 시장 구조)은 도구 없이 전문가답게 바로 답한다.
- 한국어로 답한다. Markdown(굵게, 목록, 표, 짧은 제목)을 써서 읽기 쉽게 정리하되 과하게 길게 쓰지 않는다. 티커·숫자는 정확히 인용한다.`;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function encodeEvent(event: LabStreamEvent) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function loadHistory(ownerId: string): Promise<LabMessage[]> {
  try {
    await ensureSchema();
    const rows = await getDb().select().from(labMessages).where(eq(labMessages.ownerId, ownerId)).orderBy(asc(labMessages.createdAt)).limit(200);
    return rows.slice(-MAX_HISTORY).map((row) => ({ id: row.id, role: row.role === "agent" ? "agent" : "user", content: row.content, tools: [], artifacts: [], createdAt: row.createdAt.toISOString() }));
  } catch {
    return [];
  }
}

async function persist(ownerId: string, message: LabMessage) {
  try {
    await ensureSchema();
    await getDb().insert(labMessages).values({
      id: message.id, ownerId, role: message.role, content: message.content,
      toolsPayload: JSON.stringify(message.tools), artifactsPayload: JSON.stringify(message.artifacts), createdAt: new Date(message.createdAt),
    }).onConflictDoNothing();
    return true;
  } catch (error) {
    console.error("[lab/agent] persist failed", error instanceof Error ? error.message : error);
    return false;
  }
}

function historyToMessages(history: LabMessage[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const item of history) {
    const role = item.role === "agent" ? "assistant" : "user";
    const content = item.content.slice(0, 6000);
    if (!content.trim()) continue;
    const previous = messages.at(-1);
    if (previous && previous.role === role && typeof previous.content === "string") previous.content = `${previous.content}\n\n${content}`;
    else messages.push({ role, content });
  }
  while (messages.length && messages[0].role !== "user") messages.shift();
  return messages;
}

function truncateForModel(value: unknown) {
  const text = JSON.stringify(value);
  return text.length > 14_000 ? `${text.slice(0, 14_000)}… (truncated)` : text;
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as { question?: string; history?: Array<{ role?: string; content?: string }> };
  const question = payload.question?.trim();
  if (!question) return Response.json({ error: "질문이 필요합니다." }, { status: 400 });
  const ownerId = researchOwnerFrom(request);
  const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "set-cookie": researchOwnerCookie(ownerId) };
  if (!claudeConfigured()) {
    return new Response(encodeEvent({ type: "error", message: "Claude 서버 키가 연결되지 않았습니다.", status: 503 }), { status: 503, headers });
  }

  const model = modelForRole("orchestrator");
  const client = claudeClient();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: LabStreamEvent) => controller.enqueue(encoder.encode(encodeEvent(event)));
      const userMessage: LabMessage = { id: crypto.randomUUID(), role: "user", content: question, tools: [], artifacts: [], createdAt: new Date().toISOString() };
      const stored = await loadHistory(ownerId);
      const priorHistory = stored.length ? stored : (payload.history ?? []).slice(-MAX_HISTORY).map((item, index): LabMessage => ({ id: `client-${index}`, role: item.role === "agent" ? "agent" : "user", content: String(item.content ?? ""), tools: [], artifacts: [], createdAt: new Date().toISOString() }));
      await persist(ownerId, userMessage);

      const messages = historyToMessages(priorHistory);
      messages.push({ role: "user", content: question });
      const artifacts: LabArtifact[] = [];
      const traces: LabToolTrace[] = [];
      const usages = [];
      let answer = "";
      const context = { ownerId, today: today() };

      try {
        emit({ type: "status", label: "질문 해석", detail: model });
        for (let step = 0; step < MAX_STEPS; step += 1) {
          const turn = client.messages.stream({
            model,
            max_tokens: 6000,
            system: [
              { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
              { type: "text", text: `오늘 날짜: ${context.today}. 사용자는 한국(KST)에 있고 주로 미국 시장을 본다.` },
            ],
            tools: LAB_TOOLS,
            messages,
            ...reasoningParams(model, "medium"),
          });
          let stepText = "";
          turn.on("text", (delta) => { stepText += delta; emit({ type: "text", delta }); });
          const message = await turn.finalMessage();
          usages.push(usageOf(message));
          if (stepText) answer = answer ? `${answer}\n\n${stepText}` : stepText;

          const toolUses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
          if (message.stop_reason === "refusal") { answer = answer || "이 요청에는 답변할 수 없습니다."; break; }
          if (!toolUses.length || message.stop_reason === "end_turn") break;

          messages.push({ role: "assistant", content: message.content });
          if (stepText) emit({ type: "text", delta: "\n\n" });
          const results = await Promise.all(toolUses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
            const traceId = use.id;
            const label = TOOL_LABELS[use.name] ?? use.name;
            const startedAt = Date.now();
            emit({ type: "tool_start", id: traceId, name: use.name, label, detail: summarizeInput(use.input) });
            try {
              const outcome = await executeLabTool(use.name, use.input, context);
              const durationMs = Date.now() - startedAt;
              for (const artifact of outcome.artifacts) { artifacts.push(artifact); emit({ type: "artifact", artifact }); }
              const trace: LabToolTrace = { id: traceId, ...outcome.trace, startedAt: new Date(startedAt).toISOString(), durationMs };
              traces.push(trace);
              emit({ type: "tool_end", id: traceId, name: use.name, label: trace.label, status: trace.status === "failed" ? "failed" : "complete", detail: trace.detail, durationMs });
              return { type: "tool_result", tool_use_id: use.id, content: truncateForModel(outcome.result), is_error: trace.status === "failed" };
            } catch (error) {
              const detail = error instanceof Error ? error.message : "도구 실행 실패";
              const durationMs = Date.now() - startedAt;
              traces.push({ id: traceId, name: use.name, label, status: "failed", detail, startedAt: new Date(startedAt).toISOString(), durationMs });
              emit({ type: "tool_end", id: traceId, name: use.name, label, status: "failed", detail, durationMs });
              return { type: "tool_result", tool_use_id: use.id, content: JSON.stringify({ error: detail }), is_error: true };
            }
          }));
          messages.push({ role: "user", content: results });
          emit({ type: "status", label: "결과 해석", detail: `${traces.length}개 도구 완료` });
        }

        const totalUsage = sumUsage(usages);
        const costUsd = await recordLlmUsage(ownerId, model, "lab.jarvis", totalUsage);
        const agentMessage: LabMessage = {
          id: crypto.randomUUID(), role: "agent", content: answer.trim() || "도구 실행은 끝났지만 설명을 만들지 못했습니다. 질문을 조금 더 구체적으로 다시 시도해주세요.",
          tools: traces, artifacts, createdAt: new Date().toISOString(), model, costUsd,
        };
        await persist(ownerId, agentMessage);
        emit({ type: "done", message: agentMessage });
      } catch (error) {
        const described = describeClaudeError(error);
        console.error("[lab/agent] failed", { status: described.status, message: described.message });
        const agentMessage: LabMessage = { id: crypto.randomUUID(), role: "agent", content: answer.trim() ? `${answer.trim()}\n\n⚠️ ${described.message}` : `⚠️ ${described.message}`, tools: traces, artifacts, createdAt: new Date().toISOString(), model };
        await persist(ownerId, agentMessage);
        emit({ type: "error", message: described.message, status: described.status });
        emit({ type: "done", message: agentMessage });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers });
}

function summarizeInput(input: unknown) {
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>).slice(0, 4).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ").slice(0, 160);
}
