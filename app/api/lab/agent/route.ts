import { env } from "cloudflare:workers";
import { createAnthropic } from "@ai-sdk/anthropic";
import { isStepCount, tool, ToolLoopAgent, type ModelMessage } from "ai";
import { z } from "zod";
import { findCompanyNews } from "@/lib/company-news";
import { compareAlignedSeries, findLargestDrawdowns, resolveAsset } from "@/lib/lab-analysis";
import type { LabArtifact, LabToolTrace } from "@/lib/lab-types";
import { loadDailyRows } from "@/lib/price-cache";
import { recordLlmUsage } from "@/lib/llm-usage";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

type IncomingMessage = { role?: string; content?: string };

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shiftedToday(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function round(value: number | null, digits = 3) {
  return value === null ? null : Number(value.toFixed(digits));
}

async function comparePriceSimilarity(
  input: { assetA: string; assetB: string; sessions: number },
  artifacts: LabArtifact[], traces: LabToolTrace[],
) {
  const left = resolveAsset(input.assetA);
  const right = resolveAsset(input.assetB);
  if (!left.public || !right.public || !left.symbol || !right.symbol) {
    const missing = !left.public ? left : right;
    const artifact: LabArtifact = {
      id: crypto.randomUUID(), type: "limitation", title: `${left.name} vs ${right.name} 비교 제한`,
      explanation: missing.note ?? `${missing.name}의 검증 가능한 공개 주가가 없습니다.`,
      suggestions: ["상장된 비교 종목을 지정", "사용자가 보유한 비상장 가치평가 시계열 CSV 연결", "SpaceX 뉴스와 상장 종목 가격 반응을 이벤트 기준으로 비교"],
    };
    artifacts.push(artifact);
    traces.push({ name: "comparePriceSimilarity", label: "가격 유사도", status: "failed", detail: artifact.explanation });
    return { available: false, reason: artifact.explanation, suggestions: artifact.suggestions };
  }
  const to = shiftedToday(0);
  const from = shiftedToday(-Math.ceil(input.sessions * 1.75));
  const [leftLoad, rightLoad] = await Promise.all([loadDailyRows(left.symbol, from, to), loadDailyRows(right.symbol, from, to)]);
  const comparison = compareAlignedSeries(leftLoad.rows.slice(-input.sessions), rightLoad.rows.slice(-input.sessions));
  if (comparison.sessions < 20) {
    const reason = `공통 거래일이 ${comparison.sessions}개뿐이라 유사도를 검증할 수 없습니다.`;
    traces.push({ name: "comparePriceSimilarity", label: "가격 유사도", status: "failed", detail: reason });
    return { available: false, reason, providers: [leftLoad.origin, rightLoad.origin] };
  }
  const points = comparison.points.slice(-input.sessions);
  const artifact: LabArtifact = {
    id: crypto.randomUUID(), type: "price-comparison", title: `${left.name} vs ${right.name} 가격 유사도`,
    period: { from: points[0].date, to: points.at(-1)!.date, sessions: comparison.sessions },
    left: { name: left.name, symbol: left.symbol, returnPct: round(comparison.leftReturnPct) },
    right: { name: right.name, symbol: right.symbol, returnPct: round(comparison.rightReturnPct) },
    metrics: { returnCorrelation: round(comparison.returnCorrelation), pathCorrelation: round(comparison.pathCorrelation) },
    points,
    notes: ["첫 공통 거래일 종가를 100으로 정규화", "수익률 상관은 방향 동조, 경로 상관은 누적 모양 유사성을 측정", `데이터: ${leftLoad.origin} / ${rightLoad.origin}`],
  };
  artifacts.push(artifact);
  traces.push({ name: "comparePriceSimilarity", label: "가격 유사도", status: "complete", detail: `${comparison.sessions}개 공통 거래일` });
  return { available: true, period: artifact.period, left: artifact.left, right: artifact.right, metrics: artifact.metrics, methodology: artifact.notes };
}

async function findDrawdownCompanyNews(
  input: { stock: string; newsCompany: string; lookbackDays: number; eventCount: number; newsWindowDays: number },
  artifacts: LabArtifact[], traces: LabToolTrace[],
) {
  const asset = resolveAsset(input.stock);
  if (!asset.public || !asset.symbol) {
    const reason = asset.note ?? "상장 종목 티커를 확인할 수 없습니다.";
    traces.push({ name: "findDrawdownCompanyNews", label: "하락일·뉴스 연결", status: "failed", detail: reason });
    return { available: false, reason };
  }
  const to = shiftedToday(0);
  const from = shiftedToday(-input.lookbackDays);
  const priceLoad = await loadDailyRows(asset.symbol, from, to);
  const drawdowns = findLargestDrawdowns(priceLoad.rows, input.eventCount);
  const events = await Promise.all(drawdowns.map(async (event) => ({
    date: event.date, returnPct: Number(event.returnPct.toFixed(3)), close: event.close,
    news: await findCompanyNews(input.newsCompany, event.date, input.newsWindowDays).catch(() => []),
  })));
  const artifact: LabArtifact = {
    id: crypto.randomUUID(), type: "drawdown-news", title: `${asset.name} 급락일과 ${input.newsCompany} 뉴스`, symbol: asset.symbol, company: input.newsCompany,
    period: { from, to }, events,
    notes: ["급락일은 조정 일봉의 종가 대비 종가 수익률 최저 순", `뉴스는 각 급락일 ±${input.newsWindowDays}일 Google News RSS 검색`, "시간상 동시 발생을 보여주며 인과관계를 증명하지 않음"],
  };
  artifacts.push(artifact);
  traces.push({ name: "findDrawdownCompanyNews", label: "하락일·뉴스 연결", status: "complete", detail: `${events.length}개 급락일 · 뉴스 ${events.reduce((sum, event) => sum + event.news.length, 0)}건` });
  return { available: Boolean(events.length), symbol: asset.symbol, period: artifact.period, events, methodology: artifact.notes };
}

function explicitAssets(question: string) {
  const candidates = [
    { pattern: /rocket\s*lab|rklb/i, value: "RKLB" },
    { pattern: /space\s*x/i, value: "SpaceX" },
    { pattern: /ast\s*spacemobile|asts/i, value: "ASTS" },
    { pattern: /tesla|tsla/i, value: "TSLA" },
    { pattern: /nvidia|nvda/i, value: "NVDA" },
    { pattern: /apple|aapl/i, value: "AAPL" },
    { pattern: /microsoft|msft/i, value: "MSFT" },
    { pattern: /amazon|amzn/i, value: "AMZN" },
  ];
  return candidates.filter((candidate) => candidate.pattern.test(question)).map((candidate) => candidate.value);
}

export async function POST(request: Request) {
  const payload = await request.json() as { question?: string; history?: IncomingMessage[] };
  const question = payload.question?.trim();
  if (!question) return Response.json({ error: "질문이 필요합니다." }, { status: 400 });
  const runtimeEnv = env as unknown as Record<string, string | undefined>;
  const apiKey = runtimeEnv.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const model = runtimeEnv.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  const ownerId = researchOwnerFrom(request);

  const artifacts: LabArtifact[] = [];
  const traces: LabToolTrace[] = [];
  const tools = {
    comparePriceSimilarity: tool({
      description: "두 상장 주식의 일봉을 같은 거래일로 정렬해 정규화 차트, 일간 수익률 상관계수, 경로 상관계수를 계산한다. 비상장사는 데이터가 없음을 명시한다.",
      inputSchema: z.object({
        assetA: z.string().describe("첫 회사명 또는 티커"),
        assetB: z.string().describe("둘째 회사명 또는 티커"),
        sessions: z.number().int().min(20).max(756).default(252).describe("비교할 최근 거래일 수"),
      }),
      execute: async ({ assetA, assetB, sessions }) => comparePriceSimilarity({ assetA, assetB, sessions }, artifacts, traces),
    }),
    findDrawdownCompanyNews: tool({
      description: "특정 상장 주식의 최근 최대 일간 하락일들을 찾고, 각 하락일 전후에 사용자가 지정한 회사와 관련된 실제 뉴스 헤드라인을 연결한다.",
      inputSchema: z.object({
        stock: z.string().describe("하락일을 찾을 상장 종목명 또는 티커"),
        newsCompany: z.string().describe("해당 하락일 전후 뉴스를 찾을 회사명"),
        lookbackDays: z.number().int().min(30).max(1825).default(365),
        eventCount: z.number().int().min(1).max(8).default(3),
        newsWindowDays: z.number().int().min(1).max(7).default(2),
      }),
      execute: async ({ stock, newsCompany, lookbackDays, eventCount, newsWindowDays }) => findDrawdownCompanyNews({ stock, newsCompany, lookbackDays, eventCount, newsWindowDays }, artifacts, traces),
    }),
  };

  const isSimilarity = /유사|비교|상관|similar|correlat/i.test(question) && /차트|주가|가격|chart|price/i.test(question);
  const isDrawdownNews = /하락|급락|폭락|drawdown|drop|fell/i.test(question) && /뉴스|news/i.test(question);
  const namedAssets = explicitAssets(question);
  const directHeaders = { "set-cookie": researchOwnerCookie(ownerId) };

  // High-confidence requests go straight to deterministic tools. This keeps a
  // provider outage from blocking price math or news retrieval, while the LLM
  // remains the planner for ambiguous and multi-step questions.
  if (isSimilarity && namedAssets.length === 2) {
    const sessions = /(?:6개월|six months?)/i.test(question) ? 126 : /(?:3개월|three months?)/i.test(question) ? 63 : 252;
    const result = await comparePriceSimilarity({ assetA: namedAssets[0], assetB: namedAssets[1], sessions }, artifacts, traces);
    const artifact = artifacts.at(-1);
    const answer = artifact?.type === "price-comparison"
      ? `${artifact.period.sessions}개 공통 거래일을 정렬했습니다. 일간 수익률 상관은 ${artifact.metrics.returnCorrelation?.toFixed(3) ?? "계산 불가"}, 누적 경로 상관은 ${artifact.metrics.pathCorrelation?.toFixed(3) ?? "계산 불가"}입니다. 차트와 기간 수익률을 Research Canvas에 저장했습니다.`
      : `${"reason" in result ? result.reason : "직접 가격 비교를 만들 수 없습니다."} 임의의 상장 프록시로 바꾸지 않았으며, 가능한 대안을 Research Canvas에 정리했습니다.`;
    return Response.json({ answer, tools: traces, artifacts, orchestrator: "deterministic-router" }, { headers: directHeaders });
  }

  if (isDrawdownNews) {
    const stock = namedAssets.find((asset) => resolveAsset(asset).public);
    const newsCompany = /space\s*x/i.test(question) ? "SpaceX" : namedAssets.find((asset) => asset !== stock);
    if (stock && newsCompany) {
      const result = await findDrawdownCompanyNews({ stock, newsCompany, lookbackDays: /(?:2년|two years?)/i.test(question) ? 730 : 365, eventCount: 3, newsWindowDays: 2 }, artifacts, traces);
      const artifact = artifacts.find((item): item is Extract<LabArtifact, { type: "drawdown-news" }> => item.type === "drawdown-news");
      const totalNews = artifact?.events.reduce((sum, event) => sum + event.news.length, 0) ?? 0;
      const answer = artifact
        ? `${artifact.symbol}의 최근 기간 중 일간 하락률이 가장 컸던 ${artifact.events.length}개 거래일을 찾고, 각 날짜 ±2일의 ${newsCompany} 뉴스 ${totalNews}건을 연결했습니다. 날짜별 하락률과 헤드라인은 Canvas에 저장했습니다. 동시 발생은 인과관계를 의미하지 않습니다.`
        : `${"reason" in result ? result.reason : "가격 또는 뉴스 결과를 만들지 못했습니다."}`;
      return Response.json({ answer, tools: traces, artifacts, orchestrator: "deterministic-router" }, { headers: directHeaders });
    }
  }

  if (!apiKey) return Response.json({ error: "이 질문은 LLM 계획이 필요하지만 Claude 서버 키가 연결되지 않았습니다." }, { status: 503, headers: directHeaders });
  const provider = createAnthropic({ apiKey });
  const agent = new ToolLoopAgent({
    model: provider(model),
    instructions: `당신은 QQuant Lab의 주식 리서치 총괄 에이전트다. 한국어로 간결하게 답한다.
- 가격·뉴스가 필요한 질문은 반드시 제공된 도구를 사용하고, 도구 결과의 숫자와 날짜만 근거로 답한다.
- SpaceX처럼 비상장인 자산은 공개 주가가 없다고 말하고 임의 프록시를 대입하지 않는다.
- 뉴스와 가격의 시간적 동시성은 인과관계가 아니라고 구분한다.
- 계산 결과를 먼저 요약하고, 해석과 다음 검증 제안을 분리한다.
- 투자 권유나 확정적 수익 표현을 하지 않는다. 현재 날짜는 ${shiftedToday(0)}다.`,
    tools,
    stopWhen: isStepCount(5),
    temperature: 0.1,
    maxOutputTokens: 1400,
    prepareStep: ({ stepNumber }) => {
      if (stepNumber !== 0) return { toolChoice: "auto" as const };
      if (isSimilarity) return { toolChoice: { type: "tool" as const, toolName: "comparePriceSimilarity" as const } };
      if (isDrawdownNews) return { toolChoice: { type: "tool" as const, toolName: "findDrawdownCompanyNews" as const } };
      return { toolChoice: "auto" as const };
    },
  });
  const history = (payload.history ?? []).slice(-10).flatMap((message): ModelMessage[] => {
    const content = typeof message.content === "string" ? message.content.slice(0, 5000) : "";
    if (!content) return [];
    return [{ role: message.role === "agent" ? "assistant" : "user", content }];
  });
  history.push({ role: "user", content: question });
  try {
    const result = await agent.generate({ messages: history });
    await recordLlmUsage(ownerId, model, "lab.tool_agent", {
      input_tokens: result.totalUsage.inputTokens,
      output_tokens: result.totalUsage.outputTokens,
      cache_creation_input_tokens: result.totalUsage.inputTokenDetails?.cacheWriteTokens,
      cache_read_input_tokens: result.totalUsage.inputTokenDetails?.cacheReadTokens,
    });
    return Response.json({ answer: result.text || "도구 실행은 완료됐지만 설명 응답이 비어 있습니다.", tools: traces, artifacts, model }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Lab Agent 실행에 실패했습니다.", tools: traces, artifacts }, { status: 500, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
