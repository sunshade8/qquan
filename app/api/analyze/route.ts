import { env } from "cloudflare:workers";

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

  const runtimeEnv = env as unknown as Record<string, string | undefined>;
  const apiKey = runtimeEnv.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const model = runtimeEnv.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

  if (!apiKey) {
    return Response.json({ error: "Claude 서버 키가 연결되지 않았습니다. 새 키를 Settings에 연결해야 합니다." }, { status: 503 });
  }

  const prompt = `You are a research agent inside a personal quantitative research program.

Hard rules:
- Analyze only the dataset and deterministic study result supplied below.
- Never imply that you can read the TradingView widget or any data not included here.
- The broker snapshot is a timestamped Toss Securities observation, not a continuous live feed. State its timestamp when it matters.
- Separate observations, hypotheses, and unsupported possibilities.
- Quantify claims with dates, values, sample size, and forward horizon when possible.
- Look beyond technical indicators: consider price structure, volume, volatility, gaps, regime changes, and data limitations when relevant.
- Suggest the next deterministic query or falsification test. Do not provide a trade instruction.
- Answer concisely in Korean.

Symbol: ${payload.symbol ?? "unknown"}
Dataset name: ${payload.dataset?.name ?? "uploaded CSV"}
Dataset profile: ${JSON.stringify(payload.dataset?.profile ?? null)}
Data providers and cross-check: ${JSON.stringify(payload.dataset?.providers ?? null)}
Toss broker snapshot: ${JSON.stringify(payload.dataset?.brokerSnapshot ?? null)}
Deterministic study: ${JSON.stringify(payload.dataset?.study ?? null)}
Recent OHLCV rows (oldest to newest): ${JSON.stringify(rows.slice(-400))}

User question: ${question}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 1800, messages: [{ role: "user", content: prompt }] }),
  });

  if (!response.ok) {
    return Response.json({ error: "Claude 분석 호출에 실패했습니다." }, { status: response.status });
  }

  const result = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const answer = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
  if (!answer) return Response.json({ error: "Claude 응답이 비어 있습니다." }, { status: 502 });
  return Response.json({ answer, model });
}
