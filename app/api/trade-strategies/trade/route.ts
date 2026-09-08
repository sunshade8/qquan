/**
 * Live execution for one strategy card.
 *
 * Three deliberate constraints, because this endpoint is the one that can move
 * real money:
 *
 * 1. `submit` defaults to false. A plain call is a preview and sends nothing.
 * 2. Submitting also requires `confirm: "매매"`, so a mis-clicked button or a
 *    replayed preview request cannot become an order.
 * 3. Every accepted order is written to the paper ledger regardless of gateway,
 *    so the strategy's realised track record exists whether or not the broker
 *    connection does — and the ledger is what the backtest gets compared to.
 */

import { costBps } from "@/lib/broker-costs";
import { recordPaperFill } from "@/lib/paper-ledger-store";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { tradeStrategyById } from "@/lib/trade-strategies";
import { planLive } from "@/lib/trade-strategy-runner";
import { renderTradeMarkdown, tradeFilename } from "@/lib/trade-strategy-report";
import { ensureInstance, saveReport, updateInstance } from "@/lib/trade-strategy-store";
import { gatewayFor, type OrderIntent } from "@/lib/trading";
import { tossTradingStatus } from "@/lib/toss-orders";

const CONFIRM_PHRASE = "매매";

export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const headers = { "set-cookie": researchOwnerCookie(ownerId) };
  const payload = await request.json().catch(() => ({})) as { strategyKey?: string; capitalUsd?: number; gateway?: string; submit?: boolean; confirm?: string };
  const strategy = tradeStrategyById(String(payload.strategyKey ?? ""));
  if (!strategy) return Response.json({ error: "등록되지 않은 전략입니다." }, { status: 400 });

  const capitalUsd = Number(payload.capitalUsd);
  const instance = await ensureInstance(ownerId, {
    strategyKey: strategy.id, name: strategy.name,
    capitalUsd: Number.isFinite(capitalUsd) && capitalUsd >= 100 ? capitalUsd : 10_000,
    gateway: payload.gateway === "toss" ? "toss" : "dry_run",
  }).catch(() => null);
  if (!instance) return Response.json({ error: "전략 저장소에 연결하지 못했습니다." }, { status: 503 });

  const submit = payload.submit === true;
  if (submit && payload.confirm !== CONFIRM_PHRASE) {
    return Response.json({ error: "실행 확인이 없습니다. 주문을 보내려면 확인 절차를 거쳐야 합니다." }, { status: 400 });
  }

  // With the Toss gateway the account is the source of truth for what is held;
  // the local ledger only supplies the entry dates the exit rule runs on.
  const useBroker = instance.gateway === "toss";
  let live: Awaited<ReturnType<typeof planLive>>;
  try {
    live = await planLive(strategy, ownerId, instance.id, instance.capitalUsd, { source: useBroker ? "broker" : "ledger" });
  } catch (error) {
    console.error("[trade-strategies/trade] plan failed", error instanceof Error ? error.message : error);
    return Response.json({ error: error instanceof Error ? error.message : "주문 계획을 만들지 못했습니다." }, { status: 503 });
  }

  const gateway = gatewayFor(instance.gateway);
  const toss = await tossTradingStatus().catch(() => null);
  const generatedAt = new Date().toISOString();
  const intents: OrderIntent[] = live.plan.orders.map((order) => ({
    id: crypto.randomUUID(), strategyId: instance.id, symbol: order.symbol, side: order.side,
    quantity: order.quantity, referencePrice: order.referencePrice, notionalUsd: order.notionalUsd,
    reason: `${order.reason} [${order.rule}]`, signalDate: live.plan.asOf, generatedAt,
    broker: {
      available: Boolean(live.quotes[order.symbol]),
      price: live.quotes[order.symbol]?.price,
      bid: live.quotes[order.symbol]?.bid ?? null,
      ask: live.quotes[order.symbol]?.ask ?? null,
      session: live.quotes[order.symbol]?.session ?? undefined,
    },
  }));

  const submissions: Array<{ intentId: string; symbol: string; side: string; accepted: boolean; message: string; brokerOrderId?: string; ledger: string }> = [];
  if (submit) {
    for (const intent of intents) {
      let accepted = false;
      let message = "";
      let brokerOrderId: string | undefined;
      try {
        const response = await gateway.submit(intent);
        accepted = response.accepted;
        message = response.message;
        brokerOrderId = response.brokerOrderId;
      } catch (error) {
        message = `주문 전송 중 오류: ${error instanceof Error ? error.message : "알 수 없음"}`;
      }
      // The ledger records what the rule decided even when the broker refused,
      // so a run is never invisible; the note says which happened.
      const ledger = await recordPaperFill(ownerId, intent, costBps(), { bid: intent.broker.bid, ask: intent.broker.ask })
        .then((outcome) => outcome.recorded ? `원장 기록됨 (체결가 ${outcome.fill.fillPrice})` : `원장 미기록: ${outcome.reason}`)
        .catch((error) => `원장 기록 실패: ${error instanceof Error ? error.message : "알 수 없음"}`);
      submissions.push({ intentId: intent.id, symbol: intent.symbol, side: intent.side, accepted, message, brokerOrderId, ledger });
    }
    await updateInstance(ownerId, instance.id, { lastTradeAt: new Date(generatedAt) }).catch(() => undefined);
  }

  const markdown = renderTradeMarkdown(strategy, live.plan, {
    createdAt: generatedAt, capitalUsd: instance.capitalUsd, gateway: gateway.label, submitted: submit,
    positionsBefore: live.positions.map((position) => ({ symbol: position.symbol, quantity: position.quantity, averagePrice: position.averagePrice, entryDate: position.entryDate })),
    submissions: submissions.map((item) => ({ symbol: item.symbol, side: item.side, accepted: item.accepted, message: `${item.message} · ${item.ledger}` })),
  });

  let reportId: string | null = null;
  if (submit) {
    const saved = await saveReport(ownerId, {
      instanceId: instance.id, strategyKey: strategy.id, kind: "trade",
      title: `매매 · ${strategy.name} · ${live.plan.asOf}`,
      filename: tradeFilename(strategy, live.plan.asOf, generatedAt),
      markdown,
      summary: { asOf: live.plan.asOf, orders: intents.length, accepted: submissions.filter((item) => item.accepted).length, gateway: gateway.id },
    }).catch((error) => { console.error("[trade-strategies/trade] report save failed", error instanceof Error ? error.message : error); return null; });
    reportId = saved?.id ?? null;
  }

  return Response.json({
    asOf: live.plan.asOf,
    submitted: submit,
    gateway: {
      id: gateway.id, label: gateway.label,
      tossReady: toss?.ready ?? false,
      tossReason: toss?.reason ?? null,
      tossCause: toss?.cause ?? null,
      tossEgressIp: toss?.egressIp ?? null,
      accountNo: toss?.account?.accountNo ?? null,
      buyingPowerUsd: toss?.buyingPowerUsd ?? null,
      usCommissionRate: toss?.usCommissionRate ?? null,
      usCommissionEndDate: toss?.usCommissionEndDate ?? null,
      orderMode: toss?.orderMode ?? "loc",
    },
    capitalUsd: instance.capitalUsd,
    positionSource: live.positionSource,
    untouched: live.untouched,
    positions: live.positions,
    orders: live.plan.orders,
    skipped: live.plan.skipped,
    notes: live.plan.notes,
    quotes: live.quotes,
    missing: live.missing,
    submissions,
    markdown: submit ? markdown : null,
    reportId,
    confirmPhrase: CONFIRM_PHRASE,
  }, { headers });
}
