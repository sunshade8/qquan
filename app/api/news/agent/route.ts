import { env } from "cloudflare:workers";
import { callClaude, ClaudeApiError } from "@/lib/anthropic";
import { deterministicTestSummary, runDeterministicEventBacktest, type ResearchTest } from "@/lib/news-research-agents";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { fetchYahooEventWindow, type EventWindow } from "../../../../lib/market-data";

type AgentPayload = {
  question?: string;
  context?: { retrieved?: unknown; headlines?: unknown[]; analysis?: unknown; tests?: unknown[] };
};

function nestedDate(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const date = (value as Record<string, unknown>)[key];
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function requestedEventDate(question: string, context: AgentPayload["context"]) {
  const explicit = question.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (explicit) return `${explicit[1]}-${explicit[2].padStart(2, "0")}-${explicit[3].padStart(2, "0")}`;
  const headlines = Array.isArray(context?.headlines) ? context.headlines : [];
  const headlineDate = headlines.map((item) => nestedDate(item, "eventDate")).find(Boolean) ?? null;
  const analysis = context?.analysis && typeof context.analysis === "object" && "analysis" in context.analysis ? context.analysis.analysis : context?.analysis;
  const forecastEvents = analysis && typeof analysis === "object" && "forecastEvents" in analysis && Array.isArray(analysis.forecastEvents) ? analysis.forecastEvents : [];
  const forecastDate = forecastEvents.map((item) => nestedDate(item, "scheduledReleaseDate")).find(Boolean) ?? null;
  const retrieved = context?.retrieved;
  const end = retrieved && typeof retrieved === "object" && "end" in retrieved && typeof retrieved.end === "string" ? retrieved.end : null;
  const korean = question.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (korean && end) return `${end.slice(0, 4)}-${korean[1].padStart(2, "0")}-${korean[2].padStart(2, "0")}`;
  return forecastDate ?? headlineDate ?? (end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : null);
}

function validTests(value: unknown[] | undefined): ResearchTest[] {
  return (value ?? []).filter((item): item is ResearchTest => Boolean(
    item && typeof item === "object" && "id" in item && "periodStart" in item && "periodEnd" in item && "overallScore" in item
  )).slice(-100);
}

function intentOf(question: string) {
  const pattern = /공통점|공통|패턴|유사성|반복|일관|similar|pattern/i.test(question);
  const strategy = /투자\s*전략|매매\s*전략|진입|청산|포지션|strategy/i.test(question);
  const backtest = /백테스트|성과|수익률|검증\s*결과|backtest/i.test(question);
  const full = /최종\s*결과|끝까지|jarvis|전\s*과정|전체\s*연구/i.test(question);
  if (backtest || full) return "backtest" as const;
  if (strategy) return "strategy" as const;
  if (pattern) return "patterns" as const;
  return "answer" as const;
}

function scopedTestsForQuestion(question: string, tests: ResearchTest[]) {
  const dates = [...question.matchAll(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/g)].map((match) => match[0].replaceAll(/[/.]/g, "-").split("-").map((part, index) => index ? part.padStart(2, "0") : part).join("-"));
  if (dates.length < 2) return tests;
  const [from, to] = dates[0] <= dates[1] ? [dates[0], dates[1]] : [dates[1], dates[0]];
  return tests.filter((test) => {
    const eventDate = test.forecastEvents?.[0]?.scheduledReleaseDate ?? test.periodEnd;
    return eventDate && eventDate >= from && eventDate <= to;
  });
}

function requestedHoldingSessions(question: string) {
  const match = question.match(/(\d{1,2})\s*(?:거래일|일)\s*(?:보유|홀드|holding|hold)/i);
  return Math.min(20, Math.max(1, Number(match?.[1] ?? 3)));
}

const hardRules = `Hard rules:
- Use only supplied headlines, saved Test rows, and deterministic market calculations. Never invent article contents, prices, forecasts, or actual releases.
- Keep the timeline strict: publication cutoff → ex-ante sentiment → scheduled release → ex-post return.
- Treat the deterministic summary's analysisAsOfDate as today's date. An event is future only when its eventDate is later than analysisAsOfDate.
- Association is not causation. Surface sample size, event overlap, timing, headline-only evidence, and look-ahead risks.
- Do not present this as personalized financial advice or guarantee a return.`;

export async function POST(request: Request) {
  const payload = await request.json() as AgentPayload;
  const question = payload.question?.trim();
  if (!question) return Response.json({ error: "Agent에게 물어볼 내용을 입력해주세요." }, { status: 400 });

  const runtimeEnv = env as unknown as Record<string, string | undefined>;
  const apiKey = runtimeEnv.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const model = runtimeEnv.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  if (!apiKey) return Response.json({ error: "Claude 서버 키가 연결되지 않았습니다." }, { status: 503 });
  const ownerId = researchOwnerFrom(request);
  const context = payload.context ?? {};
  const tests = validTests(context.tests);
  const scopedTests = scopedTestsForQuestion(question, tests);
  const intent = intentOf(question);
  const specialists: Array<{ id: string; label: string; status: "complete" | "skipped" }> = [{ id: "router", label: "Request Router", status: "complete" }];

  try {
    if (intent !== "answer") {
      if (scopedTests.length < 2) {
        return Response.json({
          answer: `공통점을 검증하려면 선택 기간 안 서로 다른 발표일의 Test가 최소 2개 필요합니다. 현재 조건에 맞는 Test는 ${scopedTests.length}개입니다. 먼저 “최근 6개월 CPI 발표를 수집→분석→비교해줘”를 실행해 유효한 Test를 쌓아주세요.`,
          model, intent, specialists,
        }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
      }
      const summary = deterministicTestSummary(scopedTests);
      specialists.push({ id: "market", label: "Market Outcome Mapper", status: "complete" });
      const backtestPromise = intent === "strategy" || intent === "backtest"
        ? runDeterministicEventBacktest(scopedTests, requestedHoldingSessions(question))
        : Promise.resolve(null);
      const [evidence, audit, computedBacktest] = await Promise.all([
        callClaude({
          apiKey, model, ownerId, feature: "news.pattern_analyst", maxTokens: 1400,
          prompt: `You are the Pattern Analyst in a multi-agent quantitative research system. Extract only repeated, numerically supported relationships. Group comparable event types and reject one-off anecdotes. Answer in Korean.\n${hardRules}\nDeterministic summary: ${JSON.stringify(summary)}\nUser request: ${question}`,
        }),
        callClaude({
          apiKey, model, ownerId, feature: "news.similarity_auditor", maxTokens: 1300,
          prompt: `You are the independent Similarity Auditor. Try to falsify every apparent pattern directly from the deterministic rows. Find sign reversals, weak sample sizes, mixed event types, overlapping ranges, and look-ahead leakage. Quantify objections. Do not see or defer to another agent's draft. Answer in Korean.\n${hardRules}\nDeterministic summary: ${JSON.stringify(summary)}\nUser request: ${question}`,
        }),
        backtestPromise,
      ]);
      specialists.push({ id: "pattern", label: "Pattern Analyst", status: "complete" });
      specialists.push({ id: "similarity", label: "Similarity Auditor", status: "complete" });

      const backtest = computedBacktest;
      let strategyDraft = "";
      if (intent === "strategy" || intent === "backtest") {
        specialists.push({ id: "backtest", label: "Backtest Engine", status: "complete" });
        const strategy = await callClaude({
          apiKey, model, ownerId, feature: "news.strategy_builder", maxTokens: 1500,
          prompt: `You are the Strategy Builder. Turn only robust evidence into a falsifiable research rule with exact signal threshold, instrument proxy, entry date rule, holding period, cost assumptions, date range, and rejection criterion. Label unverified choices clearly. Answer in Korean.\n${hardRules}\nEvidence: ${evidence.text}\nAudit: ${audit.text}\nDeterministic event backtest: ${JSON.stringify(backtest)}`,
        });
        strategyDraft = strategy.text;
        specialists.push({ id: "strategy", label: "Strategy Builder", status: "complete" });
      }

      const synthesis = await callClaude({
        apiKey, model, ownerId, feature: "news.research_synthesizer", maxTokens: 1900,
        prompt: `You are the final Research Synthesizer. Answer the user in concise Korean. Reconcile the analyst and auditor rather than averaging them. Start with the conclusion. Give 3-5 numbered findings with the exact supporting numbers, confidence (low/medium/high), contradictions, and the next deterministic action. ${intent === "backtest" ? "Report the backtest metrics and limitations explicitly." : "Do not claim that a backtest was run unless results are supplied."}\n${hardRules}\nUser request: ${question}\nPattern evidence: ${evidence.text}\nIndependent audit: ${audit.text}\nStrategy draft: ${strategyDraft || "not requested"}\nBacktest result: ${JSON.stringify(backtest)}`,
      });
      specialists.push({ id: "risk", label: "Risk Reviewer & Synthesizer", status: "complete" });
      return Response.json({ answer: synthesis.text, model, intent, specialists, artifacts: { summary, backtest } }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
    }

    const needsEventWindows = /이벤트|당일|전일|하루\s*전|개장|프리마켓|장전|1\s*시간|한\s*시간|예측|컨센서스|실제치|상회|하회|서프라이즈|event|pre.?market|forecast|consensus|surprise/i.test(question);
    const eventDate = needsEventWindows ? requestedEventDate(question, context) : null;
    let eventWindows: EventWindow[] = [];
    if (eventDate) {
      const results = await Promise.allSettled([
        fetchYahooEventWindow("QQQ", "기술주 프록시 QQQ", eventDate),
        fetchYahooEventWindow("IWD", "가치주 프록시 IWD", eventDate),
      ]);
      eventWindows = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      specialists.push({ id: "market", label: "Market Outcome Mapper", status: "complete" });
    }
    const answer = await callClaude({
      apiKey, model, ownerId, feature: "news.agent_answer", maxTokens: 1800,
      prompt: `You are News JARVIS, the routing layer for a quantitative news-event workspace. Answer in concise Korean.\n${hardRules}\nCurrent news query: ${JSON.stringify(context.retrieved ?? null)}\nSelected headlines: ${JSON.stringify((context.headlines ?? []).slice(0, 40))}\nCurrent sentiment analysis: ${JSON.stringify(context.analysis ?? null)}\nSaved Test rows: ${JSON.stringify(tests.slice(-30))}\nOn-demand deterministic event windows: ${JSON.stringify(eventWindows)}\nUser request: ${question}`,
    });
    specialists.push({ id: "synthesis", label: "Research Synthesizer", status: "complete" });
    return Response.json({ answer: answer.text, model, intent, specialists }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    const status = error instanceof ClaudeApiError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "News JARVIS 호출에 실패했습니다." }, { status, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
