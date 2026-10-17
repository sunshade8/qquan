/**
 * Limit-order-only execution (docs/prompts/binance-only-limit-orders.md §3, docs/ct.md「지정가 전용 체결」). Pure: no I/O, no
 * clock. replayCT (backtest), the paper broker and the live runner all call THESE functions, so a backtest and a paper
 * or live trade cannot disagree about when an order fills, what it pays or how a stop is chased.
 *
 * A contract carries a `CTExecutionPolicy` (frozen at creation). Without one, every engine behaves exactly as before
 * (next bar's open ± impact, taker fee): old contracts and registered packages replay bit for bit.
 *
 * The model, in one place:
 *  - ENTRY    a buy limit at the decision bar's close, tick-rounded DOWN, valid for `entryTtlBars` bars. It fills only
 *             when a bar trades THROUGH the limit by at least `penetrationTicks` ticks (a touch is not a fill: a resting
 *             order is behind the queue at its price, and the fills it does get are the ones that then move against it).
 *             Fill price = the limit; maker fee; no spread or slippage. An order not filled in time is `unfilled`: it is
 *             not a trade, it is counted.
 *  - TARGET   a resting sell limit from the fill on, same through-the-price rule, not in the fill bar (the high may
 *             have come before the fill). Fill price = the target; maker fee.
 *  - STOP     a stop-limit: when the stop level is hit, a sell limit `slackPct` beyond it. It is marketable unless the
 *             price gapped past the limit, so it pays the taker fee and the measured impact. If the price gapped past
 *             the limit it rests, is re-priced `chaseStepPct` lower every `chaseSeconds`, and after `maxChases`
 *             re-prices the one allowed market sell (`emergencyMarket`) closes it: taker fee, impact, flagged.
 *  - OTHER    time, day-end, invalidation and book exits are marketable sell limits at the bid: taker fee and impact.
 *  Spot Regular fees are maker 0.1% = taker 0.1%, so for spot the limit model saves the entry's spread and impact,
 *  not fee; USDⓈ-M is where maker (0.02%) and taker (0.05%) differ.
 */
import type { CTBar } from "./ct-engine.ts";

export type CTStopPolicy = {
  /** The stop-limit's limit sits this far beyond the stop level, percent. */
  slackPct: number;
  /** Seconds an unfilled exit order waits before it is cancelled and re-priced lower. */
  chaseSeconds: number;
  /** Each re-price moves the limit this much lower, percent of the previous limit. */
  chaseStepPct: number;
  /** Re-prices before the emergency exit. */
  maxChases: number;
  /** The one market order allowed: after the last re-price, a market sell. Default on; every use is recorded. */
  emergencyMarket: boolean;
};

export type CTFeeProvenance = {
  official: { makerPct: number; takerPct: number; url: string; checkedAt: string };
  /** What the account itself reports (GET /api/v3/account/commission · /fapi/v1/commissionRate); null when it could not be read. */
  account: { makerPct: number; takerPct: number; readAt: string; endpoint: string } | null;
  accountNote: string | null;
};

export type CTExecutionPolicy = {
  version: 1;
  mode: "limit";
  /** Frozen: max(official fee table, account's own rate). BNB discount is never assumed. */
  makerFeePct: number;
  takerFeePct: number;
  /** Bars (the strategy's own) an entry limit stays open. */
  entryTtlBars: number;
  /** A fill needs the price to trade at least this many ticks through the limit (minimum 1: a touch never fills). */
  penetrationTicks: number;
  tickSize: Record<string, number>;
  stop: CTStopPolicy;
  fees: CTFeeProvenance;
};

export const CT_LIMIT_DEFAULTS = Object.freeze({
  entryTtlBars: 3,
  penetrationTicks: 1,
  tickSize: { BTCUSDT: 0.01, ETHUSDT: 0.01, SOLUSDT: 0.01 } as Record<string, number>,
  stop: { slackPct: 0.1, chaseSeconds: 10, chaseStepPct: 0.1, maxChases: 3, emergencyMarket: true } as CTStopPolicy,
});

/** Tick used for a symbol (0.01 USDT for the three Binance spot pairs unless the contract froze others). */
export const ctTickOf = (policy: Pick<CTExecutionPolicy, "tickSize">, symbol: string) => policy.tickSize[symbol] ?? 0.01;

