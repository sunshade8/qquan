import { validConversationId } from "@/lib/conversations";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { normalizeSpec } from "@/lib/strategy";
import { deleteStrategy, getStrategy, listRuns, listStrategies, saveStrategy, updateStrategyStatus, type StrategyStatus } from "@/lib/strategy-store";

const STATUSES: StrategyStatus[] = ["draft", "backtested", "candidate", "rejected", "paper", "live"];

export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const id = new URL(request.url).searchParams.get("id");
  try {
    if (id) {
      const strategy = await getStrategy(ownerId, id);
      if (!strategy) return Response.json({ error: "전략을 찾지 못했습니다." }, { status: 404, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
      return Response.json({ strategy, runs: await listRuns(ownerId, id) }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
    }
    return Response.json({ strategies: await listStrategies(ownerId) }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    console.error("[strategies] read failed", error instanceof Error ? error.message : error);
    return Response.json({ strategies: [], persistence: "unavailable" }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  }
}

export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json().catch(() => ({})) as { id?: string; spec?: unknown; sourceConversationId?: string };
  const today = new Date().toISOString().slice(0, 10);
  const { spec, errors } = normalizeSpec(payload.spec, today);
  if (!spec) return Response.json({ error: `전략 사양이 올바르지 않습니다: ${errors.join(" ")}`, errors }, { status: 400 });
  try {
    const strategy = await saveStrategy(ownerId, spec, { id: typeof payload.id === "string" ? payload.id : undefined, sourceConversationId: validConversationId(payload.sourceConversationId) ? payload.sourceConversationId : undefined });
    return Response.json({ strategy }, { status: 201, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    console.error("[strategies] save failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "전략 저장소에 연결하지 못했습니다." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json().catch(() => ({})) as { id?: string; status?: string };
  if (!payload.id || !STATUSES.includes(payload.status as StrategyStatus)) return Response.json({ error: "id와 status가 필요합니다." }, { status: 400 });
  try {
    await updateStrategyStatus(ownerId, payload.id, payload.status as StrategyStatus);
    return Response.json({ strategy: await getStrategy(ownerId, payload.id) }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ error: "전략 저장소에 연결하지 못했습니다." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id가 필요합니다." }, { status: 400 });
  try {
    await deleteStrategy(ownerId, id);
    return Response.json({ deleted: true }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch {
    return Response.json({ error: "전략 저장소에 연결하지 못했습니다." }, { status: 503 });
  }
}
