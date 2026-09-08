/**
 * Bridge from a validated strategy to live execution.
 *
 * Signals are computed on the latest bars with the same engine used for
 * backtesting, then translated into order intents. Order *submission* goes
 * through a gateway so the broker can change without touching the signal logic.
 * Two exist: a dry run that only records, and `lib/toss-orders.ts`, which posts
 * real orders once the account's order endpoint and trading key are configured
 * and refuses with the missing-config list until then.
 */

import type { Bar } from "@/lib/quant";
import { signalSeries, type EventContext, type StrategySpec } from "@/lib/strategy";
import { fetchTossSnapshot, type BrokerSnapshot } from "@/lib/market-data";
import { tossOrderGateway as tossOrderGatewayRef } from "@/lib/toss-orders";

export type OrderSide = "buy" | "sell";
export type OrderIntent = {
  id: string;
  strategyId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  referencePrice: number;
  notionalUsd: number;
  reason: string;
  signalDate: string;
  generatedAt: string;
  broker: { available: boolean; price?: number; bid?: number | null; ask?: number | null; session?: string; reason?: string };
};

export type LiveSignal = {
  symbol: string;
  latestDate: string;
  latestClose: number;
  signal: "long" | "flat";
  changedToday: boolean;
  transition: "enter" | "exit" | "hold" | "stay_flat";
  exitReason: string | null;
  broker: BrokerSnapshot;
};

export function evaluateLiveSignal(symbol: string, rows: Bar[], spec: StrategySpec, broker: BrokerSnapshot, events: EventContext = {}): LiveSignal {
  const { signals, reasons } = signalSeries(rows, spec, events);
  const latest = Boolean(signals.at(-1));
  const previous = Boolean(signals.at(-2));
  const transition: LiveSignal["transition"] = latest && !previous ? "enter" : !latest && previous ? "exit" : latest ? "hold" : "stay_flat";
  return {
    symbol, latestDate: rows.at(-1)!.date, latestClose: rows.at(-1)!.close, signal: latest ? "long" : "flat", changedToday: latest !== previous, transition,
    exitReason: transition === "exit" ? reasons.at(-1) || "신호 소멸" : null, broker,
  };
}

export async function brokerSnapshotFor(symbol: string) {
  return fetchTossSnapshot(symbol);
}

/** Equal-weight sizing: capital × positionPct (or 1/N) divided by the reference price, floored to whole shares. */
export function orderIntentFor(strategyId: string, signal: LiveSignal, spec: StrategySpec, capitalUsd: number, currentlyHeld: boolean): OrderIntent | null {
  const wantsLong = signal.signal === "long";
  if (wantsLong === currentlyHeld) return null;
  const referencePrice = signal.broker.available && signal.broker.price ? signal.broker.price : signal.latestClose;
  const weight = spec.sizing.positionPct ? spec.sizing.positionPct / 100 : 1 / Math.max(1, spec.universe.length);
  const notional = capitalUsd * weight;
  const quantity = Math.floor(notional / referencePrice);
  if (wantsLong && quantity < 1) return null;
  return {
    id: crypto.randomUUID(), strategyId, symbol: signal.symbol, side: wantsLong ? "buy" : "sell", quantity: Math.max(1, quantity), referencePrice, notionalUsd: Math.round(Math.max(1, quantity) * referencePrice * 100) / 100,
    reason: wantsLong ? "진입 조건 충족" : signal.exitReason ?? "청산 조건", signalDate: signal.latestDate, generatedAt: new Date().toISOString(),
    broker: { available: signal.broker.available, price: signal.broker.price, bid: signal.broker.bid, ask: signal.broker.ask, session: signal.broker.session?.label, reason: signal.broker.reason },
  };
}

export type TradingGateway = {
  id: "dry_run" | "toss";
  label: string;
  submit(intent: OrderIntent): Promise<{ accepted: boolean; message: string; brokerOrderId?: string }>;
};

export const dryRunGateway: TradingGateway = {
  id: "dry_run",
  label: "Dry run (기록만)",
  async submit(intent) {
    return { accepted: true, message: `${intent.side.toUpperCase()} ${intent.quantity} ${intent.symbol} @ ${intent.referencePrice} 를 기록했습니다. 실제 주문은 전송되지 않았습니다.` };
  },
};

/**
 * Toss Securities. `lib/toss-orders.ts` posts real orders to `/api/v1/orders`
 * with the same client-credentials token the price calls use. Re-exported here
 * so callers keep one import for gateways.
 */
export { tossOrderGateway as tossGateway, tossTradingStatus } from "./toss-orders.ts";

export function gatewayFor(id: string | null | undefined): TradingGateway {
  return id === "toss" ? tossOrderGatewayRef : dryRunGateway;
}
