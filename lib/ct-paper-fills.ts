/**
 * Paper fills for limit-only CT orders: the SAME rule the backtest uses (lib/ct-limit-execution.ts ctThroughHit), applied to
 * Binance's real one-minute candles and quote. A resting order fills only when a candle that STARTED after the order was sent
 * traded through its price (a touch is not a fill; the candle in progress at submit time is ignored — it may hold prices from
 * before the order existed). A marketable limit or the emergency market sell fills at the live bid/ask as a taker.
 * Pure: the broker passes the quote and the candles in.
 */
import type { CTBar } from "./ct-engine.ts";
import { ctThroughHit } from "./ct-limit-execution.ts";

export type PaperOrder = {
  side: "buy" | "sell";
  orderType: "limit_maker" | "limit" | "stop_loss_limit" | "market";
  limitPrice: number | null;
  submittedAtMs: number;
  tick: number;
  penetrationTicks: number;
};

export type PaperFill = { price: number; leg: "maker" | "taker" };

/** Would a post-only order be rejected because it would match at once? (Binance code -2010 for LIMIT_MAKER.) */
export function paperWouldMatchNow(o: Pick<PaperOrder, "side" | "limitPrice">, quote: { bid: number | null; ask: number | null }) {
  if (o.limitPrice === null) return false;
  return o.side === "buy" ? quote.ask !== null && quote.ask <= o.limitPrice : quote.bid !== null && quote.bid >= o.limitPrice;
}

export function paperLimitFill(o: PaperOrder, quote: { bid: number | null; ask: number | null }, candles: CTBar[]): PaperFill | null {
  if (o.orderType === "market") {
    const px = o.side === "sell" ? quote.bid : quote.ask;
    return px ? { price: px, leg: "taker" } : null;
  }
  if (o.limitPrice === null) return null;
  // A plain limit that is marketable takes liquidity at the touch price; LIMIT_MAKER never gets here that way.
  if (o.orderType !== "limit_maker" && paperWouldMatchNow(o, quote)) return { price: (o.side === "sell" ? quote.bid : quote.ask)!, leg: "taker" };
  for (const c of candles)
    if (c.startMs > o.submittedAtMs && ctThroughHit(o.side, o.limitPrice, c, o.tick, o.penetrationTicks)) return { price: o.limitPrice, leg: "maker" };
  return null;
}
