import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { TRADE_STRATEGIES, tradeStrategyById } from "@/lib/trade-strategies";
import { createInstance, deleteInstance, listInstances, listReports, updateInstance } from "@/lib/trade-strategy-store";
import { tossTradingStatus } from "@/lib/toss-orders";

/** The catalog is code, so it is described here rather than read from the database. */
function catalog() {
  return TRADE_STRATEGIES.map((strategy) => ({
    key: strategy.id, name: strategy.name, summary: strategy.summary,
    universe: strategy.universe, universeCount: strategy.universe.length,
    benchmark: strategy.benchmark, rules: strategy.rules, evidence: strategy.evidence,
    cautions: strategy.cautions, params: strategy.params,
  }));
}

export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const headers = { "set-cookie": researchOwnerCookie(ownerId) };
  // The account probe is a live call, so a broker outage must not take the board
  // down with it — the catalog and the saved cards are readable either way.
  const toss = await tossTradingStatus().catch((error) => ({ ready: false, reason: error instanceof Error ? error.message : "토스 상태 확인 실패", account: null, buyingPowerUsd: null, usCommissionRate: null, usCommissionEndDate: null, orderMode: "loc" as const }));
  try {
    const instances = await listInstances(ownerId);
    const withReports = await Promise.all(instances.map(async (instance) => ({ ...instance, reports: await listReports(ownerId, instance.id, 12) })));
    return Response.json({ catalog: catalog(), instances: withReports, toss }, { headers });
  } catch (error) {
    console.error("[trade-strategies] read failed", error instanceof Error ? error.message : error);
    return Response.json({ catalog: catalog(), instances: [], toss, persistence: "unavailable" }, { headers });
  }
}

export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json().catch(() => ({})) as { strategyKey?: string; capitalUsd?: number; gateway?: string };
  const strategy = tradeStrategyById(String(payload.strategyKey ?? ""));
  if (!strategy) return Response.json({ error: "등록되지 않은 전략입니다." }, { status: 400 });
  const capitalUsd = Number(payload.capitalUsd);
  if (!Number.isFinite(capitalUsd) || capitalUsd < 100) return Response.json({ error: "자본은 100 USD 이상이어야 합니다." }, { status: 400 });
  try {
    const id = await createInstance(ownerId, {
      strategyKey: strategy.id, name: strategy.name,
      capitalUsd: Math.round(capitalUsd * 100) / 100,
      gateway: payload.gateway === "toss" ? "toss" : "dry_run",
    });
    return Response.json({ id, instances: await listInstances(ownerId) }, { status: 201, headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    console.error("[trade-strategies] create failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "전략 저장소에 연결하지 못했습니다." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json().catch(() => ({})) as { id?: string; capitalUsd?: number; gateway?: string };
  if (!payload.id) return Response.json({ error: "id가 필요합니다." }, { status: 400 });
  const patch: { capitalUsd?: number; gateway?: "dry_run" | "toss" } = {};
  if (Number.isFinite(Number(payload.capitalUsd)) && Number(payload.capitalUsd) >= 100) patch.capitalUsd = Math.round(Number(payload.capitalUsd) * 100) / 100;
  if (payload.gateway === "toss" || payload.gateway === "dry_run") patch.gateway = payload.gateway;
  if (!Object.keys(patch).length) return Response.json({ error: "바꿀 값이 없습니다." }, { status: 400 });
  try {
    await updateInstance(ownerId, payload.id, patch);
    return Response.json({ instances: await listInstances(ownerId) }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    console.error("[trade-strategies] patch failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "전략을 수정하지 못했습니다." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id가 필요합니다." }, { status: 400 });
  try {
    await deleteInstance(ownerId, id);
    return Response.json({ instances: await listInstances(ownerId) }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    console.error("[trade-strategies] delete failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "전략을 삭제하지 못했습니다." }, { status: 503 });
  }
}
