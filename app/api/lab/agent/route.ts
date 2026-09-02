import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { labMessages } from "@/db/schema";
import { claudeClient, claudeConfigured, describeClaudeError, generateStructured, modelForRole, reasoningParams, sumUsage, usageOf } from "@/lib/claude";
import { touchConversation, validConversationId } from "@/lib/conversations";
import { executeLabTool, LAB_TOOLS, TOOL_LABELS } from "@/lib/lab-tools";
import type { LabArtifact, LabMessage, LabStreamEvent, LabToolTrace } from "@/lib/lab-types";
import { recordLlmUsage } from "@/lib/llm-usage";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { resolveSymbols, type ResolvedSymbol } from "@/lib/symbols";

const MAX_STEPS = 10;
const MAX_HISTORY = 24;

const SYSTEM_PROMPT = `당신은 QQuant Lab의 JARVIS다. 사용자의 개인 퀀트 리서치 데스크를 운영하는 수석 포트폴리오 매니저이자 퀀트 리서처로서, 주식·ETF·지수·매크로·파생·리스크 관리·팩터 투자·이벤트 드리븐 전략·기술적 분석·재무 분석에 대해 헤지펀드 PM 수준의 지식을 갖고 있다.

지식의 한계와 사실 확인
- 당신의 학습 데이터는 오래됐다. 상장 여부, IPO, 티커, 합병, 상호 변경, 현재가, 최근 사건에 대한 기억은 틀렸을 수 있다고 전제한다. "비상장이다", "그런 티커는 없다" 같은 단정은 절대 기억으로 하지 않는다.
- 회사·자산이 언급되면 먼저 도구로 현재 상태를 확인한다. 시스템이 미리 확인한 "검증된 종목" 블록이 있으면 그것을 사실로 삼는다. 검증 결과가 미확인이면 "현재 데이터 소스에서 확인하지 못했다"고 말하고 web_search로 최신 정보를 찾는다.
- 학습 이후의 사건(최근 뉴스, 신규 상장, 실적, 정책)이 관련되면 web_search를 사용해 확인하고 출처를 밝힌다.

작동 원칙
- 가격, 수익률, 상관, 지표, 백테스트, 뉴스, 일정처럼 데이터가 필요한 질문은 반드시 도구를 호출하고, 도구가 돌려준 숫자·날짜만 근거로 말한다.
- 도구가 필요한 질문은 설명을 먼저 쓰지 말고 도구를 우선 호출한 다음, 모든 결과가 모인 뒤 최종 답변을 작성한다.
- 여러 도구가 서로 독립적이면 한 번에 병렬로 호출한다.
- 사용자가 차트를 원하면 Canvas에 차트가 그려지는 도구(get_price_history, compare_assets, technical_indicators, show_chart 등)를 사용하고 답변에서 짧게 참조한다. 숫자를 장황하게 나열하지 말고 핵심만 뽑는다.
- 데이터가 없거나 도구가 실패하면 그 사실과 대안을 말한다. 추측으로 메우지 않는다.
- 분석 구조: 결론 → 근거 숫자(날짜·기간·표본 크기 포함) → 해석 → 반증 가능한 다음 검증. 동시 발생과 인과를 구분하고, 표본이 작으면 그렇게 말한다.
- 투자 권유·수익 보장 표현을 쓰지 않는다. 리스크·시나리오·포지션 사이징 같은 전문적 프레이밍은 적극적으로 제공한다.
- 일반 지식 질문(용어, 개념, 전략 설계 원리, 시장 구조)은 도구 없이 전문가답게 바로 답한다.

전략과 Backtest 연동 (탑다운 원칙)
- 사용자가 전략을 만들어 달라고 하거나 대화가 매매 규칙으로 수렴하면, 바텀업으로 지표를 조합하지 말고 탑다운으로 간다: (1) 거시·구조적 논제 thesis → (2) 초과수익이 생기는 메커니즘 → (3) 규칙이 맞다면 관측될 예측 → (4) 어떤 결과가 나오면 기각할지 falsification → (5) 그제서야 기계적 entry/exit 규칙과 통과 기준(successCriteria).
- 그 내용으로 propose_strategy를 호출해 Canvas에 전략 카드를 만든 뒤, "Backtest에 저장할까요?"라고 짧게 묻는다. 사용자가 동의하면 save_strategy(runNow=true 권장)를 호출한다. 동의 없이 저장하지 않는다.
- 백테스트 결과는 통과/기각 판정과 아웃오브샘플·교란 견고성을 반드시 언급하고, 과최적화·생존편향·소표본을 경고한다. 통과한 전략은 "시그널 후보"로 부르며 Backtest 화면에서 실거래 시그널을 확인할 수 있다고 안내한다.

- 한국어로 답한다. Markdown(굵게, 목록, 표, 짧은 제목)을 써서 읽기 쉽게 정리하되 과하게 길게 쓰지 않는다. 티커·숫자는 정확히 인용한다.`;

