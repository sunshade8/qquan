import { env } from "cloudflare:workers";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { newsAgentMessages, newsTests } from "@/db/schema";
import { loadDailyRows } from "../../../../lib/price-cache";
import type { PriceRow } from "../../../../lib/market-data";

const COOKIE_NAME = "qquant_research_device";
let schemaReady: Promise<void> | undefined;

function ensureNewsSchema() {
  if (schemaReady) return schemaReady;
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) return Promise.reject(new Error("D1 unavailable"));
  schemaReady = (async () => {
    await binding.batch([
      binding.prepare("CREATE TABLE IF NOT EXISTS news_tests (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, period_start text NOT NULL, period_end text NOT NULL, topic text NOT NULL, article_count integer NOT NULL, overall_score real NOT NULL, overall_label text NOT NULL, tech_score real NOT NULL, tech_label text NOT NULL, value_score real NOT NULL, value_label text NOT NULL, nasdaq_payload text NOT NULL, nyse_payload text NOT NULL, forecast_payload text NOT NULL DEFAULT '[]', created_at integer NOT NULL)"),
      binding.prepare("CREATE INDEX IF NOT EXISTS idx_news_tests_owner_created ON news_tests (owner_id, created_at)"),
      binding.prepare("CREATE TABLE IF NOT EXISTS news_agent_messages (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, role text NOT NULL, content text NOT NULL, created_at integer NOT NULL)"),
      binding.prepare("CREATE INDEX IF NOT EXISTS idx_news_agent_owner_created ON news_agent_messages (owner_id, created_at)"),
    ]);
    const columns = await binding.prepare("PRAGMA table_info(news_tests)").all<{ name: string }>();
    if (!columns.results.some((column) => column.name === "forecast_payload")) {
      await binding.prepare("ALTER TABLE news_tests ADD COLUMN forecast_payload text NOT NULL DEFAULT '[]'").run();
    }
  })().catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

function ownerFrom(request: Request) {
  const match = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const existing = match?.[1];
  return existing && /^[a-f0-9-]{36}$/i.test(existing) ? existing : crypto.randomUUID();
}

function cookie(ownerId: string) {
  return `${COOKIE_NAME}=${ownerId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`;
}

