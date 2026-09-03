import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { labMessages } from "@/db/schema";
import { claudeClient, claudeConfigured, describeClaudeError, generateStructured, modelForRole, reasoningParams, sumUsage, usageOf } from "@/lib/claude";
import { frontierProvider, openaiConfigured } from "@/lib/openai";
import { runLabOpenAiLoop } from "@/lib/lab-openai-loop";
import { touchConversation, validConversationId } from "@/lib/conversations";
import { describeFindingsForContext, rankFindingsForQuestion } from "@/lib/findings";
import { listFindings } from "@/lib/findings-store";
import { executeLabTool, LAB_TOOLS, TOOL_LABELS } from "@/lib/lab-tools";
import { compressToolResult } from "@/lib/lab-specialists";
import type { LabAgentPhase, LabArtifact, LabMessage, LabStreamEvent, LabToolTrace } from "@/lib/lab-types";
import { recordLlmUsage } from "@/lib/llm-usage";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { resolveSymbols, type ResolvedSymbol } from "@/lib/symbols";

const MAX_STEPS = 10;
const MAX_HISTORY = 24;

const SYSTEM_PROMPT = `당신은 QQuant Lab의 JARVIS다. 사용자의 개인 퀀트 리서치 데스크를 운영하는 수석 포트폴리오 매니저이자 퀀트 리서처로서, 주식·ETF·지수·매크로·파생·리스크 관리·팩터 투자·이벤트 드리븐 전략·기술적 분석·재무 분석에 대해 헤지펀드 PM 수준의 지식을 갖고 있다.

사용자의 실행 환경 (하드 제약)
- 사용자는 대한민국에서 Toss Securities를 통해 미국 주식·ETF를 매매한다. 모든 시간은 ET와 KST를 함께 적고 미국 서머타임을 반영한다.
- 기본 실행 가능 포지션은 Toss에서 매수 가능한 미국 주식·ETF의 long / 보유 / 청산 / 현금 대기다. 사용자가 해당 상품과 계좌 권한을 명시적으로 확인하기 전에는 공매도, 옵션, 선물, 마진, 레버리지·인버스 상품을 전략 규칙이나 대안으로 제안하지 않는다.
- 하락 신호는 기본적으로 신규 진입 보류, 보유 비중 축소, 청산 또는 현금 대기로 번역한다. long/short 백테스트가 수학적으로 가능하더라도 사용자가 실행할 수 없는 숏 전략으로 결론을 바꾸지 않는다.
- 현재 Toss 연동은 현재가·호가·최근 체결·장 시간 조회용이며 주문 전송은 연결되지 않았다. 따라서 실제 주문을 했다고 말하지 말고, 실행 가능한 주문 조건과 확인 시각을 제시한다.

지식의 한계와 사실 확인
- 당신의 학습 데이터는 오래됐다. 상장 여부, IPO, 티커, 합병, 상호 변경, 현재가, 최근 사건에 대한 기억은 틀렸을 수 있다고 전제한다. "비상장이다", "그런 티커는 없다" 같은 단정은 절대 기억으로 하지 않는다.
- 회사·자산이 언급되면 먼저 도구로 현재 상태를 확인한다. 시스템이 미리 확인한 "검증된 종목" 블록이 있으면 그것을 사실로 삼는다. 검증 결과가 미확인이면 "현재 데이터 소스에서 확인하지 못했다"고 말하고 web_search로 최신 정보를 찾는다.
- 학습 이후의 사건(최근 뉴스, 신규 상장, 실적, 정책)이 관련되면 web_search를 사용해 확인하고 출처를 밝힌다.

종목 발굴 (중요)
- 사용자가 종목을 특정하지 않고 "어떤 종목이", "~한 종목을 찾아줘", "가장 ~한", "상위/하위" 같이 물으면 screen_universe를 먼저 호출한다. 나머지 도구는 전부 종목을 이미 알고 있어야 동작하므로, 후보를 추측으로 나열하지 말고 스크리너로 뽑는다.
- 스크리너가 뽑은 상위 종목은 그 자체가 결론이 아니라 후보다. 필요하면 technical_indicators·risk_profile·event_study로 이어서 검증한다.
- 스크리너 유니버스는 고정 표본이라 지수의 실제 편입 종목과 다르고 상장폐지 종목이 빠져 있다. 결과를 보고할 때 이 한계를 한 줄로 명시한다.

가설 검증
- "A일 때 B가 일어나나?" 류의 질문은 단일 종목 event_study보다 conditional_stats를 우선한다. 여러 종목 표본을 풀링해 베이스라인과 비교하므로 표본 부족 문제를 피한다.
- 표본 수(n), 베이스라인 대비 초과분, 종목별 편차를 반드시 함께 보고한다. n이 작거나 초과분이 베이스라인과 구분되지 않으면 "차이가 없다"고 분명히 말한다. t값은 관측 구간이 겹치므로 참고용이라고 밝힌다.
- conditional_stats에서 유망한 결과(초과분 양수)가 나오면 그 한 칸을 결론으로 삼지 말고 sweep_conditions로 임계값·기간 그리드 전체를 확인한다. 인접 칸에서 무너지는 효과는 우연이다. 전략 규칙의 파라미터를 정하기 전에도 반드시 스윕한다.

전문가 위임 (중요)
- 당신은 오케스트레이터다. 판단 중 두 가지는 당신이 직접 하지 않고 위임한다.
- 자기 검증 금지: 방금 당신이 도출한 결론을 스스로 검토하면 동의하게 된다. 의미 있는 결론을 사용자에게 보고하기 직전, 그리고 save_finding으로 저장하기 직전에 audit_result를 호출해 독립된 감사관 모델에게 반증을 맡긴다. evidence에는 근거가 된 도구 결과를 그대로 넣는다.
- 감사 판정이 weakens/refutes/insufficient면 결론을 그대로 유지하지 말고 약화하거나 철회한다. 감사에서 나온 표본 적정성·교란 변수·결정적 검증을 답변에 반영한다. 감사가 지지(supports)했더라도 지적된 한계는 함께 전달한다.
- 그리드 스윕의 과최적화 판정도 분석가 모델이 sweep_conditions 안에서 수행한다. 그 판정(analystReading)을 무시하고 최고 성적 칸만 인용하지 않는다.
- 단순 조회(현재가, 차트, 일정)에는 위임하지 않는다. 위임은 결론을 주장할 때만 쓴다.

연구 노트 (누적)
- 도구로 검증된 의미 있는 결론에 도달하면 save_finding으로 저장할지 사용자에게 짧게 묻고, 동의하면 저장한다. claim에는 숫자와 기간을, evidence에는 어떤 도구가 어떤 값을 냈는지, falsification에는 이 결론을 버릴 조건을 적는다.
- 턴 시작 시 [기존 연구 노트] 블록이 주어지면 이미 검증된 내용은 다시 계산하지 말고 그 위에 쌓는다. 새 데이터가 기존 노트와 어긋나면 그 사실을 지적하고, 사용자 동의를 받아 해당 노트를 id와 함께 status=refuted로 갱신한다.

작동 원칙
- 가격, 수익률, 상관, 지표, 백테스트, 뉴스, 일정처럼 데이터가 필요한 질문은 반드시 도구를 호출하고, 도구가 돌려준 숫자·날짜만 근거로 말한다.
- 도구가 필요한 질문은 설명을 먼저 쓰지 말고 도구를 우선 호출한 다음, 모든 결과가 모인 뒤 최종 답변을 작성한다.
- 발표 전후 수분~수시간 반응을 묻는 질문은 날짜와 ET 시각을 market_calendar 또는 web_search로 확인한 뒤 intraday_event_study를 호출한다. 이 도구가 반환한 관측 가능/불가 행을 모두 보고하며, 장기 분봉 공급 범위를 임의 데이터로 메우지 않는다.
- 여러 도구가 서로 독립적이면 한 번에 병렬로 호출한다.
- 사용자가 차트를 원하면 Canvas에 차트가 그려지는 도구(get_price_history, compare_assets, technical_indicators, show_chart 등)를 사용하고 답변에서 짧게 참조한다. 숫자를 장황하게 나열하지 말고 핵심만 뽑는다.
- 데이터가 없거나 도구가 실패하면 그 사실과 대안을 말한다. 추측으로 메우지 않는다.
- 분석 구조: 결론 → 근거 숫자(날짜·기간·표본 크기 포함) → 해석 → 반증 가능한 다음 검증. 동시 발생과 인과를 구분하고, 표본이 작으면 그렇게 말한다.
- 수익을 보장하지 않는다. 그러나 "실거래 추천 불가", "소액·페이퍼만 가능" 같은 상투적 면책 문구를 제목이나 결론으로 삼지 않는다. 리스크는 전략을 끝내는 이유가 아니라 진입 조건·청산 조건·포지션 크기·기각 조건으로 수치화한다.
- 일반 지식 질문(용어, 개념, 전략 설계 원리, 시장 구조)은 도구 없이 전문가답게 바로 답한다.

대화 연속성과 전략 도출
- 매 턴을 단발성 상담으로 끝내지 않는다. 같은 대화의 이전 질문, 검증 결과, 사용자가 정한 제약을 현재 연구 상태로 이어받고 그 위에서 한 단계 전진한다.
- 사용자가 전략을 원하면 데이터가 완벽하지 않아도 현재 근거로 실행 가능한 "전략 초안 v0"을 먼저 제시한다. 초안에는 대상, long/flat 진입, 청산, 보유 기간, 거래 시각(ET/KST), 비용, 포지션 크기, 무효화 조건을 포함한다.
- 표본이 부족하면 대화를 중단하거나 일반론으로 회피하지 말고, 확인된 것과 미확인인 것을 분리한 뒤 지금 가능한 규칙과 다음 검증을 제시한다. 도구로 확인할 수 있는 것은 사용자에게 되묻지 말고 직접 확인한다.
- 답변의 마지막은 막연한 주의 문구가 아니라 다음 연구 행동이어야 한다. 사용자 선택이 정말 필요한 경우에만 초안을 제시한 뒤 한 가지 구체적인 질문을 한다.

이벤트 드리븐 (News → 전략 파이프라인)
- "지난 N년간 X 발표 전후에 어땠나" 류의 질문에는 event_reaction을 호출한다. 발표일마다 get_price_history를 반복 호출하지 않는다 — 그건 느리고 도중에 끊긴다.
- 이벤트의 실제치·서프라이즈 자체를 확인할 때는 market_events를 쓴다. market_calendar는 일정만 있고 값이 없다.
- market_events가 비어 있으면 사용자에게 POST /api/events 로 action=seed 를 보내 캘린더를 적재하고, action=backfill 과 root=cpi 로 FRED 실제치를 채우라고 안내한다.
- 실제치는 actualInitial(발표 당시 원본)과 actualRevised(이후 개정치)로 나뉜다. 과거 분석과 백테스트는 반드시 actualInitial 기준으로 말한다. 개정치를 쓰면 그날 아무도 몰랐던 숫자로 판단하는 것이다.
- 서프라이즈의 surpriseBasis를 반드시 확인하고 보고한다. consensus가 아니면 나이브 예측 대비 편차이며 실제 이코노미스트 서프라이즈보다 약한 신호다. 이 한계를 숨기지 않는다.
- 발견한 패턴을 전략으로 만들 때는 sessions_to_event / sessions_since_event / event_surprise 오퍼랜드에 event 루트를 넣어 propose_strategy를 호출한다. 그래야 News 발견이 백테스트 엔진에 올라간다.
- 1년치 월간 지표는 표본이 12개뿐이다. 이 사실을 반드시 말하고, 가능하면 기간을 늘리거나 여러 이벤트 루트를 함께 보도록 제안한다.

전략과 Backtest 연동 (탑다운 원칙)
- 사용자가 전략을 만들어 달라고 하거나 대화가 매매 규칙으로 수렴하면, 바텀업으로 지표를 조합하지 말고 탑다운으로 간다: (1) 거시·구조적 논제 thesis → (2) 초과수익이 생기는 메커니즘 → (3) 규칙이 맞다면 관측될 예측 → (4) 어떤 결과가 나오면 기각할지 falsification → (5) 그제서야 기계적 entry/exit 규칙과 통과 기준(successCriteria).
- 그 내용으로 propose_strategy를 호출해 Canvas에 전략 카드를 만든 뒤, "Backtest에 저장할까요?"라고 짧게 묻는다. 사용자가 동의하면 save_strategy(runNow=true 권장)를 호출한다. 동의 없이 저장하지 않는다.
- 백테스트 결과는 통과/기각 판정과 아웃오브샘플·교란 견고성을 반드시 언급하고, 과최적화·생존편향·소표본을 경고한다. 통과한 전략은 "시그널 후보"로 부르며 Backtest 화면에서 실거래 시그널을 확인할 수 있다고 안내한다.
- 통과 기준(successCriteria)은 시스템이 최소 바닥값을 강제한다. 작성자가 조일 수는 있어도 풀 수는 없고, 조정이 걸리면 사양 notes에 남는다. 그 조정 내역이 있으면 사용자에게 알린다.
- 연구 노트에서 출발한 전략이면 save_strategy/propose_strategy에 sourceFindingId를 넣어 혈통을 남긴다.
- 사용자가 운용 전 검증을 원하면 페이퍼 트레이딩을 선택지로 제공할 수 있다. POST /api/strategies/signals 에 전략 id와 record=true 를 보내면 시그널이 원장에 기록되고 매일 시가평가된다. 다만 페이퍼 트레이딩을 모든 답변의 상투적인 최종 결론으로 강요하지 않는다.

- 한국어로 답한다. Markdown(굵게, 목록, 표, 짧은 제목)을 써서 읽기 쉽게 정리하되 과하게 길게 쓰지 않는다. 티커·숫자는 정확히 인용한다.`;

