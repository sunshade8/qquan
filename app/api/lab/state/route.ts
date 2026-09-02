import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { labMessages } from "@/db/schema";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

function parseArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const conversation = new URL(request.url).searchParams.get("conversation");
  if (!conversation) return Response.json({ messages: [] }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  try {
    await ensureSchema();
    const rows = await getDb().select().from(labMessages).where(and(eq(labMessages.ownerId, ownerId), eq(labMessages.conversationId, conversation))).orderBy(asc(labMessages.createdAt)).limit(200);
    return Response.json({
      conversationId: conversation,
      messages: rows.map((row) => ({
        id: row.id, role: row.role, content: row.content,
        tools: parseArray(row.toolsPayload), artifacts: parseArray(row.artifactsPayload), createdAt: row.createdAt,
      })),
    }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ messages: [], persistence: "unavailable" }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}

export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json() as Record<string, unknown>;
  const message = payload.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string" ? message.content.trim().slice(0, 20_000) : "";
  if (!content) return Response.json({ error: "메시지가 비어 있습니다." }, { status: 400 });
  const row = {
    id: typeof message?.id === "string" ? message.id : crypto.randomUUID(),
    ownerId,
    conversationId: typeof payload.conversationId === "string" ? payload.conversationId : null,
    role: message?.role === "agent" ? "agent" : "user",
    content,
    toolsPayload: JSON.stringify(Array.isArray(message?.tools) ? message.tools : []),
    artifactsPayload: JSON.stringify(Array.isArray(message?.artifacts) ? message.artifacts : []),
    createdAt: new Date(typeof message?.createdAt === "string" ? message.createdAt : Date.now()),
  };
  try {
    await ensureSchema();
    await getDb().insert(labMessages).values(row).onConflictDoNothing();
    return Response.json({ persisted: true, message: row }, { status: 201, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ error: "Lab 기록 저장소에 연결하지 못했습니다." }, { status: 503, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}

export async function DELETE(request: Request) {
  const ownerId = researchOwnerFrom(request);
  try {
    await ensureSchema();
    await getDb().delete(labMessages).where(eq(labMessages.ownerId, ownerId));
    return Response.json({ cleared: true }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ error: "Lab 기록 저장소에 연결하지 못했습니다." }, { status: 503, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
