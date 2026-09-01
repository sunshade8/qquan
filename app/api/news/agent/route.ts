import { env } from "cloudflare:workers";
import { fetchYahooEventWindow, type EventWindow } from "../../../../lib/market-data";

type AgentPayload = {
  question?: string;
  context?: {
    retrieved?: unknown;
    headlines?: unknown[];
    analysis?: unknown;
    tests?: unknown[];
  };
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

export async function POST(request: Request) {
  const payload = await request.json() as AgentPayload;
  const question = payload.question?.trim();
  if (!question) return Response.json({ error: "Agent에게 물어볼 내용을 입력해주세요." }, { status: 400 });

  const runtimeEnv = env as unknown as Record<string, string | undefined>;
  const apiKey = runtimeEnv.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const model = runtimeEnv.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  if (!apiKey) return Response.json({ error: "Claude 서버 키가 연결되지 않았습니다." }, { status: 503 });

  const context = payload.context ?? {};
  const needsEventWindows = /이벤트|당일|전일|하루\s*전|개장|프리마켓|장전|1\s*시간|한\s*시간|예측|컨센서스|실제치|상회|하회|서프라이즈|event|pre.?market|forecast|consensus|surprise/i.test(question);
  const eventDate = needsEventWindows ? requestedEventDate(question, context) : null;
  let eventWindows: EventWindow[] = [];
  if (eventDate) {
    const results = await Promise.allSettled([
      fetchYahooEventWindow("QQQ", "기술주 프록시 QQQ", eventDate),
      fetchYahooEventWindow("IWD", "가치주 프록시 IWD", eventDate),
    ]);
    eventWindows = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }
  const prompt = `You are the research agent for a quantitative news-event workspace. Answer in concise Korean.

Hard rules:
- Use only the supplied headline, sentiment, deterministic Test data, and on-demand event-window data. Never invent full article contents or prices.
- Explicitly distinguish ex-ante headline sentiment from ex-post index returns. Association is not causation.
- Compare overall, technology/growth, and value sentiment when present; explain why the same macro news can affect them differently.
- NASDAQ Composite and NYSE Composite Test returns are close-to-close from the first to last trading day available inside the selected date range.
- When event-window data is supplied, answer with the actual previous-session open-to-close, event-day gap and open-to-close, and 08:30–09:30 ET pre-open return. QQQ is the technology proxy and IWD is the value proxy; do not call either an index.
- For forecast research, keep the causal timeline strict: article publication → extracted consensus/forecast → price movement until the scheduled release → actual minus consensus surprise → post-release price windows. If the actual release value is not supplied, stop at the forecast and price-window stages and say exactly what remains missing.
- Compare repeated events only after normalizing surprise by historical forecast error or release volatility. Separate CPI/PCE/PPI, NFP/unemployment/wages, GDP, ISM manufacturing/services, and FOMC rather than pooling unlike indicators.
- If the user asks how to proceed, propose a concrete falsifiable design: define event timestamp, ex-ante news cutoff, non-overlapping control sample, [-1D, 0D, +1D] windows, 08:30–09:30 ET pre-open window, benchmark/style spread, sample size, and rejection criterion.
- If an event date is a non-trading day or intraday data is unavailable, say so and recommend the nearest-trading-day rule. Never fabricate the missing window.
- Surface sample-size, timing, overlap, headline-only, and look-ahead limitations. Do not give a trade instruction.

Current news query: ${JSON.stringify(context.retrieved ?? null)}
Selected headlines: ${JSON.stringify((context.headlines ?? []).slice(0, 40))}
Current sentiment analysis: ${JSON.stringify(context.analysis ?? null)}
Saved Test rows: ${JSON.stringify((context.tests ?? []).slice(-30))}
On-demand deterministic event windows: ${JSON.stringify(eventWindows)}

User request: ${question}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1800, messages: [{ role: "user", content: prompt }] }),
  });
  if (!response.ok) return Response.json({ error: "News Agent 호출에 실패했습니다." }, { status: response.status });
  const result = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const answer = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
  if (!answer) return Response.json({ error: "News Agent 응답이 비어 있습니다." }, { status: 502 });
  return Response.json({ answer, model });
}
