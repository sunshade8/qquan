import { claudeConfigured, describeClaudeError, generateText, modelForRole, type ModelRole } from "@/lib/claude";
import { challengeSynthesis, describeChallengerPairing, SYNTHESIS_VERDICT_LABELS } from "@/lib/challenger";
import type { ValidatedResearchPlan } from "@/lib/news-agent-plan";
import { deterministicTestSummary, runDeterministicEventBacktest, type ResearchTest } from "@/lib/news-research-agents";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { fetchYahooEventWindow, type EventWindow } from "@/lib/market-data";

type AgentPayload = {
  question?: string;
  plan?: ValidatedResearchPlan;
  history?: Array<{ role?: string; content?: string }>;
  context?: { retrieved?: unknown; headlines?: unknown[]; analysis?: unknown; tests?: unknown[] };
  stream?: boolean;
};

export type NewsSpecialist = { id: string; label: string; role: ModelRole; model: string; status: "running" | "complete" | "skipped" | "failed" };
export type NewsAgentEvent =
  | { type: "specialist"; specialist: NewsSpecialist }
  | { type: "text"; delta: string }
  | { type: "done"; answer: string; intent: string; specialists: NewsSpecialist[]; artifacts?: unknown; model: string }
  | { type: "error"; message: string; status?: number };

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
  return (value ?? []).filter((item): item is ResearchTest => Boolean(item && typeof item === "object" && "id" in item && "periodStart" in item && "periodEnd" in item && "overallScore" in item)).slice(-100);
}

function intentOf(question: string) {
  const pattern = /공통점|공통|패턴|유사성|반복|일관|similar|pattern/i.test(question);
  const strategy = /투자\s*전략|매매\s*전략|진입|청산|포지션|strategy/i.test(question);
  const backtest = /백테스트|성과\s*검증|검증\s*결과|backtest/i.test(question);
  const full = /최종\s*결과|끝까지|jarvis|전\s*과정|전체\s*연구/i.test(question);
  if (backtest || full) return "backtest" as const;
  if (strategy) return "strategy" as const;
  if (pattern) return "patterns" as const;
  return "answer" as const;
}

function intentOfPlan(plan: ValidatedResearchPlan | undefined, question: string) {
  if (plan?.requestedSteps.includes("run_backtest")) return "backtest" as const;
  if (plan?.requestedSteps.includes("build_strategy")) return "strategy" as const;
  if (plan?.mode === "analyze_existing" || plan?.requestedSteps.some((step) => step === "find_patterns" || step === "compare_tests")) return "patterns" as const;
  return intentOf(question);
}

function scopedTestsForQuestion(question: string, tests: ResearchTest[]) {
  const dates = [...question.matchAll(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/g)].map((match) => match[0].replaceAll(/[/.]/g, "-").split("-").map((part, index) => index ? part.padStart(2, "0") : part).join("-"));
  if (dates.length < 2) return tests;
  const [from, to] = dates[0] <= dates[1] ? [dates[0], dates[1]] : [dates[1], dates[0]];
  return tests.filter((test) => { const eventDate = test.forecastEvents?.[0]?.scheduledReleaseDate ?? test.periodEnd; return eventDate && eventDate >= from && eventDate <= to; });
}

function requestedHoldingSessions(question: string) {
  const match = question.match(/(\d{1,2})\s*(?:거래일|일)\s*(?:보유|홀드|holding|hold)/i);
  return Math.min(20, Math.max(1, Number(match?.[1] ?? 3)));
}

const HARD_RULES = `Hard rules:
- Use only supplied headlines, saved Test rows, and deterministic market calculations. Never invent article contents, prices, forecasts, or actual releases.
- Keep the timeline strict: publication cutoff → ex-ante sentiment → scheduled release → ex-post return.
- Treat the deterministic summary's analysisAsOfDate as today's date. An event is future only when its eventDate is later than analysisAsOfDate.
- Association is not causation. Surface sample size, event overlap, timing, headline-only evidence, and look-ahead risks.
- Do not present this as personalized financial advice or guarantee a return.
- Answer in Korean with Markdown (short headings, bullets, tables for numbers).`;

