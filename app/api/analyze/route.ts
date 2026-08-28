import { env } from "cloudflare:workers";

const DEMO_ANALYSIS = {
  summary: "시장 폭이 개선되는 동안 실현 변동성이 낮아지고 있습니다. 최근 20일 상대강도가 높은 대형주를 주간 리밸런싱하는 가설을 먼저 검증해 볼 만합니다.",
  signals: [
    { name: "Market breadth", value: "68.4%", direction: "positive", reason: "S&P 500 종목 중 50일 이동평균 위 종목 비율이 상승 중입니다." },
    { name: "Volatility", value: "14.8", direction: "neutral", reason: "변동성은 낮지만 급격한 반전 가능성은 별도 스트레스 테스트가 필요합니다." },
    { name: "Momentum spread", value: "+6.2%", direction: "positive", reason: "상위 모멘텀 그룹과 지수 간 3개월 성과 차이가 확대됐습니다." },
  ],
  hypothesis: "S&P 500 대형주 중 20일 상대강도 상위 10%를 매수하고, 시장 폭이 55% 아래로 내려가면 현금 비중을 늘린다.",
  mode: "demo",
};

export async function POST(request: Request) {
  const payload = (await request.json()) as { symbols?: string[]; question?: string; context?: unknown };
  const runtimeEnv = env as unknown as Record<string, string | undefined>;
  const apiKey = runtimeEnv.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const model = runtimeEnv.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

  if (!apiKey) return Response.json(DEMO_ANALYSIS);

  const prompt = `You are the analysis module of a personal quantitative research tool. Analyze only the supplied market data. Do not claim live access, do not place trades, and distinguish evidence from inference.\n\nSelected symbols: ${(payload.symbols ?? []).join(", ") || "S&P 500 universe"}\nQuestion: ${payload.question ?? "Find testable chart and data signals."}\nData context: ${JSON.stringify(payload.context ?? {})}\n\nReply in Korean with: (1) a concise summary, (2) three observable signals with values and reasons, and (3) one falsifiable hypothesis. Include limitations.`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1800, messages: [{ role: "user", content: prompt }] }),
  });
  if (!response.ok) {
    const detail = await response.text();
    return Response.json({ error: "AI analysis failed", detail: detail.slice(0, 400) }, { status: response.status });
  }
  const result = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const text = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
  return Response.json({ summary: text, signals: [], hypothesis: "", mode: "live", model });
}