const decimals = (tick: number) => Math.max(0, Math.round(-Math.log10(tick)));
/** Round to the tick grid. `down` for a buy limit (never pay more than the signal), `up` for a sell limit. */
export function ctTickRound(price: number, tick: number, direction: "down" | "up") {
  const q = price / tick,
    n = direction === "down" ? Math.floor(q + 1e-9) : Math.ceil(q - 1e-9);
  return Number((n * tick).toFixed(decimals(tick)));
}

/** Ticks a fill must go through the limit: never below one, so touching the price is not a fill. */
export const ctThroughTicks = (penetrationTicks: number) => Math.max(1, penetrationTicks);

/**
 * Did the bar trade through `level` far enough to fill a resting order? Buy: the low went at least the threshold BELOW
 * the limit. Sell: the high went at least the threshold ABOVE it. The comparison tolerates float noise of a millionth of a tick.
 */
export function ctThroughHit(side: "buy" | "sell", level: number, bar: Pick<CTBar, "low" | "high">, tick: number, penetrationTicks: number) {
  const gap = ctThroughTicks(penetrationTicks) * tick - tick * 1e-6;
  return side === "buy" ? level - bar.low >= gap : bar.high - level >= gap;
}

export type CTEntryScan =
  | { kind: "filled"; index: number; price: number }
  | { kind: "unfilled" }
  | { kind: "gap" };

/**
 * Walk the bars after the decision bar `from` (the entry order is placed at its close) and report where a buy limit fills.
 * `rows` must be one symbol's bars, ascending. A hole in the bars before a fill is `gap` (the order's fate is unknowable).
 */
export function ctScanEntry(rows: CTBar[], from: number, limit: number, policy: CTExecutionPolicy, symbol: string): CTEntryScan {
  const tick = ctTickOf(policy, symbol);
  for (let k = 1; k <= policy.entryTtlBars; k++) {
    const bar = rows[from + k];
    if (!bar) return { kind: "unfilled" };
    if (bar.startMs !== rows[from + k - 1].endMs) return { kind: "gap" };
    if (ctThroughHit("buy", limit, bar, tick, policy.penetrationTicks)) return { kind: "filled", index: from + k, price: limit };
  }
  return { kind: "unfilled" };
}

/** The stop-limit's limit price: `slackPct` below the stop level, rounded DOWN to a tick. */
export const ctStopLimitPrice = (stopLevel: number, stop: CTStopPolicy, tick: number) => ctTickRound(stopLevel * (1 - stop.slackPct / 100), tick, "down");

export type CTExitLeg = "maker" | "taker" | "emergency";
export type CTStopFill = {
  /** Price the sell fills at BEFORE impact (the caller applies impact to taker and emergency legs). */
  price: number;
  leg: CTExitLeg;
  /** Re-prices done before the fill. */
  chases: number;
  /** End of the minute the fill happened in. */
  fillEndMs: number;
};

/**
 * How a triggered stop leaves. `triggerPrice` is where the stop would fill (ctExitStep: the stop, or the open if the bar
 * gapped through it). At or above the stop-limit's limit the order is marketable and fills there as a taker. Below it the
 * order rests at the limit and the one-minute `rows` from the trigger bar's start decide: each window of
 * `chaseSeconds` (at least one minute) either fills it (the open is already at or above the limit → taker at that open;
 * or a minute trades through the limit → maker at the limit), or the limit moves `chaseStepPct` lower. After `maxChases`
 * re-prices the emergency market sell takes the next window's open; without it the chase just continues.
 * Returns null when the data ends before any fill.
 */
