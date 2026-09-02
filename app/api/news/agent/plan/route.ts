import { env } from "cloudflare:workers";
import { MARKET_EVENT_CALENDAR } from "../../../../market-calendar-data";
import { callClaudeTool } from "@/lib/anthropic";
import { validateResearchPlan, type PlannerDraft } from "@/lib/news-agent-plan";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

type PlanPayload = {
  question?: string;
  today?: string;
  history?: Array<{ role?: string; content?: string }>;
  testCount?: number;
};

const plannerSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["research_pipeline", "analyze_existing", "answer", "clarify"] },
    eventRoot: { anyOf: [{ type: "string", enum: ["cpi", "pce", "ppi", "nfp", "fomc", "gdp", "ism-manufacturing", "ism-services"] }, { type: "null" }] },
    requestedSteps: {
      type: "array",
      items: { type: "string", enum: ["retrieve_news", "score_sentiment", "persist_test", "compare_tests", "find_patterns", "build_strategy", "run_backtest"] },
    },
    goal: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["mode", "eventRoot", "requestedSteps", "goal", "confidence"],
} satisfies Record<string, unknown>;

export async function POST(request: Request) {
  const payload = await request.json() as PlanPayload;
  const question = payload.question?.trim();
  const today = /^20\d{2}-\d{2}-\d{2}$/.test(payload.today ?? "") ? payload.today! : new Date().toISOString().slice(0, 10);
  if (!question) return Response.json({ error: "계획할 질문이 없습니다." }, { status: 400 });

  const ownerId = researchOwnerFrom(request);
  const runtimeEnv = env as unknown as Record<string, string | undefined>;
  const apiKey = runtimeEnv.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const model = runtimeEnv.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  const history = (payload.history ?? []).slice(-8).map((item) => ({
    role: item.role === "agent" ? "assistant" : "user",
    content: String(item.content ?? "").slice(0, 1000),
  }));
  console.log("[news/agent/plan] start", { question, today, historyItems: history.length, testCount: payload.testCount ?? 0 });

  let draft: PlannerDraft = {};
  let planner: "llm+validator" | "deterministic_fallback" = "deterministic_fallback";
  if (apiKey) {
    try {
      const result = await callClaudeTool<PlannerDraft>({
        apiKey,
        model,
        ownerId,
        feature: "news.request_planner",
        maxTokens: 700,
        tool: {
          name: "submit_research_plan",
          description: "Submit the user's intended research action. Do not execute it and do not answer the research question.",
          inputSchema: plannerSchema,
        },
        prompt: `You are only the request planner for News JARVIS. Convert the latest Korean or English request into an execution intent. Respect exact time expressions such as 최근 1년간, 12개월, 올해, or explicit dates; never replace them with a default. A chain like news retrieval → LLM analysis → Test comparison is research_pipeline. If the latest request is a follow-up, use conversation history to resolve references. Do not provide a canned answer.\nToday: ${today}\nSaved Test count: ${payload.testCount ?? 0}\nConversation: ${JSON.stringify(history)}\nLatest request: ${question}`,
      });
      draft = result.input;
      planner = "llm+validator";
    } catch (error) {
      console.error("[news/agent/plan] planner fallback", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const plan = validateResearchPlan(question, today, draft);
  const events = plan.mode === "research_pipeline" && plan.range && plan.eventRoot
    ? MARKET_EVENT_CALENDAR.filter((event) => event.id.startsWith(`${plan.eventRoot}-`) && event.date >= plan.range!.from && event.date <= plan.range!.to)
    : [];
  const available = plan.eventRoot ? MARKET_EVENT_CALENDAR.filter((event) => event.id.startsWith(`${plan.eventRoot}-`)) : [];
  const availableFrom = available[0]?.date ?? null;
  const availableTo = available.at(-1)?.date ?? null;
  const coverageComplete = !plan.range || !availableFrom || plan.range.from >= availableFrom;
  const coverageWarning = plan.range && !coverageComplete
    ? `${plan.eventLabel} 일정은 ${availableFrom}부터 등록되어 요청 시작일 ${plan.range.from} 이전 구간은 실행할 수 없습니다.`
    : null;
  console.log("[news/agent/plan] resolved", {
    planner, mode: plan.mode, eventRoot: plan.eventRoot, range: plan.range, requestedSteps: plan.requestedSteps,
    eventCount: events.length, coverageComplete,
  });
  return Response.json({
    plan,
    planner,
    events,
    coverage: { complete: coverageComplete, availableFrom, availableTo, warning: coverageWarning },
  }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
}
