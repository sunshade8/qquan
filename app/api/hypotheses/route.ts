import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { hypotheses } from "@/db/schema";

export async function GET() {
  try {
    const rows = await getDb().select().from(hypotheses).orderBy(desc(hypotheses.updatedAt)).limit(30);
    return Response.json({ hypotheses: rows });
  } catch {
    return Response.json({ hypotheses: [], persistence: "unavailable" });
  }
}

export async function POST(request: Request) {
  const payload = (await request.json()) as Record<string, string>;
  const now = new Date();
  const row = {
    id: payload.id || crypto.randomUUID(), title: payload.title?.trim() || "Untitled hypothesis",
    symbolUniverse: payload.symbolUniverse?.trim() || "S&P 500", thesis: payload.thesis?.trim() || "",
    entryRule: payload.entryRule?.trim() || "", exitRule: payload.exitRule?.trim() || "",
    sizingRule: payload.sizingRule?.trim() || "", status: payload.status || "draft", createdAt: now, updatedAt: now,
  };
  try {
    await getDb().insert(hypotheses).values(row).onConflictDoUpdate({
      target: hypotheses.id,
      set: { title: row.title, symbolUniverse: row.symbolUniverse, thesis: row.thesis, entryRule: row.entryRule, exitRule: row.exitRule, sizingRule: row.sizingRule, status: row.status, updatedAt: row.updatedAt },
    });
    return Response.json({ hypothesis: row, persisted: true }, { status: 201 });
  } catch {
    return Response.json({ hypothesis: row, persisted: false }, { status: 202 });
  }
}
