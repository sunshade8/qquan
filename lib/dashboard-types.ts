/**
 * Shapes shared by the trading engine, its D1 store, the `/api/trading` route
 * and the 전략 tab. Pure types: safe to import from anywhere, including tests.
 */

import type { SlotId } from "./trade-slots.ts";
import type { TradeExit } from "./trade-adherence.ts";

export type DashboardMode = "live" | "paper";
export type DashboardStatus = "stopped" | "running" | "stopping";

/**
 * The stop sequence, in order: cancel unfilled buys so nothing new arrives,
 * sell what the dashboard itself bought, then wait for those sells to fill.
 */
export type StopPhase = "cancel_buys" | "liquidate" | "confirm";

export type OrderPurpose = "entry" | TradeExit;

export type DashboardOrder = {
  id: string;
  tradeId: string;
  /** Idempotency key sent to the broker; re-sending it cannot create a second order. */
  clientOrderId: string;
  brokerOrderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  purpose: OrderPurpose;
  quantity: number;
  /** Null for paper fills, which take the quote as it is. */
  limitPrice: number | null;
  referencePrice: number;
  filledQuantity: number;
  averageFillPrice: number | null;
  commissionUsd: number;
  /**
   * `submitting` means the request left but no answer came back — the order may
   * or may not exist, and the next tick re-sends the same idempotency key to find out.
   */
  status: "submitting" | "working" | "cancel_requested" | "filled" | "canceled" | "rejected";
  attempt: number;
  submittedAt: string;
  updatedAt: string;
  message: string | null;
};

/**
 * One round trip, from the rule's signal to the last sell. A trade with shares
 * still held *is* the position — there is no separate position record to drift
 * out of sync with it.
 */
export type DashboardTrade = {
  barMinutes?: 1 | 3 | 5;
  id: string;
  strategyId: string;
  strategyName: string;
  slot: SlotId;
  symbol: string;
  /** ET trading date. */
  date: string;
  status: "entering" | "open" | "closed" | "missed";
  reason: string;
  /** Start of the bar (at the rule's `barMinutes`) the rule decided on, "HH:MM" ET. */
  signalTime: string;
  /** When that bar closed — the earliest moment the decision could exist. */
  decidedAt: string;
  referencePrice: number;
  stopPct: number;
  targetPct: number | null;
  slotEndsAt: string;
  equityAtEntryUsd: number;
  boughtQuantity: number;
  soldQuantity: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
  entryPrice: number | null;
  entryAt: string | null;
  exitPrice: number | null;
  exitAt: string | null;
  exit: TradeExit | null;
  /** Set once an exit is decided, so a canceled-and-retried sell keeps its reason. */
  pendingExit: TradeExit | null;
  exitAttempts: number;
  markPrice: number | null;
  /** Minute candles up to here have already been checked against the stop and target. */
  checkedThroughMs: number | null;
  commissionUsd: number;
  pnlUsd: number | null;
  returnPct: number | null;
  compliant: boolean | null;
  violations: string[];
  entrySlippagePct: number | null;
};

export type DashboardStrategyStats = {
  id: string;
  name: string;
  slot: SlotId;
  signals: number;
  entries: number;
  missed: number;
  closed: number;
  compliant: number;
  deviations: number;
  wins: number;
  pnlUsd: number;
  commissionUsd: number;
};

export type DashboardDaily = { date: string; startEquityUsd: number; equityUsd: number; pnlUsd: number; returnPct: number; trades: number };
export type DashboardEvent = { at: string; kind: "info" | "warn" | "error" | "signal" | "order" | "fill"; message: string };
export type DashboardBrokerBalance = { accountNo: string | null; cashBuyingPowerUsd: number | null; holdingsValueUsd: number | null; fetchedAt: string; error: string | null };
export type DashboardRunSummary = { runId: string; startedAt: string | null; stoppedAt: string | null; finalEquityUsd: number; returnPct: number; trades: number };

export type DashboardState = {
  version: 1;
  /** Registry snapshot at start; newly generated strategies activate on the next run. */
  strategyIds?: string[];
  mode: DashboardMode;
  status: DashboardStatus;
  runId: string | null;
  stopPhase: StopPhase | null;
  initialCapitalUsd: number;
  /** Cash this dashboard controls. Never the whole broker account. */
  cashUsd: number;
  peakEquityUsd: number;
  maxDrawdownPct: number;
  startedAt: string | null;
  stopRequestedAt: string | null;
  stoppedAt: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  /** `${date}:${slot}` → the last bar evaluated and whether the slot already fired. */
  /**
   * Per day and rule: the last bar already put to the rule, whether it is done
   * for the day, and how many entries it has taken (a rule may allow several,
   * one position at a time).
   */
  slotProgress: Record<string, { lastBarTime: string | null; fired: boolean; entries?: number }>;
  orders: DashboardOrder[];
  trades: DashboardTrade[];
  strategies: Record<string, DashboardStrategyStats>;
  daily: DashboardDaily[];
  brokerBalance: DashboardBrokerBalance | null;
  events: DashboardEvent[];
  previousRuns: DashboardRunSummary[];
};

export type DashboardStrategyView = DashboardStrategyStats & {
  summary: string;
  universe: string[];
  slotLabel: string;
  registered: boolean;
  adherencePct: number | null;
  contributionPct: number;
};

export type TradingDashboardView = {
  mode: DashboardMode;
  status: DashboardStatus;
  stopPhase: StopPhase | null;
  runId: string | null;
  initialCapitalUsd: number;
  cashUsd: number;
  positionsValueUsd: number;
  equityUsd: number;
  totalPnlUsd: number;
  totalReturnPct: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  commissionUsd: number;
  maxDrawdownPct: number;
  adherencePct: number | null;
  signals: number;
  missedSignals: number;
  startedAt: string | null;
  stopRequestedAt: string | null;
  stoppedAt: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  brokerBalance: DashboardBrokerBalance | null;
  readiness: { ready: boolean; reasons: string[] };
  strategies: DashboardStrategyView[];
  daily: DashboardDaily[];
  positions: DashboardTrade[];
  orders: DashboardOrder[];
  trades: DashboardTrade[];
  events: DashboardEvent[];
  previousRuns: DashboardRunSummary[];
};

export type TradingDashboardResponse = {
  /** Which book these dashboards belong to: the 전략 slot rules or the 급등주 rules. */
  book?: "relay" | "surge";
  now: string;
  dashboards: { live: TradingDashboardView; paper: TradingDashboardView };
  runner: { online: boolean; lastHeartbeatAt: string | null; intervalSeconds: number };
  registeredStrategies: number;
  toss: { ready: boolean; reason: string | null; cause: string | null; egressIp: string | null; accountNo: string | null; buyingPowerUsd: number | null };
  capitalUsd: number;
};