const SPECIALIST_LABELS: Record<string, { label: string; role: ModelRole }> = {
  router: { label: "Request Router", role: "router" },
  market: { label: "Market Outcome Mapper", role: "router" },
  pattern: { label: "Pattern Analyst", role: "auditor" },
  similarity: { label: "Similarity Auditor", role: "auditor" },
  backtest: { label: "Backtest Engine", role: "router" },
  challenge: { label: "Independent Challenger", role: "challenger" },
  strategy: { label: "Strategy Builder", role: "strategist" },
  synthesis: { label: "Research Synthesizer", role: "synthesizer" },
};

function historyMessages(history: AgentPayload["history"]) {
  return (history ?? []).slice(-8).flatMap((item) => {
    const content = String(item.content ?? "").slice(0, 2500).trim();
    return content ? [{ role: item.role === "agent" ? "assistant" as const : "user" as const, content }] : [];
  });
}

export async function POST(request: Request) {
  const payload = await request.json() as AgentPayload;
  const question = payload.question?.trim();
  if (!question) return Response.json({ error: "Agent에게 물어볼 내용을 입력해주세요." }, { status: 400 });
  const ownerId = researchOwnerFrom(request);
  const cookie = researchOwnerCookie(ownerId);
  if (!claudeConfigured()) return Response.json({ error: "Claude 서버 키가 연결되지 않았습니다." }, { status: 503, headers: { "set-cookie": cookie } });

  const context = payload.context ?? {};
  const tests = validTests(context.tests);
  const scopedTests = scopedTestsForQuestion(question, tests);
  const intent = intentOfPlan(payload.plan, question);
  const specialists: NewsSpecialist[] = [];
  const encoder = new TextEncoder();
  const wantsStream = payload.stream !== false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: NewsAgentEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const mark = (id: string, status: NewsSpecialist["status"], role?: ModelRole) => {
        const definition = SPECIALIST_LABELS[id];
        const resolvedRole = role ?? definition.role;
        const existing = specialists.find((item) => item.id === id);
        const specialist: NewsSpecialist = existing ? { ...existing, status, role: resolvedRole, model: modelForRole(resolvedRole) } : { id, label: definition.label, role: resolvedRole, model: modelForRole(resolvedRole), status };
        if (existing) Object.assign(existing, specialist); else specialists.push(specialist);
        emit({ type: "specialist", specialist });
      };
      const done = (answer: string, extra?: { artifacts?: unknown }) => {
        emit({ type: "done", answer, intent, specialists, artifacts: extra?.artifacts, model: modelForRole("synthesizer") });
        controller.close();
      };
      mark("router", "complete");
      console.log("[news/agent] routed", { intent, plannedMode: payload.plan?.mode ?? null, testCount: tests.length, scopedTestCount: scopedTests.length });

      try {
        if (intent !== "answer") {
          if (scopedTests.length < 2) {
            done(`요청한 분석에는 서로 다른 발표일의 유효 Test가 최소 2개 필요하지만 현재 조건에 맞는 Test는 **${scopedTests.length}개**입니다. 기간을 임의로 바꾸거나 배치 명령을 대신 실행하지 않았습니다.\n\n다음 중 하나로 이어가세요.\n- "최근 1년 CPI 발표를 수집→분석→비교해줘"처럼 파이프라인을 실행해 Test를 쌓기\n- 이미 저장된 Test가 있다면 기간 조건을 넓히기`);
            return;
          }
          const summary = deterministicTestSummary(scopedTests);
          mark("market", "complete");
          const needsStrategy = intent === "strategy" || intent === "backtest";
          mark("pattern", "running");
          mark("similarity", "running");
          if (needsStrategy) mark("backtest", "running");
          const [evidence, audit, backtest] = await Promise.all([
            generateText({
              role: "auditor", ownerId, feature: "news.pattern_analyst", maxTokens: 1800, effort: "medium",
              system: `You are the Pattern Analyst in a multi-agent quantitative research system. Extract only repeated, numerically supported relationships between pre-release news sentiment and realized index returns. Group comparable event types, quote the exact numbers, and reject one-off anecdotes.\n${HARD_RULES}`,
              prompt: `Deterministic summary: ${JSON.stringify(summary)}\nUser request: ${question}`,
            }).then((result) => { mark("pattern", "complete"); return result.text; }).catch((error) => { mark("pattern", "failed"); throw error; }),
            generateText({
              role: "auditor", ownerId, feature: "news.similarity_auditor", maxTokens: 1600, effort: "medium",
              system: `You are the independent Similarity Auditor. Try to falsify every apparent pattern directly from the deterministic rows: sign reversals, weak sample sizes, mixed event types, overlapping ranges, and look-ahead leakage. Quantify each objection. You do not see any other agent's draft.\n${HARD_RULES}`,
              prompt: `Deterministic summary: ${JSON.stringify(summary)}\nUser request: ${question}`,
            }).then((result) => { mark("similarity", "complete"); return result.text; }).catch((error) => { mark("similarity", "failed"); throw error; }),
            needsStrategy ? runDeterministicEventBacktest(scopedTests, requestedHoldingSessions(question)).then((result) => { mark("backtest", "complete"); return result; }) : Promise.resolve(null),
          ]);

          let strategyDraft = "";
          if (needsStrategy) {
            mark("strategy", "running");
            const strategy = await generateText({
              role: "strategist", ownerId, feature: "news.strategy_builder", maxTokens: 2000, effort: "high",
              system: `You are the Strategy Builder. Turn only robust evidence into a falsifiable research rule with an exact signal threshold, instrument proxy, entry date rule, holding period, cost assumptions, date range, and rejection criterion. Label unverified choices clearly.\n${HARD_RULES}`,
              prompt: `Evidence: ${evidence}\nAudit: ${audit}\nDeterministic event backtest: ${JSON.stringify(backtest)}\nUser request: ${question}`,
            });
            strategyDraft = strategy.text;
            mark("strategy", "complete");
          }

          mark("synthesis", "running");
          const synthesis = await generateText({
            role: "synthesizer", ownerId, feature: "news.research_synthesizer", maxTokens: 2600, effort: "high",
            system: `You are the final Research Synthesizer for News JARVIS. Reconcile the analyst and the auditor rather than averaging them. Start with the conclusion. Then give 3-5 numbered findings with the exact supporting numbers, confidence (low/medium/high), contradictions, and the next deterministic action. ${intent === "backtest" ? "Report the backtest metrics and limitations explicitly." : "Do not claim a backtest was run unless results are supplied."}\n${HARD_RULES}`,
            messages: [...historyMessages(payload.history), { role: "user", content: `User request: ${question}\nDeterministic summary: ${JSON.stringify(summary)}\nPattern evidence: ${evidence}\nIndependent audit: ${audit}\nStrategy draft: ${strategyDraft || "not requested"}\nBacktest result: ${JSON.stringify(backtest)}` }],
          });
          mark("synthesis", "complete");
          // The synthesizer shares the frontier model with the strategist that
          // fed it, so the only genuinely independent check on the final answer
          // runs on the counter tier.
          mark("challenge", "running");
          const challenge = await challengeSynthesis({
            answer: synthesis.text, question,
            evidence: { deterministicSummary: summary, patternEvidence: evidence, independentAudit: audit, strategyDraft: strategyDraft || null, backtest },
            ownerId, feature: "news.synthesis_challenger",
          });
          mark("challenge", challenge.ok ? "complete" : "failed");
          const answerWithChallenge = challenge.ok && challenge.data.verdict !== "accurate"
            ? `${synthesis.text}\n\n---\n\n**독립 심사 (${SYNTHESIS_VERDICT_LABELS[challenge.data.verdict]}) · ${describeChallengerPairing(challenge.independent)}**\n\n${challenge.data.headline}\n${challenge.data.overclaims.map((item) => `- 과장: ${item}`).join("\n")}\n${challenge.data.unsupportedNumbers.map((item) => `- 근거 없는 수치: ${item}`).join("\n")}\n${challenge.data.missingCaveats.map((item) => `- 누락된 한계: ${item}`).join("\n")}\n\n심사관 권고 신뢰도: **${challenge.data.suggestedConfidence}**`
            : synthesis.text;
          done(answerWithChallenge, { artifacts: { summary, backtest, challenge: challenge.ok ? challenge.data : null } });
          return;
        }

        const needsEventWindows = /이벤트|당일|전일|하루\s*전|개장|프리마켓|장전|1\s*시간|한\s*시간|예측|컨센서스|실제치|상회|하회|서프라이즈|event|pre.?market|forecast|consensus|surprise/i.test(question);
        const eventDate = needsEventWindows ? requestedEventDate(question, context) : null;
        let eventWindows: EventWindow[] = [];
        if (eventDate) {
          mark("market", "running");
          const results = await Promise.allSettled([fetchYahooEventWindow("QQQ", "기술주 프록시 QQQ", eventDate), fetchYahooEventWindow("IWD", "가치주 프록시 IWD", eventDate)]);
          eventWindows = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
          mark("market", "complete");
        }
        mark("synthesis", "running");
        const summary = tests.length >= 2 ? deterministicTestSummary(tests) : null;
        const answer = await generateText({
          role: "synthesizer", ownerId, feature: "news.agent_answer", maxTokens: 2400, effort: "medium",
          system: `You are News JARVIS, the research partner inside a quantitative news-event workspace. You have expert knowledge of macroeconomic releases, Fed policy, market microstructure around scheduled data, and event-study methodology. Answer the user's question directly using the supplied context; when the question is conceptual, answer from expertise and say what the workspace could test next.\n${HARD_RULES}`,
          messages: [...historyMessages(payload.history), {
            role: "user",
            content: `Current news query: ${JSON.stringify(context.retrieved ?? null)}\nSelected headlines: ${JSON.stringify((context.headlines ?? []).slice(0, 40))}\nCurrent sentiment analysis: ${JSON.stringify(context.analysis ?? null)}\nSaved Test rows (latest 30): ${JSON.stringify(tests.slice(-30))}\nDeterministic Test summary: ${JSON.stringify(summary)}\nOn-demand deterministic event windows: ${JSON.stringify(eventWindows)}\nUser request: ${question}`,
          }],
        });
        mark("synthesis", "complete");
        done(answer.text);
      } catch (error) {
        const described = describeClaudeError(error);
        console.error("[news/agent] failed", { intent, status: described.status, message: described.message });
        emit({ type: "error", message: described.message, status: described.status });
        controller.close();
      }
    },
  });

  if (wantsStream) return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "set-cookie": cookie } });

  // Non-streaming callers (batch follow-ups) get the final JSON only.
  const text = await new Response(stream).text();
  const events = text.split("\n\n").flatMap((frame) => { const line = frame.split("\n").find((item) => item.startsWith("data: ")); if (!line) return []; try { return [JSON.parse(line.slice(6)) as NewsAgentEvent]; } catch { return []; } });
  const final = events.find((event): event is Extract<NewsAgentEvent, { type: "done" }> => event.type === "done");
  const failure = events.find((event): event is Extract<NewsAgentEvent, { type: "error" }> => event.type === "error");
  if (final) return Response.json({ answer: final.answer, intent: final.intent, specialists: final.specialists, artifacts: final.artifacts, model: final.model }, { headers: { "set-cookie": cookie } });
  return Response.json({ error: failure?.message ?? "News JARVIS 호출에 실패했습니다." }, { status: failure?.status ?? 500, headers: { "set-cookie": cookie } });
}
