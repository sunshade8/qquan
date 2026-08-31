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

function requestedEventDate(question: string, retrieved: unknown) {
  const explicit = question.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (explicit) return `${explicit[1]}-${explicit[2].padStart(2, "0")}-${explicit[3].padStart(2, "0")}`;
  const end = retrieved && typeof retrieved === "object" && "end" in retrieved && typeof retrieved.end === "string" ? retrieved.end : null;
  const korean = question.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (korean && end) return `${end.slice(0, 4)}-${korean[1].padStart(2, "0")}-${korean[2].padStart(2, "0")}`;
  return end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : null;
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
  const needsEventWindows = /이벤트|당일|전일|하루\s*전|개장|프리마켓|장전|1\s*시간|한\s*시간|event|pre.?market/i.test(question);
  const eventDate = needsEventWindows ? requestedEventDate(question, context.retrieved) : null;
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
