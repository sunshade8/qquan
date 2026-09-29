import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { ORDER_TYPE_NOTES, SLOTS, UNBACKTESTABLE_SESSION, slotWindowKst } from "@/lib/trade-slots";
import { liquidityTable } from "@/lib/symbol-liquidity";
import { slotTargetGrid } from "@/lib/relay-targets";
import { registeredRelayStrategies } from "@/lib/strategy-generation-store";
import { tossTradingStatus } from "@/lib/toss-orders";

export const dynamic = "force-dynamic";

/**
 * The relay board: the day's slots, what is assigned to each, and the symbol
 * cost table that decides which names are worth trading intraday at all.
 */
export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const headers = { "set-cookie": researchOwnerCookie(ownerId) };
  const RELAY_STRATEGIES = await registeredRelayStrategies();
  const today = new Date().toISOString().slice(0, 10);
  const toss = await tossTradingStatus().catch((error) => ({
    ready: false, reason: error instanceof Error ? error.message : "토스 상태 확인 실패",
    cause: "unknown" as const, egressIp: null, account: null, buyingPowerUsd: null,
    usCommissionRate: null, usCommissionEndDate: null, orderMode: "loc" as const,
  }));

  const slots = SLOTS.map((slot) => {
    const assigned = RELAY_STRATEGIES.find((strategy) => strategy.slot === slot.id) ?? null;
    return {
      id: slot.id, label: slot.label, rationale: slot.rationale,
      session: slot.session, liquidity: slot.liquidity,
      et: { from: slot.from, to: slot.to },
      kst: slotWindowKst(slot, today),
      strategy: assigned ? { id: assigned.id, name: assigned.name, summary: assigned.summary, universe: assigned.universe } : null,
    };
  });

  // The default row of the grid: the cheapest symbol, a 1% stop at 2:1, and a
  // setup on three sessions in five — pessimistic enough to be worth planning against.
  const targets = slotTargetGrid({ symbol: "RKLB", stopPct: 1, rewardRisk: 2, fireRate: 0.6 });

  return Response.json({
    slots, liquidity: liquidityTable(), toss,
    registered: RELAY_STRATEGIES.length,
    targets, targetAssumptions: { symbol: "RKLB", stopPct: 1, rewardRisk: 2, fireRate: 0.6 },
    orderTypes: ORDER_TYPE_NOTES, excludedSession: UNBACKTESTABLE_SESSION,
  }, { headers });
}
