import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./helpers/slot-test-loader.mjs", import.meta.url);
const { binanceSpotOrderParams, binanceUsdmOrderParams } = await import("../lib/binance-orders.ts");

const filters = [
  { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" },
  { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000", stepSize: "0.00001" },
  { filterType: "NOTIONAL", minNotional: "5", maxNotional: "9000000" },
];
const base = { symbol: "BTCUSDT", side: "buy", quantity: 0.0123456, price: 83000.019, clientOrderId: "c1", filters };

test("spot LIMIT_MAKER: type, quantity and price only — no timeInForce — rounded to the exchange filters", () => {
  const p = binanceSpotOrderParams({ ...base, kind: "limit_maker" });
  assert.deepEqual(p, { symbol: "BTCUSDT", side: "BUY", newClientOrderId: "c1", type: "LIMIT_MAKER", quantity: "0.01234", price: "83000.01" });
  assert.ok(!("timeInForce" in p));
});
test("spot LIMIT is GTC; STOP_LOSS_LIMIT carries stopPrice and keeps a sell's limit at or below its trigger; MARKET has quantity only", () => {
  assert.equal(binanceSpotOrderParams({ ...base, kind: "limit", side: "sell" }).timeInForce, "GTC");
  const s = binanceSpotOrderParams({ ...base, kind: "stop_loss_limit", side: "sell", price: 82900, stopPrice: 83000 });
  assert.equal(s.type, "STOP_LOSS_LIMIT");
  assert.equal(s.stopPrice, "83000");
  assert.equal(s.timeInForce, "GTC");
  assert.throws(() => binanceSpotOrderParams({ ...base, kind: "stop_loss_limit", side: "sell", price: 83100, stopPrice: 83000 }), /stopPrice보다 높음/);
  assert.throws(() => binanceSpotOrderParams({ ...base, kind: "stop_loss_limit", price: 82900 }), /stopPrice 필요/);
  const m = binanceSpotOrderParams({ ...base, kind: "market", side: "sell", price: 0, referencePrice: 83000 });
  assert.deepEqual(Object.keys(m).sort(), ["newClientOrderId", "quantity", "side", "symbol", "type"]);
});
test("rounding never raises the order past the filters: below min notional or lot size is refused, not bumped", () => {
  assert.throws(() => binanceSpotOrderParams({ ...base, kind: "limit_maker", quantity: 0.00003 }), /NOTIONAL/);
  assert.throws(() => binanceSpotOrderParams({ ...base, kind: "limit_maker", quantity: 0.000001 }), /LOT_SIZE/);
});
test("USDⓈ-M limit orders are post-only GTX; a closing one-way order is reduceOnly, hedge uses positionSide", () => {
  const f = [filters[0], { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "1000", stepSize: "0.001" }];
  const u = { symbol: "BTCUSDT", side: "sell", quantity: 0.0123, price: 83000, clientOrderId: "c2", filters: f, positionSide: "LONG" };
  const oneWay = binanceUsdmOrderParams({ ...u, positionMode: "one-way", closing: true });
  assert.equal(oneWay.timeInForce, "GTX");
  assert.equal(oneWay.type, "LIMIT");
  assert.equal(oneWay.reduceOnly, true);
  assert.equal(oneWay.positionSide, "BOTH");
  const hedge = binanceUsdmOrderParams({ ...u, positionMode: "hedge", closing: true });
  assert.equal(hedge.positionSide, "LONG");
  assert.ok(!("reduceOnly" in hedge));
});
