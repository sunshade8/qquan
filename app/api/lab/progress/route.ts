import { readLabRunProgress, writeLabRunProgress } from "@/lib/lab-runs";
import { validConversationId } from "@/lib/conversations";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const runId = new URL(request.url).searchParams.get("run");
  if (!validConversationId(runId)) return Response.json({ error: "유효한 실행 ID가 필요합니다." }, { status: 400 });
  try {
    const progress = await readLabRunProgress(ownerId, runId);
    return Response.json({ progress }, { status: progress ? 200 : 202, headers: { "cache-control": "no-store", "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ error: "진행 상태 저장소에 연결하지 못했습니다." }, { status: 503, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}

export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json().catch(() => ({})) as { runId?: string; conversationId?: string };
  if (!validConversationId(payload.runId) || !validConversationId(payload.conversationId)) return Response.json({ error: "유효한 실행 ID와 대화 ID가 필요합니다." }, { status: 400 });
  try {
    await writeLabRunProgress(ownerId, {
      id: payload.runId,
      conversationId: payload.conversationId,
      phase: "connecting",
      label: "요청 접수 중",
      detail: "대화와 실행 세션을 준비하고 있습니다.",
      status: "running",
    });
    return Response.json({ initialized: true }, { status: 201, headers: { "cache-control": "no-store", "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ error: "진행 상태를 시작하지 못했습니다." }, { status: 503, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}
