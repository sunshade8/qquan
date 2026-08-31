import { env } from "cloudflare:workers";

type AgentPayload = {
  question?: string;
  context?: {
    retrieved?: unknown;
    headlines?: unknown[];
    analysis?: unknown;
    tests?: unknown[];
  };
};

export async function POST(request: Request) {
  const payload = await request.json() as AgentPayload;
  const question = payload.question?.trim();
  if (!question) return Response.json({ error: "Agent에게 물어볼 내용을 입력해주세요." }, { status: 400 });

  const runtimeEnv = env as unknown as Record<string, string | undefined>;
  const apiKey = runtimeEnv.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const model = runtimeEnv.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  if (!apiKey) return Response.json({ error: "Claude 서버 키가 연결되지 않았습니다." }, { status: 503 });

  const context = payload.context ?? {};
  const prompt = `You are the research agent for a quantitative news-event workspace. Answer in concise Korean.

Hard rules:
- Use only the supplied headline, sentiment, and deterministic Test data. Never invent full article contents or intraday prices.
- Explicitly distinguish ex-ante headline sentiment from ex-post index returns. Association is not causation.
- Compare overall, technology/growth, and value sentiment when present; explain why the same macro news can affect them differently.
- NASDAQ Composite and NYSE Composite Test returns are close-to-close from the first to last trading day available inside the selected date range.
- Help the user form falsifiable event-study specifications, including event day, day-before, and one-hour-before-open windows when relevant, but state when the supplied data cannot yet test an intraday claim.
- Surface sample-size, timing, overlap, headline-only, and look-ahead limitations. Do not give a trade instruction.

Current news query: ${JSON.stringify(context.retrieved ?? null)}
Selected headlines: ${JSON.stringify((context.headlines ?? []).slice(0, 40))}
Current sentiment analysis: ${JSON.stringify(context.analysis ?? null)}
Saved Test rows: ${JSON.stringify((context.tests ?? []).slice(-30))}

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