const WEB_SEARCH_TOOL = { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 4 };

const EntitySchema = z.object({
  entities: z.array(z.object({ mention: z.string(), kind: z.enum(["company", "ticker", "etf", "index", "crypto", "commodity", "other"]) })).max(10),
});

function today() {
  return new Date().toISOString().slice(0, 10);
}

function encodeEvent(event: LabStreamEvent) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  // Control frames are deliberately padded. Sites/edge intermediaries may
  // buffer tiny chunks even with no-transform; text deltas stay unpadded.
  return event.type === "text" ? frame : `${frame}: ${" ".repeat(2048)}\n\n`;
}

// Some HTTP intermediaries buffer very small response chunks. A standards-safe
// SSE comment makes the first flush large enough for live phase events to reach
// the client before the model finishes.
const SSE_PREAMBLE = `: ${" ".repeat(8192)}\n\n`;

function executionContext(date: string) {
  return `오늘 날짜: ${date}. 사용자는 대한민국(KST)에서 Toss Securities로 미국 주식·ETF를 거래한다. 기본 전략 제약은 long/보유/청산/현금이며 공매도·옵션·선물·마진은 사용자가 명시적으로 가능하다고 말하기 전까지 제외한다. Toss 연결은 시세 조회 전용이고 주문 API는 아직 연결되지 않았다.`;
}

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

