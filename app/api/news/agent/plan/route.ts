import { z } from "zod";
import { MARKET_EVENT_CALENDAR } from "@/app/market-calendar-data";
import { claudeConfigured, generateStructured } from "@/lib/claude";
import { validateResearchPlan, type PlannerDraft } from "@/lib/news-agent-plan";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

type PlanPayload = {
  question?: string;
  today?: string;
  history?: Array<{ role?: string; content?: string }>;
  testCount?: number;
};

const PlannerSchema = z.object({
  mode: z.enum(["research_pipeline", "analyze_existing", "answer", "clarify"]),
  eventRoot: z.enum(["cpi", "pce", "ppi", "nfp", "fomc", "gdp", "ism-manufacturing", "ism-services"]).nullable(),
  requestedSteps: z.array(z.enum(["retrieve_news", "score_sentiment", "persist_test", "compare_tests", "find_patterns", "build_strategy", "run_backtest"])),
  goal: z.string().describe("one-sentence restatement of what the user wants, in Korean"),
  confidence: z.number().min(0).max(1),
});

const SYSTEM = `You are the request planner for News JARVIS, a workspace that studies how pre-release economic news sentiment relates to realized US index moves.

Convert the latest Korean or English request into an execution intent:
- research_pipeline: the user wants new work done on scheduled releases (collect pre-release news → score sentiment → save Test rows → compare). Requires an event type and a time range; if either is missing, choose clarify.
- analyze_existing: the user wants patterns, strategies, or backtests from Test rows that already exist.
- answer: a question about the current news selection, the current sentiment analysis, saved Tests, market reactions, or general macro/market knowledge.
- clarify: only when the request cannot be executed without more information.
Respect exact time expressions (최근 1년간, 12개월, 올해, explicit dates) — never substitute a default. Resolve follow-up references from the conversation history. Do not answer the research question itself.`;

export async function POST(request: Request) {
  const payload = await request.json() as PlanPayload;
  const question = payload.question?.trim();
  const today = /^20\d{2}-\d{2}-\d{2}$/.test(payload.today ?? "") ? payload.today! : new Date().toISOString().slice(0, 10);
  if (!question) return Response.json({ error: "계획할 질문이 없습니다." }, { status: 400 });

  const ownerId = researchOwnerFrom(request);
  const history = (payload.history ?? []).slice(-8).map((item) => ({ role: item.role === "agent" ? "assistant" : "user", content: String(item.content ?? "").slice(0, 1000) }));

  let draft: PlannerDraft = {};
  let planner: "llm+validator" | "deterministic_fallback" = "deterministic_fallback";
  if (claudeConfigured()) {
    try {
      const result = await generateStructured({
        role: "planner", schema: PlannerSchema, system: SYSTEM, ownerId, feature: "news.request_planner", maxTokens: 800, effort: "low",
        prompt: `Today: ${today}\nSaved Test count: ${payload.testCount ?? 0}\nConversation: ${JSON.stringify(history)}\nLatest request: ${question}`,
      });
      draft = result.data;
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
  const coverageWarning = plan.range && !coverageComplete ? `${plan.eventLabel} 일정은 ${availableFrom}부터 등록되어 요청 시작일 ${plan.range.from} 이전 구간은 실행할 수 없습니다.` : null;
  console.log("[news/agent/plan] resolved", { planner, mode: plan.mode, eventRoot: plan.eventRoot, range: plan.range, requestedSteps: plan.requestedSteps, eventCount: events.length });
  return Response.json({ plan, planner, events, coverage: { complete: coverageComplete, availableFrom, availableTo, warning: coverageWarning } }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
}
