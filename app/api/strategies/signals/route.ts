import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { getStrategy, liveSignalsFor } from "@/lib/strategy-store";
import { gatewayFor } from "@/lib/trading";

/** Current signal state + sized order intents. Submission only happens through the selected gateway (dry run by default). */
export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json().catch(() => ({})) as { id?: string; capitalUsd?: number; heldSymbols?: string[]; submit?: boolean; gateway?: string };
  const headers = { "set-cookie": researchOwnerCookie(ownerId) };
  if (!payload.id) return Response.json({ error: "전략 id가 필요합니다." }, { status: 400, headers });
  try {
    const strategy = await getStrategy(ownerId, payload.id);
    if (!strategy) return Response.json({ error: "전략을 찾지 못했습니다." }, { status: 404, headers });
    const capital = Math.max(100, Number(payload.capitalUsd) || 10_000);
    const held = Array.isArray(payload.heldSymbols) ? payload.heldSymbols.map(String) : [];
    const { signals, intents, asOf } = await liveSignalsFor(strategy, capital, held);
    const gateway = gatewayFor(payload.gateway);
    const submissions = payload.submit ? await Promise.all(intents.map(async (intent) => ({ intentId: intent.id, ...(await gateway.submit(intent)) }))) : [];
    return Response.json({ asOf, capitalUsd: capital, gateway: { id: gateway.id, label: gateway.label }, signals, intents, submissions }, { headers });
  } catch (error) {
    console.error("[strategies/signals] failed", error instanceof Error ? error.message : error);
    return Response.json({ error: error instanceof Error ? error.message : "시그널 계산에 실패했습니다." }, { status: 500, headers });
  }
}
