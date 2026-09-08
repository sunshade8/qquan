import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { TRADE_STRATEGIES, tradeStrategyById } from "@/lib/trade-strategies";
import { deleteInstance, ensureInstance, getInstanceByKey, listInstances, listReports, updateInstance } from "@/lib/trade-strategy-store";
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

const DEFAULT_CAPITAL_USD = 10_000;

/**
 * One card per strategy in the code registry, always.
 *
 * The settings row is joined in when it exists and defaulted when it does not,
 * so a fresh deployment — new database, or just a browser the owner cookie has
 * never seen — draws the same board as a warmed-up one. Nothing here creates a
 * row; that happens on the first backtest or trade, which is when the owner has
 * actually chosen something worth remembering.
 */
export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const headers = { "set-cookie": researchOwnerCookie(ownerId) };
  // The account probe is a live call, so a broker outage must not take the board
  // down with it — the catalog is readable either way.
  const toss = await tossTradingStatus().catch((error) => ({ ready: false, reason: error instanceof Error ? error.message : "토스 상태 확인 실패", cause: "unknown" as const, egressIp: null, account: null, buyingPowerUsd: null, usCommissionRate: null, usCommissionEndDate: null, orderMode: "loc" as const }));

  let saved: Awaited<ReturnType<typeof listInstances>> = [];
  let persistence: string | undefined;
  try {
    saved = await listInstances(ownerId);
  } catch (error) {
    console.error("[trade-strategies] read failed", error instanceof Error ? error.message : error);
    persistence = "unavailable";
  }

  const cards = await Promise.all(TRADE_STRATEGIES.map(async (strategy) => {
    const instance = saved.find((row) => row.strategyKey === strategy.id) ?? null;
    const reports = instance ? await listReports(ownerId, instance.id, 12).catch(() => []) : [];
    return {
      key: strategy.id,
      id: instance?.id ?? null,
      name: strategy.name,
      capitalUsd: instance?.capitalUsd ?? DEFAULT_CAPITAL_USD,
      gateway: instance?.gateway ?? "dry_run",
      lastBacktestAt: instance?.lastBacktestAt ?? null,
      lastTradeAt: instance?.lastTradeAt ?? null,
      configured: Boolean(instance),
      reports,
    };
  }));

  return Response.json({ catalog: catalog(), cards, toss, defaultCapitalUsd: DEFAULT_CAPITAL_USD, persistence }, { headers });
}

/** Settings for one coded strategy, keyed by the rule rather than by a row id. */
export async function PATCH(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json().catch(() => ({})) as { strategyKey?: string; capitalUsd?: number; gateway?: string };
  const strategy = tradeStrategyById(String(payload.strategyKey ?? ""));
  if (!strategy) return Response.json({ error: "등록되지 않은 전략입니다." }, { status: 400 });
  const patch: { capitalUsd?: number; gateway?: "dry_run" | "toss" } = {};
  if (Number.isFinite(Number(payload.capitalUsd)) && Number(payload.capitalUsd) >= 100) patch.capitalUsd = Math.round(Number(payload.capitalUsd) * 100) / 100;
  if (payload.gateway === "toss" || payload.gateway === "dry_run") patch.gateway = payload.gateway;
  if (!Object.keys(patch).length) return Response.json({ error: "바꿀 값이 없습니다." }, { status: 400 });
  try {
    const instance = await ensureInstance(ownerId, { strategyKey: strategy.id, name: strategy.name, capitalUsd: patch.capitalUsd ?? DEFAULT_CAPITAL_USD, gateway: patch.gateway ?? "dry_run" });
    await updateInstance(ownerId, instance.id, patch);
    return Response.json({ ok: true }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    console.error("[trade-strategies] patch failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "전략 설정을 저장하지 못했습니다." }, { status: 503 });
  }
}

/**
 * Clears a strategy's history — reports, fills and positions — without removing
 * the card. The card is code; there is nothing to remove.
 */
export async function DELETE(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const strategyKey = new URL(request.url).searchParams.get("strategyKey");
  if (!strategyKey) return Response.json({ error: "strategyKey가 필요합니다." }, { status: 400 });
  try {
    const instance = await getInstanceByKey(ownerId, strategyKey);
    if (instance) await deleteInstance(ownerId, instance.id);
    return Response.json({ ok: true }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    console.error("[trade-strategies] clear failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "전략을 삭제하지 못했습니다." }, { status: 503 });
  }
}
