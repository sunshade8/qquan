/**
 * Validates the limit-only order shapes against Binance's own rules with POST /api/v3/order/test (spot).
 * The endpoint checks parameters and filters and NEVER places an order; a 200 here is not evidence of a fill, a
 * queue position or an account's ability to trade. Nothing else is called with a signature except the read-only
 * commission endpoint. Prints statuses only — no keys, balances or signed URLs.
 *
 *   node --env-file-if-exists=.dev.vars --experimental-strip-types --no-warnings scripts/research/binance-limit-order-test.ts
 */
import { BinanceAPI, BinanceError, binanceSetting, type BinanceFilter } from "../../lib/binance-api.ts";
import { binanceSpotOrderParams } from "../../lib/binance-orders.ts";
import { parseCommission } from "../../lib/ct-account-fees.ts";

const api = new BinanceAPI("spot", binanceSetting("BINANCE_NETWORK") === "testnet" ? "testnet" : "mainnet");
const out: Array<Record<string, unknown>> = [];
const status = (e: unknown) => (e instanceof BinanceError ? { http: e.status, code: e.code } : { error: e instanceof Error ? e.message : "failed" });
try {
  await api.syncTime();
  const info = (await api.read("exchangeInfo", { symbol: "BTCUSDT" })) as unknown as { symbols: Array<{ filters: BinanceFilter[] }> };
  const filters = info.symbols[0].filters;
  const book = await api.read("bookTicker", { symbol: "BTCUSDT" });
  const bid = Number(book.bidPrice);
  // Prices far from the market so even a real order would not match; quantity just above the minimum notional.
  const px = Math.floor(bid * 0.7);
  const quantity = Math.ceil((12 / px) * 1e5) / 1e5;
  for (const kind of ["limit_maker", "limit", "stop_loss_limit"] as const) {
    const side = kind === "stop_loss_limit" ? "sell" : "buy";
    const price = kind === "stop_loss_limit" ? Math.floor(bid * 1.3) : px;
    const params = binanceSpotOrderParams({ symbol: "BTCUSDT", side, kind, quantity, price, stopPrice: kind === "stop_loss_limit" ? price + 10 : undefined, clientOrderId: `ct-test-${Date.now()}`, filters });
    try {
      await api.testOrder(params);
      out.push({ kind, type: params.type, result: "accepted by /order/test" });
    } catch (e) {
      out.push({ kind, type: params.type, result: "rejected", ...status(e) });
    }
  }
  try {
    const c = parseCommission("spot", await api.read("commission", { symbol: "BTCUSDT" }), new Date().toISOString());
    out.push({ commission: c.fees ? { makerPct: c.fees.makerPct, takerPct: c.fees.takerPct } : null, discount: c.discount ?? null });
  } catch (e) {
    out.push({ commission: "unreadable", ...status(e) });
  }
} catch (e) {
  out.push({ setup: "failed", ...status(e), hint: "IP 허용 목록(ipRestrict)을 먼저 의심" });
}
console.log(JSON.stringify(out, null, 1));