const WEB_SEARCH_TOOL = { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 4 };

const EntitySchema = z.object({
  entities: z.array(z.object({ mention: z.string(), kind: z.enum(["company", "ticker", "etf", "index", "crypto", "commodity", "other"]) })).max(10),
});

function today() {
  return new Date().toISOString().slice(0, 10);
}

function encodeEvent(event: LabStreamEvent) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// Some HTTP intermediaries buffer very small response chunks. A standards-safe
// SSE comment makes the first flush large enough for live phase events to reach
// the client before the model finishes.
const SSE_PREAMBLE = `: ${" ".repeat(2048)}\n\n`;

async function loadHistory(ownerId: string, conversationId: string): Promise<LabMessage[]> {
  try {
    await ensureSchema();
    const rows = await getDb().select().from(labMessages).where(and(eq(labMessages.ownerId, ownerId), eq(labMessages.conversationId, conversationId))).orderBy(asc(labMessages.createdAt)).limit(200);
    return rows.slice(-MAX_HISTORY).map((row) => ({ id: row.id, role: row.role === "agent" ? "agent" : "user", content: row.content, tools: [], artifacts: [], createdAt: row.createdAt.toISOString() }));
  } catch {
    return [];
  }
}

async function persist(ownerId: string, conversationId: string, message: LabMessage) {
  try {
    await ensureSchema();
    await getDb().insert(labMessages).values({
      id: message.id, ownerId, conversationId, role: message.role, content: message.content,
      toolsPayload: JSON.stringify(message.tools), artifactsPayload: JSON.stringify(message.artifacts), createdAt: new Date(message.createdAt),
    }).onConflictDoNothing();
    await touchConversation(ownerId, "lab", conversationId, { titleSeed: message.role === "user" ? message.content : undefined, preview: message.content, increment: 1 });
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

/**
 * Grounding pass: a cheap model lists the assets the question mentions, and the
 * live resolver checks each one *before* the frontier model reasons. This is what
 * stops the agent from asserting stale facts such as "SpaceX is private".
 */
async function groundEntities(question: string, ownerId: string) {
  try {
    const { data } = await generateStructured({
      role: "router", schema: EntitySchema, ownerId, feature: "lab.entity_grounding", maxTokens: 400, effort: "low",
      system: "Extract every company, ticker, ETF, index, crypto asset or commodity the user's message refers to, in the user's own words (Korean or English). Return an empty list when none are mentioned. Never answer the question.",
      prompt: question,
    });
    const mentions = [...new Set(data.entities.map((entity) => entity.mention.trim()).filter((mention) => mention.length > 0 && mention.length < 60))].slice(0, 8);
    if (!mentions.length) return [];
    return await resolveSymbols(mentions);
  } catch (error) {
    console.error("[lab/agent] grounding skipped", error instanceof Error ? error.message : error);
    return [];
  }
}

function describeGrounding(resolved: ResolvedSymbol[]) {
  if (!resolved.length) return null;
  const lines = resolved.map((item) => item.public && item.symbol
    ? `- "${item.input}" → ${item.symbol} (${item.name}${item.exchange ? `, ${item.exchange}` : ""}) · 상장 상태: ${item.listingStatus === "listed" ? "상장 확인" : "후보"}${item.listingDate ? ` · 상장일 ${item.listingDate}` : ""} · 출처 ${item.source} (${item.checkedAt.slice(0, 16)}Z)`
    : `- "${item.input}" → 현재 데이터 소스에서 거래 가능 종목으로 확인되지 않음 (비상장으로 단정 금지; 필요하면 web_search로 확인)`);
  return `검증된 종목 (라이브 시장 메타데이터, 학습 기억보다 우선):\n${lines.join("\n")}`;
}

function summarizeInput(input: unknown) {
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>).slice(0, 4).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : typeof value === "object" ? JSON.stringify(value).slice(0, 80) : String(value)}`).join(" · ").slice(0, 160);
}

function webSearchArtifacts(message: Anthropic.Message): LabArtifact[] {
  const artifacts: LabArtifact[] = [];
  let lastQuery = "웹 검색";
  for (const block of message.content) {
    if (block.type === "server_tool_use" && block.name === "web_search") lastQuery = typeof (block.input as { query?: string })?.query === "string" ? (block.input as { query: string }).query : lastQuery;
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      const results = block.content.filter((item): item is Anthropic.WebSearchResultBlock => item.type === "web_search_result").slice(0, 8).map((item) => ({ title: item.title, url: item.url, snippet: item.page_age ? `${item.page_age}` : "" }));
      if (results.length) artifacts.push({ id: crypto.randomUUID(), type: "web-search", title: `웹 검색 · ${lastQuery}`, query: lastQuery, results, notes: ["Anthropic web search · 출처는 답변에서 인용"] });
    }
  }
  return artifacts;
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as { question?: string; conversationId?: string; history?: Array<{ role?: string; content?: string }> };
  const question = payload.question?.trim();
  if (!question) return Response.json({ error: "질문이 필요합니다." }, { status: 400 });
  const ownerId = researchOwnerFrom(request);
  const conversationId = validConversationId(payload.conversationId) ? payload.conversationId : crypto.randomUUID();
  const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store, no-transform", "x-accel-buffering": "no", connection: "keep-alive", "set-cookie": researchOwnerCookie(ownerId) };
  if (!claudeConfigured()) {
    return new Response(encodeEvent({ type: "error", message: "Claude 서버 키가 연결되지 않았습니다.", status: 503 }), { status: 503, headers });
  }

  const model = modelForRole("orchestrator");
  const client = claudeClient();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(SSE_PREAMBLE));
      void (async () => {
      const emit = (event: LabStreamEvent) => controller.enqueue(encoder.encode(encodeEvent(event)));
      const userMessage: LabMessage = { id: crypto.randomUUID(), role: "user", content: question, tools: [], artifacts: [], createdAt: new Date().toISOString() };
      emit({ type: "status", phase: "connecting", label: "요청 접수 완료", detail: "JARVIS 실행 세션을 열고 질문을 전달했습니다." });
      emit({ type: "status", phase: "grounding", label: "종목 사실 확인", detail: "라이브 시장 데이터로 검증 중" });
      const [stored, grounded] = await Promise.all([loadHistory(ownerId, conversationId), groundEntities(question, ownerId)]);
      const priorHistory = stored.length ? stored : (payload.history ?? []).slice(-MAX_HISTORY).map((item, index): LabMessage => ({ id: `client-${index}`, role: item.role === "agent" ? "agent" : "user", content: String(item.content ?? ""), tools: [], artifacts: [], createdAt: new Date().toISOString() }));
      await persist(ownerId, conversationId, userMessage);
      const grounding = describeGrounding(grounded);
      if (grounded.length) emit({ type: "status", phase: "grounding", label: "종목 확인 완료", detail: grounded.map((item) => item.symbol ? `${item.input}→${item.symbol}` : `${item.input}: 미확인`).join(", ") });

      const messages = historyToMessages(priorHistory);
      messages.push({ role: "user", content: grounding ? `${question}\n\n[시스템 사전 검증]\n${grounding}` : question });
      const artifacts: LabArtifact[] = [];
      const traces: LabToolTrace[] = [];
      const usages = [];
      let answer = "";
      const context = { ownerId, today: today(), conversationId };

      try {
        emit({ type: "status", phase: "planning", label: "질문 해석·실행 계획", detail: "필요한 데이터와 분석 도구를 선택하고 있습니다." });
        for (let step = 0; step < MAX_STEPS; step += 1) {
          if (step > 0) emit({ type: "status", phase: "verifying", label: "도구 결과 검증·해석", detail: `${traces.length}개 실행 결과를 질문과 대조하고 있습니다.` });
          const turn = client.messages.stream({
            model,
            max_tokens: 6000,
            system: [
              { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
              { type: "text", text: `오늘 날짜: ${context.today}. 사용자는 한국(KST)에 있고 주로 미국 시장을 본다.` },
            ],
            tools: [...LAB_TOOLS, WEB_SEARCH_TOOL],
            messages,
            ...reasoningParams(model, "medium"),
          });
          let stepText = "";
          let writingStarted = false;
          turn.on("streamEvent", (event) => {
            if (event.type !== "content_block_start") return;
            if (event.content_block.type === "tool_use" || event.content_block.type === "server_tool_use") {
              const name = "name" in event.content_block ? event.content_block.name : "도구";
              emit({ type: "status", phase: "tools", label: `${TOOL_LABELS[name] ?? name} 준비`, detail: "분석에 필요한 입력값을 구성하고 있습니다." });
            } else if (event.content_block.type === "text" && !writingStarted) {
              writingStarted = true;
              emit({ type: "status", phase: "writing", label: "답변 작성 중", detail: "검증된 숫자와 근거를 읽기 쉬운 답변으로 정리하고 있습니다." });
            }
          });
          turn.on("text", (delta) => { stepText += delta; emit({ type: "text", delta }); });
          const message = await turn.finalMessage();
          usages.push(usageOf(message));
          if (stepText) answer = answer ? `${answer}\n\n${stepText}` : stepText;
          for (const artifact of webSearchArtifacts(message)) { artifacts.push(artifact); emit({ type: "artifact", artifact }); traces.push({ id: artifact.id, name: "web_search", label: "웹 검색", status: "complete", detail: artifact.type === "web-search" ? artifact.query : "" }); }

          if (message.stop_reason === "pause_turn") {
            // Server-side web search hit its iteration limit; resume with the same history.
            messages.push({ role: "assistant", content: message.content });
            emit({ type: "status", phase: "tools", label: "웹 검색 계속", detail: "추가 검색 결과를 수집하고 있습니다." });
            continue;
          }
          const toolUses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
          if (message.stop_reason === "refusal") { answer = answer || "이 요청에는 답변할 수 없습니다."; break; }
          if (!toolUses.length || message.stop_reason === "end_turn") {
            if (!writingStarted) emit({ type: "status", phase: "writing", label: "답변 마무리 중", detail: "최종 응답과 생성된 결과를 저장하고 있습니다." });
            break;
          }

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
          emit({ type: "status", phase: "verifying", label: "결과 종합", detail: `${traces.length}개 도구 결과를 교차 확인하고 있습니다.` });
        }

        const totalUsage = sumUsage(usages);
        const costUsd = await recordLlmUsage(ownerId, model, "lab.jarvis", totalUsage);
        const agentMessage: LabMessage = {
          id: crypto.randomUUID(), role: "agent", content: answer.trim() || "도구 실행은 끝났지만 설명을 만들지 못했습니다. 질문을 조금 더 구체적으로 다시 시도해주세요.",
          tools: traces, artifacts, createdAt: new Date().toISOString(), model, costUsd,
        };
        await persist(ownerId, conversationId, agentMessage);
        emit({ type: "done", message: agentMessage, conversationId });
      } catch (error) {
        const described = describeClaudeError(error);
        console.error("[lab/agent] failed", { status: described.status, message: described.message });
        const agentMessage: LabMessage = { id: crypto.randomUUID(), role: "agent", content: answer.trim() ? `${answer.trim()}\n\n⚠️ ${described.message}` : `⚠️ ${described.message}`, tools: traces, artifacts, createdAt: new Date().toISOString(), model };
        await persist(ownerId, conversationId, agentMessage);
        emit({ type: "error", message: described.message, status: described.status });
        emit({ type: "done", message: agentMessage, conversationId });
      } finally {
        controller.close();
      }
      })().catch((error) => {
        console.error("[lab/agent] stream failed before completion", error instanceof Error ? error.message : error);
        try { controller.error(error); } catch { /* stream is already closed */ }
      });
    },
  });
  return new Response(stream, { headers });
}