function parsePayload(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function hasReturn(value: unknown) {
  return Boolean(value && typeof value === "object" && "returnPct" in value && typeof value.returnPct === "number");
}

function rangeBenchmark(rows: PriceRow[], start: string, end: string, symbol: string, name: string, origin: string) {
  const inside = rows.filter((row) => row.date >= start && row.date <= end);
  const first = inside[0];
  const last = inside.at(-1);
  if (!first || !last) return null;
  return {
    symbol, name, startDate: first.date, endDate: last.date,
    startClose: first.close, endClose: last.close,
    returnPct: Number((((last.close / first.close) - 1) * 100).toFixed(3)), origin,
  };
}

async function repairMissingBenchmarks(tests: Array<typeof newsTests.$inferSelect>, ownerId: string) {
  const missing = tests.filter((test) => !hasReturn(parsePayload(test.nasdaqPayload)) || !hasReturn(parsePayload(test.nysePayload)));
  if (!missing.length) return tests;
  let from = missing[0].periodStart;
  let to = missing[0].periodEnd;
  for (const test of missing) {
    if (test.periodStart < from) from = test.periodStart;
    if (test.periodEnd > to) to = test.periodEnd;
  }
  const [nasdaqLoad, nyseLoad] = await Promise.all([
    loadDailyRows("^IXIC", from, to),
    loadDailyRows("^NYA", from, to),
  ]);
  const db = getDb();
  await Promise.all(missing.map(async (test) => {
    const existingNasdaq = parsePayload(test.nasdaqPayload);
    const existingNyse = parsePayload(test.nysePayload);
    const nasdaq = hasReturn(existingNasdaq) ? existingNasdaq : rangeBenchmark(nasdaqLoad.rows, test.periodStart, test.periodEnd, "^IXIC", "NASDAQ Composite", nasdaqLoad.origin);
    const nyse = hasReturn(existingNyse) ? existingNyse : rangeBenchmark(nyseLoad.rows, test.periodStart, test.periodEnd, "^NYA", "NYSE Composite", nyseLoad.origin);
    if (!nasdaq && !nyse) return;
    test.nasdaqPayload = JSON.stringify(nasdaq ?? existingNasdaq);
    test.nysePayload = JSON.stringify(nyse ?? existingNyse);
    await db.update(newsTests).set({ nasdaqPayload: test.nasdaqPayload, nysePayload: test.nysePayload })
      .where(and(eq(newsTests.ownerId, ownerId), eq(newsTests.id, test.id)));
  }));
  return tests;
}

export async function GET(request: Request) {
  const ownerId = ownerFrom(request);
  try {
    await ensureNewsSchema();
    const db = getDb();
    const [storedTests, messages] = await Promise.all([
      db.select().from(newsTests).where(eq(newsTests.ownerId, ownerId)).orderBy(desc(newsTests.createdAt)).limit(100),
      db.select().from(newsAgentMessages).where(eq(newsAgentMessages.ownerId, ownerId)).orderBy(asc(newsAgentMessages.createdAt)).limit(200),
    ]);
    let tests = storedTests;
    try {
      tests = await repairMissingBenchmarks(storedTests, ownerId);
    } catch (error) {
      console.error("[news/research-state] benchmark repair failed", { ownerId, error: error instanceof Error ? error.message : String(error) });
    }
    return Response.json({
      tests: tests.reverse().map((item) => ({
        id: item.id, periodStart: item.periodStart, periodEnd: item.periodEnd, topic: item.topic,
        articleCount: item.articleCount, overallScore: item.overallScore, overallLabel: item.overallLabel,
        techScore: item.techScore, techLabel: item.techLabel, valueScore: item.valueScore, valueLabel: item.valueLabel,
        nasdaq: parsePayload(item.nasdaqPayload), nyse: parsePayload(item.nysePayload), forecastEvents: parsePayload(item.forecastPayload), createdAt: item.createdAt,
      })),
      messages: messages.map((item) => ({ id: item.id, role: item.role, content: item.content, createdAt: item.createdAt })),
    }, { headers: { "set-cookie": cookie(ownerId) } });
  } catch {
    return Response.json({ tests: [], messages: [], persistence: "unavailable" }, { headers: { "set-cookie": cookie(ownerId) } });
  }
}

export async function POST(request: Request) {
  const ownerId = ownerFrom(request);
  const payload = await request.json() as Record<string, unknown>;
  const kind = payload.kind;
  try {
    await ensureNewsSchema();
    if (kind === "test") {
      const test = payload.test as Record<string, unknown> | undefined;
      if (!test || typeof test.periodStart !== "string" || typeof test.periodEnd !== "string") return Response.json({ error: "테스트 기간이 필요합니다." }, { status: 400 });
      const row = {
        id: typeof test.id === "string" ? test.id : crypto.randomUUID(), ownerId,
        periodStart: test.periodStart, periodEnd: test.periodEnd,
        topic: typeof test.topic === "string" ? test.topic : "macro",
        articleCount: Number(test.articleCount) || 0,
        overallScore: Number(test.overallScore) || 0, overallLabel: String(test.overallLabel || "중립"),
        techScore: Number(test.techScore) || 0, techLabel: String(test.techLabel || "중립"),
        valueScore: Number(test.valueScore) || 0, valueLabel: String(test.valueLabel || "중립"),
        nasdaqPayload: JSON.stringify(test.nasdaq ?? null), nysePayload: JSON.stringify(test.nyse ?? null),
        forecastPayload: JSON.stringify(Array.isArray(test.forecastEvents) ? test.forecastEvents : []),
        createdAt: new Date(typeof test.createdAt === "string" ? test.createdAt : Date.now()),
      };
      await getDb().insert(newsTests).values(row).onConflictDoNothing();
      return Response.json({ test: { ...row, nasdaq: test.nasdaq ?? null, nyse: test.nyse ?? null }, persisted: true }, { status: 201, headers: { "set-cookie": cookie(ownerId) } });
    }
    if (kind === "message") {
      const message = payload.message as Record<string, unknown> | undefined;
      const role = message?.role === "agent" ? "agent" : "user";
      const content = typeof message?.content === "string" ? message.content.trim().slice(0, 12000) : "";
      if (!content) return Response.json({ error: "메시지가 비어 있습니다." }, { status: 400 });
      const row = { id: typeof message?.id === "string" ? message.id : crypto.randomUUID(), ownerId, role, content, createdAt: new Date() };
      await getDb().insert(newsAgentMessages).values(row).onConflictDoNothing();
      return Response.json({ message: row, persisted: true }, { status: 201, headers: { "set-cookie": cookie(ownerId) } });
    }
    return Response.json({ error: "지원하지 않는 기록입니다." }, { status: 400 });
  } catch {
    return Response.json({ error: "기록 저장소에 연결하지 못했습니다." }, { status: 503, headers: { "set-cookie": cookie(ownerId) } });
  }
}