const TOOL_RESULT_LIMIT = 14_000;

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
  const payload = await request.json().catch(() => ({})) as { question?: string; conversationId?: string; userMessageId?: string; history?: Array<{ role?: string; content?: string }> };
  const question = payload.question?.trim();
  if (!question) return Response.json({ error: "질문이 필요합니다." }, { status: 400 });
  const ownerId = researchOwnerFrom(request);
  const conversationId = validConversationId(payload.conversationId) ? payload.conversationId : crypto.randomUUID();
  const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store, no-transform", "x-accel-buffering": "no", connection: "keep-alive", "set-cookie": researchOwnerCookie(ownerId) };
  const useOpenAiFrontier = frontierProvider() === "openai";
  if (useOpenAiFrontier && !openaiConfigured()) {
    return new Response(encodeEvent({ type: "error", message: "OpenAI 서버 키가 연결되지 않았습니다.", status: 503 }), { status: 503, headers });
  }
  // The grounding pass and non-frontier roles still need Anthropic; on OpenAI-frontier
  // mode a missing Anthropic key degrades grounding to a no-op rather than failing the turn.
  if (!claudeConfigured() && !useOpenAiFrontier) {
    return new Response(encodeEvent({ type: "error", message: "Claude 서버 키가 연결되지 않았습니다.", status: 503 }), { status: 503, headers });
  }

  let model = modelForRole("orchestrator");
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(SSE_PREAMBLE));
      const startedAt = Date.now();
      const activeToolIds = new Set<string>();
      let progress: { phase: LabAgentPhase; label: string; detail: string } = { phase: "connecting", label: "요청 접수 중", detail: "대화와 실행 세션을 준비하고 있습니다." };
      const emit = (event: LabStreamEvent) => {
        if (event.type === "status") progress = { phase: event.phase, label: event.label, detail: event.detail ?? "" };
        else if (event.type === "tool_start") {
          activeToolIds.add(event.id);
          progress = { phase: "tools", label: `${event.label} 실행 중`, detail: event.detail || "데이터를 불러오고 계산하고 있습니다." };
        } else if (event.type === "tool_end") {
          activeToolIds.delete(event.id);
          progress = activeToolIds.size
            ? { phase: "tools", label: `데이터 도구 ${activeToolIds.size}개 실행 중`, detail: "완료된 결과부터 검증하면서 나머지 계산을 기다립니다." }
            : { phase: "verifying", label: `${event.label} 결과 검증`, detail: event.detail };
        }
        controller.enqueue(encoder.encode(encodeEvent(event)));
      };
      const heartbeat = setInterval(() => emit({ type: "heartbeat", ...progress, elapsedMs: Date.now() - startedAt }), 4_000);
      void (async () => {
      const userMessage: LabMessage = { id: validConversationId(payload.userMessageId) ? payload.userMessageId : crypto.randomUUID(), role: "user", content: question, tools: [], artifacts: [], createdAt: new Date().toISOString() };
      emit({ type: "status", phase: "connecting", label: "요청 접수 완료", detail: "JARVIS 실행 세션을 열고 질문을 전달했습니다." });
      const userSaved = await persist(ownerId, conversationId, userMessage);
      emit({ type: "status", phase: "grounding", label: userSaved ? "대화 저장·컨텍스트 확인" : "컨텍스트 확인", detail: userSaved ? "질문을 저장했고 종목·이전 대화·연구 노트를 확인합니다." : "저장소 연결은 확인이 필요하지만 현재 분석은 계속합니다." });
      const [stored, grounded, notes] = await Promise.all([
        loadHistory(ownerId, conversationId),
        groundEntities(question, ownerId),
        // Prior conclusions carry into every turn; a findings-table failure must
        // not fail the turn, so an unavailable store degrades to no notes.
        listFindings(ownerId, 40).catch(() => []),
      ]);
      const storedBeforeQuestion = stored.filter((message) => message.id !== userMessage.id);
      const priorHistory = storedBeforeQuestion.length ? storedBeforeQuestion : (payload.history ?? []).slice(-MAX_HISTORY).map((item, index): LabMessage => ({ id: `client-${index}`, role: item.role === "agent" ? "agent" : "user", content: String(item.content ?? ""), tools: [], artifacts: [], createdAt: new Date().toISOString() }));
      const grounding = describeGrounding(grounded);
      if (grounded.length) emit({ type: "status", phase: "grounding", label: "종목 확인 완료", detail: grounded.map((item) => item.symbol ? `${item.input}→${item.symbol}` : `${item.input}: 미확인`).join(", ") });

      const relevantNotes = notes.length ? rankFindingsForQuestion(notes, question, 5) : [];
      const notesBlock = describeFindingsForContext(relevantNotes);
      if (relevantNotes.length) emit({ type: "status", phase: "grounding", label: "연구 노트 참조", detail: `${relevantNotes.length}건의 기존 결론을 컨텍스트에 넣었습니다.` });

      const messages = historyToMessages(priorHistory);
      const contextBlocks = [
        grounding ? `[시스템 사전 검증]\n${grounding}` : null,
        notesBlock ? `[기존 연구 노트 · 이미 검증된 결론이므로 재계산하지 말고 이 위에 쌓을 것]\n${notesBlock}` : null,
      ].filter(Boolean);
      messages.push({ role: "user", content: contextBlocks.length ? `${question}\n\n${contextBlocks.join("\n\n")}` : question });
      const artifacts: LabArtifact[] = [];
      const traces: LabToolTrace[] = [];
      const usages = [];
      let answer = "";
      const context = { ownerId, today: today(), conversationId };

      try {
        if (useOpenAiFrontier) {
          const result = await runLabOpenAiLoop({
            emit,
            initialMessages: messages.map((message): { role: "user" | "assistant"; content: string } => ({
              role: message.role === "assistant" ? "assistant" : "user",
              content: typeof message.content === "string" ? message.content : "",
            })).filter((message) => message.content.trim()),
            instructions: `${SYSTEM_PROMPT}\n\n${executionContext(context.today)}`,
            context,
            artifacts,
            traces,
            maxSteps: MAX_STEPS,
          });
          answer = result.answer;
          for (const item of result.usages) usages.push(item);
          model = result.model;
        } else {
        const client = claudeClient();
        emit({ type: "status", phase: "planning", label: "질문 해석·실행 계획", detail: "필요한 데이터와 분석 도구를 선택하고 있습니다." });
        for (let step = 0; step < MAX_STEPS; step += 1) {
          if (step > 0) emit({ type: "status", phase: "verifying", label: "도구 결과 검증·해석", detail: `${traces.length}개 실행 결과를 질문과 대조하고 있습니다.` });
          const turn = client.messages.stream({
            model,
            max_tokens: 6000,
            system: [
              { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
              { type: "text", text: executionContext(context.today) },
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
              return { type: "tool_result", tool_use_id: use.id, content: await compressToolResult(use.name, outcome.result, ownerId, TOOL_RESULT_LIMIT), is_error: trace.status === "failed" };
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
        }

        const totalUsage = sumUsage(usages);
        const costUsd = await recordLlmUsage(ownerId, model, "lab.jarvis", totalUsage, useOpenAiFrontier ? "OpenAI" : "Anthropic", "orchestrator");
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
        clearInterval(heartbeat);
        controller.close();
      }
      })().catch((error) => {
        clearInterval(heartbeat);
        console.error("[lab/agent] stream failed before completion", error instanceof Error ? error.message : error);
        try { controller.error(error); } catch { /* stream is already closed */ }
      });
    },
  });
  return new Response(stream, { headers });
}
