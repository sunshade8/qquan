/**
 * Pure order-shaping for the Toss order API, kept separate from the
 * Worker-bound client the same way `massive-shapes.ts` is separate from
 * `massive.ts`: `lib/toss-orders.ts` imports `cloudflare:workers`, which the
 * Node test runner cannot resolve, and the body shape is exactly the part that
 * must be tested without sending an order to find out it was wrong.
 *
 * Schema: https://openapi.tossinvest.com/openapi-docs/latest/openapi.json
 * (`OrderCreateRequest`). Every numeric field crosses the wire as a string.
 */

export type TossOrderSide = "BUY" | "SELL";
export type TossOrderMode = "loc" | "market";

export type TossOrderRequest = {
  clientOrderId?: string;
  symbol: string;
  side: TossOrderSide;
  orderType: "LIMIT" | "MARKET";
  timeInForce?: "DAY" | "CLS" | "OPG";
  quantity: string;
  price?: string;
};

/** US tick rules: two decimals at or above $1, four below, truncated either way. */
export function usLimitPrice(value: number) {
  const digits = value >= 1 ? 2 : 4;
  const factor = 10 ** digits;
  return (Math.floor(value * factor) / factor).toFixed(digits);
}

/**
 * Toss's idempotency key: at most 36 characters of `[A-Za-z0-9_-]`, honoured for
 * ten minutes. A UUID fits exactly, so re-submitting the same intent inside that
 * window returns the original order rather than doubling the position.
 */
export function toClientOrderId(id: string) {
  return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36);
}

/**
 * The order body, as a pure function of the intent.
 *
 * `LIMIT` + `timeInForce: "CLS"` is a limit-on-close order and is the default
 * because the strategies backtest a fill at the next session's close; a market
 * order placed mid-session fills at a price the backtest never modelled. The
 * band only caps how far the close may run against the order before it fails to
 * fill — the fill itself is at the closing auction price.
 */
export function buildOrderBody(
  input: { id: string; symbol: string; side: "buy" | "sell"; referencePrice: number },
  quantity: number,
  mode: TossOrderMode,
  bandPct: number,
): TossOrderRequest {
  const side: TossOrderSide = input.side === "buy" ? "BUY" : "SELL";
  const base = { clientOrderId: toClientOrderId(input.id), symbol: input.symbol, side, quantity: String(quantity) };
  if (mode === "market") return { ...base, orderType: "MARKET", timeInForce: "DAY" };
  const band = bandPct / 100;
  return {
    ...base,
    orderType: "LIMIT",
    timeInForce: "CLS",
    price: usLimitPrice(input.side === "buy" ? input.referencePrice * (1 + band) : input.referencePrice * (1 - band)),
  };
}
