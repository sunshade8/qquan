import { z } from "zod";
import { claudeConfigured, describeClaudeError, generateStructured } from "@/lib/claude";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { type PriceRow } from "@/lib/market-data";
import { loadDailyRows } from "@/lib/price-cache";
import { MARKET_EVENT_CALENDAR } from "@/app/market-calendar-data";

type NewsArticle = { id: string; title: string; source: string; publishedAt: string; topic?: string; eventId?: string; eventTitle?: string; eventDate?: string; eventTimeET?: string; stage?: string };
type Payload = { date?: string; start?: string; articles?: NewsArticle[] };

const LABELS = ["강한 부정", "부정", "중립", "긍정", "강한 긍정"] as const;
const TONES = ["부정", "중립", "긍정"] as const;

const SegmentSchema = z.object({ score: z.number().min(-100).max(100), label: z.enum(LABELS), rationale: z.string() });

export const SentimentSchema = z.object({
  score: z.number().min(-100).max(100).describe("US equity risk sentiment, -100 bearish to +100 bullish"),
  label: z.enum(LABELS),
  macroTone: z.enum(TONES).describe("economic-outlook tone, separate from equity sentiment"),
  confidence: z.number().min(0).max(100).describe("0-100"),
  segments: z.object({ tech: SegmentSchema, value: SegmentSchema }),
  forecastEvents: z.array(z.object({
    indicator: z.string(), scheduledReleaseDate: z.string().nullable(), scheduledTimeET: z.string().nullable(),
    consensus: z.string().nullable(), previous: z.string().nullable(),
    expectationDirection: z.enum(["상승", "하락", "보합", "불명확"]), evidenceIds: z.array(z.string()), caveat: z.string(),
  })),
  distribution: z.object({ positive: z.number().int().min(0), neutral: z.number().int().min(0), negative: z.number().int().min(0) }),
  summary: z.string(),
  themes: z.array(z.object({ name: z.string(), tone: z.enum(TONES), evidence: z.string() })),
  marketRead: z.string(),
  hypotheses: z.array(z.string()),
  nextTest: z.string(),
  limitations: z.array(z.string()),
  articleSignals: z.array(z.object({ id: z.string(), label: z.enum(TONES), score: z.number().min(-100).max(100) })),
});

const SYSTEM = `You are the Sentiment Analyst inside a quantitative macro news research system. You score headline corpora for US equity risk sentiment.

Rules:
- Inputs are headlines and publisher names, never full articles. Do not invent article details.
- Separate economic-outlook tone from expected US equity risk sentiment. Strong growth or jobs can be economically positive but equity-bearish if it raises rate expectations.
- Score equity risk sentiment from -100 (strongly bearish) to +100 (strongly bullish). Label thresholds: <= -60 강한 부정, <= -20 부정, < 20 중립, < 60 긍정, else 강한 긍정.
- Score the same corpus separately for technology/growth stocks (rate-duration, AI capex, long-duration earnings sensitive) and value stocks (banks, energy, industrials, commodities, cyclicals). The two may have different signs.
- Use the deterministic SPY/QQQ returns only to say whether the market was already moving before the end date. Forward returns are research outcomes, never evidence available at the time.
- Treat repeated syndicated headlines as correlated evidence, not independent votes.
- For pre-release forecast headlines, extract only numeric consensus/forecast/prior values explicitly present in a headline. Never infer a number. Group by scheduled indicator and keep evidence ids.
- Suggest a falsifiable event-study specification as nextTest. Never give a trade instruction.
- distribution counts must be integers that sum to the article count. articleSignals must include every article id exactly once.
- All free text in concise Korean.`;

function marketWindow(rows: PriceRow[], date: string) {
  let anchor = -1;
  for (let index = 0; index < rows.length; index += 1) if (rows[index].date <= date) anchor = index;
  if (anchor < 0) return null;
  const change = (from: number, to: number) => from >= 0 && to < rows.length ? Number((((rows[to].close / rows[from].close) - 1) * 100).toFixed(3)) : null;
  return { anchorDate: rows[anchor].date, close: rows[anchor].close, prior1D: change(anchor - 1, anchor), prior5D: change(anchor - 5, anchor), forward1D: change(anchor, anchor + 1), forward5D: change(anchor, anchor + 5) };
}