export function ctSimulateStopExit(input: {
  rows: CTBar[]; // one-minute bars of the symbol, ascending
  triggerStartMs: number; // start of the bar in which the stop triggered
  triggerPrice: number;
  stopLevel: number;
  policy: CTExecutionPolicy;
  symbol: string;
}): CTStopFill | null {
  const { rows, triggerStartMs, triggerPrice, stopLevel, policy, symbol } = input,
    tick = ctTickOf(policy, symbol),
    stop = policy.stop,
    limit0 = ctStopLimitPrice(stopLevel, stop, tick);
  let first = lowerBound(rows, triggerStartMs);
  if (triggerPrice >= limit0) {
    const bar = rows[first];
    return { price: triggerPrice, leg: "taker", chases: 0, fillEndMs: bar ? bar.endMs : triggerStartMs + 60_000 };
  }
  if (first >= rows.length) return null;
  const windowMinutes = Math.max(1, Math.ceil(stop.chaseSeconds / 60));
  for (let k = 0; ; k++) {
    const from = first + k * windowMinutes;
    if (from >= rows.length) return null;
    const to = Math.min(rows.length, from + windowMinutes);
    const emergency = k > stop.maxChases && stop.emergencyMarket;
    if (emergency) return { price: rows[from].open, leg: "emergency", chases: stop.maxChases, fillEndMs: rows[from].endMs };
    const limit = ctTickRound(limit0 * Math.pow(1 - stop.chaseStepPct / 100, k), tick, "down");
    if (rows[from].open >= limit) return { price: rows[from].open, leg: "taker", chases: k, fillEndMs: rows[from].endMs };
    for (let i = from; i < to; i++)
      if (ctThroughHit("sell", limit, rows[i], tick, policy.penetrationTicks)) return { price: limit, leg: "maker", chases: k, fillEndMs: rows[i].endMs };
    if (k > 100_000) return null;
  }
}
function lowerBound(rows: CTBar[], startMs: number) {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].startMs < startMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Fee and impact of one leg, as percentages. Maker legs pay the maker fee and no impact (they fill at their own price);
 * taker and emergency legs pay the taker fee and the contract's per-side impact. `multiplier` is the gate's cost stress.
 */
export function ctLegCosts(leg: "entry" | CTExitLeg, policy: Pick<CTExecutionPolicy, "makerFeePct" | "takerFeePct">, impactPct: number, multiplier = 1) {
  const maker = leg === "entry" || leg === "maker";
  return { feePct: (maker ? policy.makerFeePct : policy.takerFeePct) * multiplier, impactPct: maker ? 0 : impactPct * multiplier };
}

/** Frozen fee for a contract: the larger of the official table and the account's own rate (never a discount). */
export function ctFreezeFees(official: CTFeeProvenance["official"], account: CTFeeProvenance["account"]) {
  return {
    makerFeePct: Math.max(official.makerPct, account?.makerPct ?? 0),
    takerFeePct: Math.max(official.takerPct, account?.takerPct ?? 0),
  };
}

/**
 * Forward return of a limit price over `horizonBars` bars after the decision bar `from`, percent, or NaN when the bars are
 * not one unbroken run. Used to compare signals whose limit filled with signals whose limit did not (adverse selection).
 */
export function ctForwardReturnPct(rows: CTBar[], from: number, limit: number, horizonBars: number) {
  const end = rows[from + horizonBars];
  if (!end || end.endMs - rows[from].endMs !== horizonBars * (rows[from].endMs - rows[from].startMs)) return NaN;
  return (end.close / limit - 1) * 100;
}

export type CTExecutionStats = {
  signals: number;
  filled: number;
  unfilled: number;
  fillRatePct: number;
  /** Mean forward return from the limit price, percent, of signals that filled / did not fill (NaN-free: null when empty). */
  filledForwardPct: number | null;
  unfilledForwardPct: number | null;
  /** filled − unfilled: negative means the orders that fill are the ones that then do worse (adverse selection). */
  adverseSelectionPct: number | null;
  /** Exits by how they filled. */
  exits: { target: number; stopTaker: number; stopMaker: number; emergency: number; other: number };
};

export const emptyExecutionStats = (): CTExecutionStats => ({
  signals: 0,
  filled: 0,
  unfilled: 0,
  fillRatePct: 0,
  filledForwardPct: null,
  unfilledForwardPct: null,
  adverseSelectionPct: null,
  exits: { target: 0, stopTaker: 0, stopMaker: 0, emergency: 0, other: 0 },
});

/** One line for screens: what the limit model assumed. */
export function ctExecutionText(policy: CTExecutionPolicy) {
  const s = policy.stop;
  return (
    `지정가 전용 · 진입 ${policy.entryTtlBars}봉 안에 ${ctThroughTicks(policy.penetrationTicks)}틱 이상 관통해야 체결(닿기만 하면 미체결) · ` +
    `메이커 ${policy.makerFeePct}% / 테이커 ${policy.takerFeePct}% · 손절은 여유 ${s.slackPct}% 지정가, ${s.chaseSeconds}초마다 ${s.chaseStepPct}%씩 ${s.maxChases}번 따라 내림` +
    (s.emergencyMarket ? " 후 비상 시장가 1회" : " (비상 시장가 꺼짐: 손실 상한 없음)")
  );
}
