import { env } from "cloudflare:workers";
import { callClaude, ClaudeApiError } from "@/lib/anthropic";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { type PriceRow } from "../../../../lib/market-data";
import { loadDailyRows } from "../../../../lib/price-cache";
import { MARKET_EVENT_CALENDAR } from "../../../market-calendar-data";

type NewsArticle = { id: string; title: string; source: string; publishedAt: string; topic?: string; eventId?: string; eventTitle?: string; eventDate?: string; eventTimeET?: string; stage?: string };
type Payload = { date?: string; start?: string; articles?: NewsArticle[] };

function marketWindow(rows: PriceRow[], date: string) {
  let anchor = -1;
  for (let index = 0; index < rows.length; index += 1) if (rows[index].date <= date) anchor = index;
  if (anchor < 0) return null;
  const change = (from: number, to: number) => from >= 0 && to < rows.length ? Number((((rows[to].close / rows[from].close) - 1) * 100).toFixed(3)) : null;
  return {
    anchorDate: rows[anchor].date,
    close: rows[anchor].close,
    prior1D: change(anchor - 1, anchor),
    prior5D: change(anchor - 5, anchor),
    forward1D: change(anchor, anchor + 1),
    forward5D: change(anchor, anchor + 5),
  };
}

function rangeReturn(rows: PriceRow[], start: string, end: string, symbol: string, name: string) {
  const first = rows.find((row) => row.date >= start && row.date <= end);
  let last: PriceRow | undefined;
  for (const row of rows) if (row.date >= start && row.date <= end) last = row;
  if (!first || !last) return null;
  return {
    symbol,
    name,
    startDate: first.date,
    endDate: last.date,
    startClose: first.close,
    endClose: last.close,
    returnPct: Number((((last.close / first.close) - 1) * 100).toFixed(3)),
  };
}

function shiftDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

type Benchmark = ReturnType<typeof rangeReturn> & object;
type BenchmarkResult = (Benchmark & { origin: string }) | { unavailable: string };

function benchmarkFrom(load: Awaited<ReturnType<typeof loadDailyRows>>, start: string, end: string, symbol: string, name: string): BenchmarkResult {
  const value = rangeReturn(load.rows, start, end, symbol, name);
  if (value) return { ...value, origin: load.origin };
  const reason = load.reason
    ? `${name} 데이터를 불러오지 못했습니다 · ${load.reason}`
    : `${name}에 해당 기간(${start} → ${end})의 거래일 데이터가 없습니다.`;
  return { unavailable: reason };
}

