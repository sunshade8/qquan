import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { newsAgentMessages, newsResearchRuns, newsTests } from "@/db/schema";
import { loadDailyRows } from "../../../../lib/price-cache";
import type { PriceRow } from "../../../../lib/market-data";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { touchConversation, validConversationId } from "@/lib/conversations";

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
  const ownerId = researchOwnerFrom(request);
  const conversation = new URL(request.url).searchParams.get("conversation");
  try {
    await ensureSchema();
    const db = getDb();
    const [storedTests, messages, runs] = await Promise.all([
      db.select().from(newsTests).where(eq(newsTests.ownerId, ownerId)).orderBy(desc(newsTests.createdAt)).limit(100),
      conversation ? db.select().from(newsAgentMessages).where(and(eq(newsAgentMessages.ownerId, ownerId), eq(newsAgentMessages.conversationId, conversation))).orderBy(asc(newsAgentMessages.createdAt)).limit(200) : Promise.resolve([]),
      db.select().from(newsResearchRuns).where(eq(newsResearchRuns.ownerId, ownerId)).orderBy(desc(newsResearchRuns.updatedAt)).limit(20),
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
      runs: runs.map((item) => ({
        id: item.id, command: item.command, label: item.label, status: item.status,
        totalEvents: item.totalEvents, completedEvents: item.completedEvents, failedEvents: item.failedEvents,
        stages: parsePayload(item.stagesPayload), result: parsePayload(item.resultPayload),
        createdAt: item.createdAt, updatedAt: item.updatedAt,
      })),
    }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ tests: [], messages: [], runs: [], persistence: "unavailable" }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}

export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json() as Record<string, unknown>;
  const kind = payload.kind;
  try {
    await ensureSchema();
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
      return Response.json({ test: { ...row, nasdaq: test.nasdaq ?? null, nyse: test.nyse ?? null }, persisted: true }, { status: 201, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
    }
    if (kind === "message") {
      const message = payload.message as Record<string, unknown> | undefined;
      const role = message?.role === "agent" ? "agent" : "user";
      const content = typeof message?.content === "string" ? message.content.trim().slice(0, 12000) : "";
      if (!content) return Response.json({ error: "메시지가 비어 있습니다." }, { status: 400 });
      const conversationId = validConversationId(payload.conversationId) ? payload.conversationId : null;
      const row = { id: typeof message?.id === "string" ? message.id : crypto.randomUUID(), ownerId, conversationId, role, content, createdAt: new Date() };
      await getDb().insert(newsAgentMessages).values(row).onConflictDoNothing();
      if (conversationId) await touchConversation(ownerId, "news", conversationId, { titleSeed: role === "user" ? content : undefined, preview: content, increment: 1 }).catch(() => undefined);
      return Response.json({ message: row, persisted: true }, { status: 201, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
    }
    if (kind === "run") {
      const run = payload.run as Record<string, unknown> | undefined;
      if (!run || typeof run.id !== "string" || typeof run.command !== "string") return Response.json({ error: "연구 실행 정보가 필요합니다." }, { status: 400 });
      const now = new Date();
      const row = {
        id: run.id, ownerId, command: run.command.slice(0, 2000), label: String(run.label || "News research").slice(0, 120),
        status: String(run.status || "running").slice(0, 24), totalEvents: Math.max(0, Number(run.totalEvents) || 0),
        completedEvents: Math.max(0, Number(run.completedEvents) || 0), failedEvents: Math.max(0, Number(run.failedEvents) || 0),
        stagesPayload: JSON.stringify(Array.isArray(run.stages) ? run.stages : []),
        resultPayload: JSON.stringify(run.result && typeof run.result === "object" ? run.result : {}),
        createdAt: new Date(typeof run.createdAt === "string" ? run.createdAt : now), updatedAt: now,
      };
      await getDb().insert(newsResearchRuns).values(row).onConflictDoUpdate({
        target: newsResearchRuns.id,
        set: {
          status: row.status, completedEvents: row.completedEvents, failedEvents: row.failedEvents,
          stagesPayload: row.stagesPayload, resultPayload: row.resultPayload, updatedAt: row.updatedAt,
        },
      });
      return Response.json({ run: row, persisted: true }, { status: 201, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
    }
    return Response.json({ error: "지원하지 않는 기록입니다." }, { status: 400 });
  } catch {
    return Response.json({ error: "기록 저장소에 연결하지 못했습니다." }, { status: 503, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
