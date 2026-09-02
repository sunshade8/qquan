import { claudeConfigured, describeClaudeError, generateText } from "@/lib/claude";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

type PriceRow = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type AnalysisPayload = {
  symbol?: string;
  question?: string;
  dataset?: {
    name?: string;
    profile?: unknown;
    rows?: PriceRow[];
    study?: unknown;
    providers?: unknown;
    brokerSnapshot?: unknown;
  };
};

export async function POST(request: Request) {
  const payload = (await request.json()) as AnalysisPayload;
  const rows = payload.dataset?.rows ?? [];
  const question = payload.question?.trim();

  if (!question || rows.length < 30) {
    return Response.json({ error: "실제 OHLCV 데이터 30행 이상과 질문이 필요합니다." }, { status: 400 });
  }

  if (!claudeConfigured()) {
    return Response.json({ error: "Claude 서버 키가 연결되지 않았습니다. 새 키를 Settings에 연결해야 합니다." }, { status: 503 });
  }
  const ownerId = researchOwnerFrom(request);

  const system = `You are a research agent inside a personal quantitative research program.

Hard rules:
- Analyze only the dataset and deterministic study result supplied below.
- Never imply that you can read the TradingView widget or any data not included here.
- The broker snapshot is a timestamped Toss Securities observation, not a continuous live feed. State its timestamp when it matters.
- Separate observations, hypotheses, and unsupported possibilities.
- Quantify claims with dates, values, sample size, and forward horizon when possible.
- Look beyond technical indicators: consider price structure, volume, volatility, gaps, regime changes, and data limitations when relevant.
- Suggest the next deterministic query or falsification test. Do not provide a trade instruction.
- Answer concisely in Korean using Markdown.`;

  const prompt = `Symbol: ${payload.symbol ?? "unknown"}
Dataset name: ${payload.dataset?.name ?? "uploaded CSV"}
Dataset profile: ${JSON.stringify(payload.dataset?.profile ?? null)}
Data providers and cross-check: ${JSON.stringify(payload.dataset?.providers ?? null)}
Toss broker snapshot: ${JSON.stringify(payload.dataset?.brokerSnapshot ?? null)}
Deterministic study: ${JSON.stringify(payload.dataset?.study ?? null)}
Recent OHLCV rows (oldest to newest): ${JSON.stringify(rows.slice(-400))}

User question: ${question}`;

  try {
    const result = await generateText({ role: "synthesizer", system, prompt, maxTokens: 2500, effort: "medium", ownerId, feature: "market.research_agent" });
    return Response.json({ answer: result.text, model: result.model, usage: result.usage, costUsd: result.costUsd }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    const described = describeClaudeError(error);
    return Response.json({ error: described.message }, { status: described.status, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
