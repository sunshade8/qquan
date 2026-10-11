import Decimal from "decimal.js";
export function decimalFloor(value: Decimal.Value, places: number) {
  return new Decimal(value)
    .toDecimalPlaces(places, Decimal.ROUND_DOWN)
    .toFixed(places);
}
export function upbitTick(price: Decimal.Value) {
  const n = new Decimal(price);
  for (const [lower, tick] of [
    [1000000, 1000],
    [500000, 500],
    [100000, 100],
    [50000, 50],
    [10000, 10],
    [5000, 5],
    [100, 1],
    [10, 0.1],
    [1, 0.01],
    [0.1, 0.001],
    [0.01, 0.0001],
    [0.001, 0.00001],
    [0.0001, 0.000001],
    [0.00001, 0.0000001],
    [0, 0.00000001],
  ])
    if (n.gte(lower)) return new Decimal(tick);
  throw new Error("가격 범위");
}
export function upbitLimit(
  price: Decimal.Value,
  side: "buy" | "sell",
  tick = upbitTick(price),
) {
  return new Decimal(price)
    .div(tick)
    .toDecimalPlaces(0, side === "buy" ? Decimal.ROUND_DOWN : Decimal.ROUND_UP)
    .mul(tick)
    .toFixed();
}

export function ctFillPrice(
  price: number,
  market: "stock" | "crypto",
  side: "buy" | "sell",
) {
  const tick = market === "crypto" ? upbitTick(price) : new Decimal("0.01");
  return new Decimal(price)
    .div(tick)
    .toDecimalPlaces(0, side === "buy" ? Decimal.ROUND_UP : Decimal.ROUND_DOWN)
    .mul(tick)
    .toNumber();
}
