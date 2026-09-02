import { deleteConversation, listConversations, validConversationId, type ConversationKind } from "@/lib/conversations";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const kind = new URL(request.url).searchParams.get("kind");
  try {
    const items = await listConversations(ownerId, kind === "lab" || kind === "news" ? kind as ConversationKind : undefined);
    return Response.json({ conversations: items }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ conversations: [], persistence: "unavailable" }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}

export async function DELETE(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const id = new URL(request.url).searchParams.get("id");
  if (!validConversationId(id)) return Response.json({ error: "대화 id가 필요합니다." }, { status: 400 });
  try {
    await deleteConversation(ownerId, id);
    return Response.json({ deleted: true }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ error: "대화 저장소에 연결하지 못했습니다." }, { status: 503, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
