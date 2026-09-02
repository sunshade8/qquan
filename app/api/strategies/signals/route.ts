import { loadDailyRows } from "@/lib/price-cache";
import { openPositions, paperTrackRecord, recentFills, recordPaperFill, snapshotEquity } from "@/lib/paper-ledger-store";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { getStrategy, liveSignalsFor } from "@/lib/strategy-store";
import { gatewayFor } from "@/lib/trading";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Current signal state, sized order intents, and — when `record` is set — the
 * paper ledger entry for each intent.
 *
 * Recording is what closes the research loop. Until a signal is written down and
 * marked to market, a strategy that passed its backtest and a strategy that is
 * quietly losing money look identical to this system.
 *
 * Submission still only happens through the selected gateway (dry run by
 * default); nothing here places a real order.
 */
export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json().catch(() => ({})) as { id?: string; capitalUsd?: number; heldSymbols?: string[]; submit?: boolean; gateway?: string; record?: boolean };
  const headers = { "set-cookie": researchOwnerCookie(ownerId) };
  if (!payload.id) return Response.json({ error: "전략 id가 필요합니다." }, { status: 400, headers });
  try {
    const strategy = await getStrategy(ownerId, payload.id);
    if (!strategy) return Response.json({ error: "전략을 찾지 못했습니다." }, { status: 404, headers });
    const capital = Math.max(100, Number(payload.capitalUsd) || 10_000);

    // Held symbols come from the ledger when it has any, so the caller no longer
    // has to track positions itself and a repeated poll cannot re-enter a
    // position that is already open.
    const ledgerPositions = await openPositions(ownerId, strategy.id).catch(() => []);
    const held = ledgerPositions.length
      ? ledgerPositions.map((position) => position.symbol)
      : Array.isArray(payload.heldSymbols) ? payload.heldSymbols.map(String) : [];

    const { signals, intents, asOf } = await liveSignalsFor(strategy, capital, held);
    const gateway = gatewayFor(payload.gateway);
    const submissions = payload.submit ? await Promise.all(intents.map(async (intent) => ({ intentId: intent.id, ...(await gateway.submit(intent)) }))) : [];

    const recorded: unknown[] = [];
    if (payload.record) {
      for (const intent of intents) {
        const quote = signals.find((signal) => signal.symbol === intent.symbol)?.broker;
        const outcome = await recordPaperFill(ownerId, intent, strategy.spec.costBps, { bid: quote?.bid ?? null, ask: quote?.ask ?? null });
        recorded.push({ intentId: intent.id, symbol: intent.symbol, ...outcome });
      }
    }

    // Mark the book to market on every call, so an equity curve accumulates even
    // on days the rule produced no trade.
    const positions = await openPositions(ownerId, strategy.id).catch(() => []);
    let equity = null;
    let track = null;
    try {
      const priced = await Promise.all(positions.map(async (position) => {
        const match = signals.find((signal) => signal.symbol === position.symbol);
        return { symbol: position.symbol, quantity: position.quantity, averagePrice: position.averagePrice, lastPrice: match?.latestClose ?? null };
      }));
      const realized = positions.reduce((sum, position) => sum + position.realizedPnlUsd, 0);
      const invested = priced.reduce((sum, position) => sum + position.quantity * position.averagePrice, 0);
      const benchmarkRows = await loadDailyRows(strategy.spec.benchmark || "SPY", shiftDate(today(), -10), today()).catch(() => ({ rows: [] }));
      const bars = benchmarkRows.rows;
      const benchmarkReturnPct = bars.length > 1 ? Number(((bars.at(-1)!.close / bars.at(-2)!.close - 1) * 100).toFixed(4)) : null;
      equity = await snapshotEquity(ownerId, strategy.id, today(), {
        cashUsd: Math.max(0, capital - invested), positions: priced, realizedPnlUsd: realized, benchmarkReturnPct,
      });
      track = await paperTrackRecord(ownerId, strategy.id, capital);
    } catch (error) {
      console.error("[strategies/signals] ledger snapshot failed", error instanceof Error ? error.message : error);
    }

    return Response.json({
      asOf, capitalUsd: capital, gateway: { id: gateway.id, label: gateway.label },
      signals, intents, submissions,
      paper: {
        recorded, positions, equity, track,
        fills: await recentFills(ownerId, strategy.id, 20).catch(() => []),
        note: "페이퍼 원장입니다. 실제 주문은 전송되지 않습니다. 체결가는 호가를 넘어가는 보수적 가정으로 기록됩니다.",
      },
    }, { headers });
  } catch (error) {
    console.error("[strategies/signals] failed", error instanceof Error ? error.message : error);
    return Response.json({ error: error instanceof Error ? error.message : "시그널 계산에 실패했습니다." }, { status: 500, headers });
  }
}
