/**
 * The owner's actual cost of trading, in one place.
 *
 * Every backtest in this repo takes a cost parameter, and until now each caller
 * picked its own default — 5bps here, nothing there. Those defaults are US
 * institutional numbers and they are roughly half of what this account actually
 * pays, which is enough to turn a losing intraday rule into a winning backtest.
 * Anything that charges a cost should read it from here.
 *
 * The number that matters is not the percentage. It is `costInR`: a commission
 * quoted against notional becomes a fraction of *risk* once a stop is attached,
 * and that fraction is what raises the required win rate. The same schedule
 * costs 0.23R against a 1% stop and 0.92R against a 0.25% stop, so a plan that
 * tightens stops to trade bigger is quietly quadrupling its own cost hurdle.
 */

/**
 * Toss Securities, US stocks, as configured for this account.
 *
 * Confirm against the live fee schedule before quoting these to anyone: Korean
 * brokers run promotional rates that expire, and this account may sit on one.
 * `TOSS_FEE_PER_SIDE_PCT` overrides the commission per deployment.
 */
export const TOSS_US_EQUITY = {
  /** Commission per side, percent of notional. Charged on both the buy and the sell. */
  feePerSidePct: 0.1,
  /**
   * SEC Section 31 fee, charged on sales only, percent of proceeds. Tiny next to
   * commission, kept because it is real and because leaving it out invites the
   * question of what else was left out.
   */
  secSellFeePct: 0.0008,
  /**
   * FX spread per conversion, percent. Only paid when converting KRW/USD, not per
   * trade, so it is excluded from `roundTripPct` and belongs in account-level
   * accounting rather than per-trade cost.
   */
  fxSpreadPct: 0.1,
  /**
   * Assumed round-trip slippage plus half-spread for a liquid US large cap at
   * regular-hours volume. This is an estimate, not a published number, and it is
   * the single most optimistic figure on this page. Thin names and the first
   * minutes after the open are worse.
   */
  assumedSlippagePct: 0.03,
  source: "Toss Securities US equity schedule (verify before quoting)",
} as const;

function envNumber(name: string) {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function feePerSidePct() {
  return envNumber("TOSS_FEE_PER_SIDE_PCT") ?? TOSS_US_EQUITY.feePerSidePct;
}

export function assumedSlippagePct() {
  return envNumber("ASSUMED_SLIPPAGE_PCT") ?? TOSS_US_EQUITY.assumedSlippagePct;
}

/** Commission both ways, plus the sell-side SEC fee, plus assumed slippage. */
export function roundTripPct() {
  return feePerSidePct() * 2 + TOSS_US_EQUITY.secSellFeePct + assumedSlippagePct();
}

/** The same cost expressed per side in basis points, for engines that take bps. */
export function costBps() {
  return (roundTripPct() / 2) * 100;
}

/**
 * Round-trip cost as a multiple of one R, given the stop distance in percent.
 * This is the number to quote when asked whether a tactic clears its costs.
 */
export function costInR(stopDistancePct: number) {
  return roundTripPct() / Math.max(0.01, stopDistancePct);
}

/** Gross move required just to break even, percent of notional. */
export function breakevenMovePct() {
  return roundTripPct();
}

/** One line the agent can quote verbatim. */
export function describeCosts() {
  const roundTrip = roundTripPct();
  return `Toss 미국주식 편도 수수료 ${feePerSidePct()}% + 매도 SEC 수수료 ${TOSS_US_EQUITY.secSellFeePct}% + 가정 슬리피지 ${assumedSlippagePct()}% = 왕복 ${Number(roundTrip.toFixed(4))}%. 손절폭 1%면 거래당 ${Number(costInR(1).toFixed(3))}R, 0.5%면 ${Number(costInR(0.5).toFixed(3))}R, 0.25%면 ${Number(costInR(0.25).toFixed(3))}R.`;
}