function rangeReturn(rows: PriceRow[], start: string, end: string, symbol: string, name: string) {
  const inside = rows.filter((row) => row.date >= start && row.date <= end);
  const first = inside[0];
  const last = inside.at(-1);
  if (!first || !last) return null;
  return { symbol, name, startDate: first.date, endDate: last.date, startClose: first.close, endClose: last.close, returnPct: Number((((last.close / first.close) - 1) * 100).toFixed(3)) };
}

function shiftDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function benchmarkFrom(load: Awaited<ReturnType<typeof loadDailyRows>>, start: string, end: string, symbol: string, name: string) {
  const value = rangeReturn(load.rows, start, end, symbol, name);
  if (value) return { ...value, origin: load.origin };
  return { unavailable: load.reason ? `${name} 데이터를 불러오지 못했습니다 · ${load.reason}` : `${name}에 해당 기간(${start} → ${end})의 거래일 데이터가 없습니다.` };
}

function upcomingEvents(date: string) {
  const endDate = shiftDays(date, 3);
  return MARKET_EVENT_CALENDAR.filter((event) => event.date >= date && event.date <= endDate && event.category !== "market").map((event) => ({ date: event.date, timeET: event.time, title: event.title, importance: event.importance }));
}

export async function POST(request: Request) {
  const payload = await request.json() as Payload;
  const date = payload.date ?? "";
  const start = payload.start ?? date;
  const articles = (payload.articles ?? []).slice(0, 40).filter((article) => article.title?.trim() && article.source?.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !articles.length) return Response.json({ error: "분석 날짜와 뉴스가 필요합니다." }, { status: 400 });
  if (!claudeConfigured()) return Response.json({ error: "Claude 서버 키가 연결되지 않았습니다." }, { status: 503 });
  const ownerId = researchOwnerFrom(request);

  // Sequential loads keep the shared Worker IP under Yahoo's per-IP rate limit.
  const windowStart = shiftDays(start, -20);
  const windowEnd = shiftDays(date, 20);
  const spyLoad = await loadDailyRows("SPY", windowStart, windowEnd);
  const qqqLoad = await loadDailyRows("QQQ", windowStart, windowEnd);
  const nasdaqLoad = await loadDailyRows("^IXIC", windowStart, windowEnd);
  const nyseLoad = await loadDailyRows("^NYA", windowStart, windowEnd);
  const market = { SPY: marketWindow(spyLoad.rows, date), QQQ: marketWindow(qqqLoad.rows, date) };
  const benchmarks = { NASDAQ: benchmarkFrom(nasdaqLoad, start, date, "^IXIC", "NASDAQ Composite"), NYSE: benchmarkFrom(nyseLoad, start, date, "^NYA", "NYSE Composite") };
  const events = upcomingEvents(date);
  const headlines = articles.map((article) => ({
    id: article.id, title: article.title.slice(0, 240), source: article.source.slice(0, 80), publishedAt: article.publishedAt,
    topic: article.topic, eventId: article.eventId, eventTitle: article.eventTitle, eventDate: article.eventDate, eventTimeET: article.eventTimeET, stage: article.stage,
  }));

  const prompt = `News window (KST): ${start} through ${date}
Article count: ${articles.length}
Scheduled US events on or just after the end date: ${JSON.stringify(events)}
Deterministic adjusted-close market window (prior returns are context; forward returns are outcomes only): ${JSON.stringify(market)}
Selected-range index outcomes (outcome data, not input evidence): ${JSON.stringify(benchmarks)}
Headline corpus: ${JSON.stringify(headlines)}`;

  try {
    const result = await generateStructured({ role: "analyst", schema: SentimentSchema, system: SYSTEM, prompt, maxTokens: 6000, effort: "low", ownerId, feature: "news.sentiment_analyst" });
    const analysis = result.data;
    const total = analysis.distribution.positive + analysis.distribution.neutral + analysis.distribution.negative;
    if (total !== articles.length && total > 0) {
      const scale = articles.length / total;
      analysis.distribution.positive = Math.round(analysis.distribution.positive * scale);
      analysis.distribution.neutral = Math.round(analysis.distribution.neutral * scale);
      analysis.distribution.negative = Math.max(0, articles.length - analysis.distribution.positive - analysis.distribution.neutral);
    }
    return Response.json({ analysis, market, benchmarks, events, model: result.model, articleCount: articles.length, usage: result.usage, costUsd: result.costUsd }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    const described = describeClaudeError(error);
    console.error("[news/analyze] failed", { status: described.status, message: described.message });
    return Response.json({ error: described.message }, { status: described.status, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
