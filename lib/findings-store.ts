/**
 * D1 persistence for research findings. The claim shape, validation and
 * context rendering live in `lib/findings.ts` so they stay unit-testable
 * without a database, mirroring `strategy.ts` / `strategy-store.ts`.
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { researchFindings } from "@/db/schema";
import {
  confidenceOf, parseEvidence, splitList, statusOf, validateFinding,
  type Finding, type FindingInput,
} from "@/lib/findings";

function rowToFinding(row: typeof researchFindings.$inferSelect): Finding {
  return {
    id: row.id, title: row.title, claim: row.claim, evidence: parseEvidence(row.evidencePayload),
    symbols: splitList(row.symbols), tags: splitList(row.tags),
    confidence: confidenceOf(row.confidence), status: statusOf(row.status), falsification: row.falsification,
    sourceConversationId: row.sourceConversationId,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/** Insert, or update in place when `id` names an existing finding owned by the caller. */
export async function saveFinding(ownerId: string, conversationId: string | null, input: FindingInput): Promise<{ ok: true; finding: Finding; created: boolean } | { ok: false; errors: string[] }> {
  const validated = validateFinding(input);
  if (!validated.ok) return validated;
  const value = validated.value;
  await ensureSchema();
  const db = getDb();
  const now = new Date();
  const payload = {
    title: value.title, claim: value.claim, evidencePayload: JSON.stringify(value.evidence),
    symbols: value.symbols.join(","), tags: value.tags.join(","),
    confidence: value.confidence, status: value.status, falsification: value.falsification,
    updatedAt: now,
  };

  if (value.id) {
    const [existing] = await db.select().from(researchFindings).where(and(eq(researchFindings.ownerId, ownerId), eq(researchFindings.id, value.id))).limit(1);
    if (existing) {
      await db.update(researchFindings).set(payload).where(and(eq(researchFindings.ownerId, ownerId), eq(researchFindings.id, value.id)));
      const [row] = await db.select().from(researchFindings).where(eq(researchFindings.id, value.id)).limit(1);
      return { ok: true, finding: rowToFinding(row), created: false };
    }
  }

  const id = value.id ?? crypto.randomUUID();
  await db.insert(researchFindings).values({ id, ownerId, sourceConversationId: conversationId, createdAt: now, ...payload });
  const [row] = await db.select().from(researchFindings).where(eq(researchFindings.id, id)).limit(1);
  return { ok: true, finding: rowToFinding(row), created: true };
}

export async function listFindings(ownerId: string, limit = 20): Promise<Finding[]> {
  await ensureSchema();
  const rows = await getDb().select().from(researchFindings)
    .where(eq(researchFindings.ownerId, ownerId))
    .orderBy(desc(researchFindings.updatedAt))
    .limit(Math.min(100, Math.max(1, limit)));
  return rows.map(rowToFinding);
}
