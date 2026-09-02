/**
 * Bridge from a validated strategy to live execution.
 *
 * Signals are computed on the latest bars with the same engine used for
 * backtesting, then translated into order intents. Order *submission* goes
 * through a gateway so the Toss order API can be wired in without touching the
 * signal logic. Until that endpoint is integrated, only the dry-run gateway is
 * available and nothing is ever sent to a broker.
 */

import type { Bar } from "@/lib/quant";
import { signalSeries, type StrategySpec } from "@/lib/strategy";
import { fetchTossSnapshot, type BrokerSnapshot } from "@/lib/market-data";

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

export function evaluateLiveSignal(symbol: string, rows: Bar[], spec: StrategySpec, broker: BrokerSnapshot): LiveSignal {
  const { signals, reasons } = signalSeries(rows, spec);
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
 * Toss Securities: the existing integration (`lib/market-data.ts`) covers prices,
 * orderbook, trades and the market calendar. Order placement requires the Toss
 * order endpoints and a trading-scoped credential, which are not wired yet.
 */
export const tossGateway: TradingGateway = {
  id: "toss",
  label: "Toss Securities (주문 API 미연결)",
  async submit() {
    return { accepted: false, message: "토스증권 주문 API가 아직 연결되지 않았습니다. 주문 엔드포인트와 거래 권한 키가 준비되면 lib/trading.ts의 tossGateway.submit에 연결하세요." };
  },
};

export function gatewayFor(id: string | null | undefined): TradingGateway {
  return id === "toss" ? tossGateway : dryRunGateway;
}
