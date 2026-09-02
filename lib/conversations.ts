import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { conversations } from "@/db/schema";

export type ConversationKind = "lab" | "news";
export type ConversationSummary = { id: string; kind: ConversationKind; title: string; preview: string; messageCount: number; createdAt: string; updatedAt: string };

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function validConversationId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function conversationTitle(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean || "새 대화";
}

/** Creates the conversation row on first use and bumps its counters afterwards. */
export async function touchConversation(ownerId: string, kind: ConversationKind, id: string, options: { titleSeed?: string; preview?: string; increment?: number }) {
  await ensureSchema();
  const db = getDb();
  const now = new Date();
  const existing = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, id))).limit(1);
  if (!existing.length) {
    await db.insert(conversations).values({ id, ownerId, kind, title: conversationTitle(options.titleSeed ?? ""), preview: (options.preview ?? "").slice(0, 200), messageCount: options.increment ?? 0, createdAt: now, updatedAt: now }).onConflictDoNothing();
    return;
  }
  await db.update(conversations).set({
    updatedAt: now,
    messageCount: sql`${conversations.messageCount} + ${options.increment ?? 0}`,
    ...(options.preview ? { preview: options.preview.slice(0, 200) } : {}),
  }).where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, id)));
}

export async function listConversations(ownerId: string, kind?: ConversationKind, limit = 60): Promise<ConversationSummary[]> {
  await ensureSchema();
  const rows = await getDb().select().from(conversations)
    .where(kind ? and(eq(conversations.ownerId, ownerId), eq(conversations.kind, kind)) : eq(conversations.ownerId, ownerId))
    .orderBy(desc(conversations.updatedAt)).limit(limit);
  return rows.filter((row) => row.messageCount > 0).map((row) => ({
    id: row.id, kind: row.kind === "news" ? "news" : "lab", title: row.title, preview: row.preview, messageCount: row.messageCount,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function deleteConversation(ownerId: string, id: string) {
  await ensureSchema();
  await getDb().delete(conversations).where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, id)));
}