function upcomingEvents(date: string) {
  const end = new Date(`${date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 3);
  const endDate = end.toISOString().slice(0, 10);
  return MARKET_EVENT_CALENDAR.filter((event) => event.date >= date && event.date <= endDate && event.category !== "market")
    .map((event) => ({ date: event.date, timeET: event.time, title: event.title, importance: event.importance }));
}

function parseJson(text: string) {
  const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  try {
    return JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned) as unknown;
  } catch {
    return { raw: text };
  }
}

function normalizeAnalysis(value: unknown, articleCount: number) {
  if (!value || typeof value !== "object" || "raw" in value) return value;
  const analysis = value as Record<string, unknown>;
  if (typeof analysis.confidence === "number" && analysis.confidence <= 1) analysis.confidence = Math.round(analysis.confidence * 100);
  if (analysis.distribution && typeof analysis.distribution === "object") {
    const distribution = analysis.distribution as Record<string, unknown>;
    const values = [distribution.positive, distribution.neutral, distribution.negative];
    if (values.every((item) => typeof item === "number" && item <= 1)) {
      distribution.positive = Math.round(Number(distribution.positive) * articleCount);
      distribution.neutral = Math.round(Number(distribution.neutral) * articleCount);
      distribution.negative = Math.max(0, articleCount - Number(distribution.positive) - Number(distribution.neutral));
    }
  }
  return analysis;
}

export async function POST(request: Request) {
  const payload = await request.json() as Payload;
  const date = payload.date ?? "";
  const start = payload.start ?? date;
  const articles = (payload.articles ?? []).slice(0, 40).filter((article) => article.title?.trim() && article.source?.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !articles.length) return Response.json({ error: "분석 날짜와 뉴스가 필요합니다." }, { status: 400 });

  const bindings = env as unknown as Record<string, string | undefined>;
  const apiKey = bindings.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const model = bindings.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  if (!apiKey) return Response.json({ error: "Claude 서버 키가 연결되지 않았습니다." }, { status: 503 });
  const ownerId = researchOwnerFrom(request);

  // Only the bars around the selected range are needed. Requesting ten years
  // for four symbols at once is what tripped Yahoo's per-IP rate limit and left
  // every benchmark null. Fetch sequentially over a padded window instead.
  const windowStart = shiftDays(start, -20);
  const windowEnd = shiftDays(date, 20);
  const [spyLoad, qqqLoad, nasdaqLoad, nyseLoad] = [
    await loadDailyRows("SPY", windowStart, windowEnd),
    await loadDailyRows("QQQ", windowStart, windowEnd),
    await loadDailyRows("^IXIC", windowStart, windowEnd),
    await loadDailyRows("^NYA", windowStart, windowEnd),
  ];
  const market = {
    SPY: marketWindow(spyLoad.rows, date),
    QQQ: marketWindow(qqqLoad.rows, date),
  };
  const benchmarks = {
    NASDAQ: benchmarkFrom(nasdaqLoad, start, date, "^IXIC", "NASDAQ Composite"),
    NYSE: benchmarkFrom(nyseLoad, start, date, "^NYA", "NYSE Composite"),
  };
  console.log("[news/analyze] price windows", {
    window: `${windowStart}..${windowEnd}`,
    loads: { SPY: spyLoad.origin, QQQ: qqqLoad.origin, IXIC: nasdaqLoad.origin, NYA: nyseLoad.origin },
    reasons: [spyLoad, qqqLoad, nasdaqLoad, nyseLoad].map((load) => load.reason).filter(Boolean),
  });
  const events = upcomingEvents(date);
  const headlines = articles.map((article) => ({
    id: article.id, title: article.title.slice(0, 240), source: article.source.slice(0, 80), publishedAt: article.publishedAt,
    topic: article.topic, eventId: article.eventId, eventTitle: article.eventTitle, eventDate: article.eventDate, eventTimeET: article.eventTimeET, stage: article.stage,
  }));

  const prompt = `You are a quantitative macro news research assistant. Analyze the supplied headline corpus only.

Rules:
- These are headlines and publisher names, not full article bodies. Do not invent article details.
- Separate economic-outlook tone from expected US equity risk sentiment. Strong growth or jobs can be economically positive but equity-bearish if it raises rate expectations.
- Score equity risk sentiment from -100 (strongly bearish) to +100 (strongly bullish).
- Score the same corpus separately for technology/growth stocks and value stocks. Technology/growth is more rate-duration, AI capex, and long-duration earnings sensitive; value is more bank, energy, industrial, commodity, and cyclical sensitive. The two scores may have different signs.
- Explain whether the market was already moving before the selected date using the deterministic SPY/QQQ returns. Forward returns are outcomes for research, never evidence that was available at the time.
- Treat repeated syndicated headlines as correlated evidence, not independent votes.
- For pre-release forecast headlines, extract only numeric consensus/forecast and prior values explicitly present in a headline. Never infer a number from general wording. Group articles by scheduled indicator and preserve their evidence ids.
- Suggest a falsifiable event-study specification. Do not give a trade instruction.
- Keep every field concise. distribution values must be integer article counts that sum to ${articles.length}.
- Respond in Korean as strict JSON with this shape:
{"score":number,"label":"강한 부정|부정|중립|긍정|강한 긍정","macroTone":"부정|중립|긍정","confidence":number,"segments":{"tech":{"score":number,"label":"강한 부정|부정|중립|긍정|강한 긍정","rationale":string},"value":{"score":number,"label":"강한 부정|부정|중립|긍정|강한 긍정","rationale":string}},"forecastEvents":[{"indicator":string,"scheduledReleaseDate":string|null,"scheduledTimeET":string|null,"consensus":string|null,"previous":string|null,"expectationDirection":"상승|하락|보합|불명확","evidenceIds":[string],"caveat":string}],"distribution":{"positive":number,"neutral":number,"negative":number},"summary":string,"themes":[{"name":string,"tone":"부정|중립|긍정","evidence":string}],"marketRead":string,"hypotheses":[string],"nextTest":string,"limitations":[string],"articleSignals":[{"id":string,"label":"부정|중립|긍정","score":number}]}

News window (KST): ${start} through ${date}
Scheduled US events on or just after the end date: ${JSON.stringify(events)}
Deterministic adjusted-close market window: ${JSON.stringify(market)}
Selected-range index outcomes (first to last available close; outcome data, not input evidence): ${JSON.stringify(benchmarks)}
Headline corpus: ${JSON.stringify(headlines)}`;

  try {
    const result = await callClaude({ apiKey, model, prompt, maxTokens: 3600, ownerId, feature: "news.sentiment_analyst" });
    return Response.json({ analysis: normalizeAnalysis(parseJson(result.text), articles.length), market, benchmarks, events, model, articleCount: articles.length, usage: result.usage, costUsd: result.costUsd }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    const status = error instanceof ClaudeApiError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Claude 뉴스 분석 호출에 실패했습니다." }, { status, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
