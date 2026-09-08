import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildOrderBody, usLimitPrice } from "../lib/toss-order-shapes.ts";

/**
 * The order body is validated against the shape Toss actually publishes, pinned
 * as a fixture from
 * https://openapi.tossinvest.com/openapi-docs/latest/openapi.json.
 * Placing a real order to find out the body was wrong is not an option, so the
 * schema is the test.
 */
const spec = JSON.parse(readFileSync(new URL("./toss-order-schema.json", import.meta.url), "utf8"));
const variants = spec.schema.oneOf;
const quantityBased = variants.find((variant) => variant.title === "OrderCreateQuantityBased");

function validate(body, variant = quantityBased) {
  const problems = [];
  for (const key of variant.required) {
    if (body[key] === undefined) problems.push(`missing required ${key}`);
  }
  for (const [key, value] of Object.entries(body)) {
    const property = variant.properties[key];
    if (!property) { problems.push(`unknown property ${key}`); continue; }
    if (property.enum && !property.enum.includes(value)) problems.push(`${key}=${value} not in ${property.enum.join("|")}`);
    if (property.type === "string" && typeof value !== "string") problems.push(`${key} must be a string, got ${typeof value}`);
    if (property.pattern && typeof value === "string" && !new RegExp(property.pattern).test(value)) problems.push(`${key}="${value}" fails ${property.pattern}`);
    if (property.maxLength && typeof value === "string" && value.length > property.maxLength) problems.push(`${key} longer than ${property.maxLength}`);
  }
  return problems;
}

const intent = (overrides = {}) => ({
  id: "0d5e4b7a-1f2c-4a9b-8c3d-5e6f7a8b9c0d",
  symbol: "MDB", side: "buy", referencePrice: 368.35,
  ...overrides,
});

test("a LOC buy body matches the published order schema", () => {
  const body = buildOrderBody(intent(), 2, "loc", 3);
  assert.deepEqual(validate(body), []);
  assert.equal(body.orderType, "LIMIT");
  assert.equal(body.timeInForce, "CLS", "LIMIT + CLS is the limit-on-close order the backtest models");
  assert.equal(body.side, "BUY");
  assert.equal(body.quantity, "2");
  // 368.35 * 1.03 = 379.4005, truncated to two decimals above $1.
  assert.equal(body.price, "379.40");
});

test("a LOC sell prices the limit below the reference, not above", () => {
  const body = buildOrderBody(intent({ side: "sell" }), 5, "loc", 3);
  assert.deepEqual(validate(body), []);
  assert.equal(body.side, "SELL");
  assert.ok(Number(body.price) < 368.35, `sell limit ${body.price} must sit below the reference`);
});

test("a market body carries no price and rests for the day", () => {
  const body = buildOrderBody(intent(), 2, "market", 3);
  assert.deepEqual(validate(body), []);
  assert.equal(body.orderType, "MARKET");
  assert.equal(body.timeInForce, "DAY");
  assert.equal(body.price, undefined, "MARKET orders are rejected outright when a price is sent");
});

test("clientOrderId satisfies the idempotency key constraints", () => {
  const body = buildOrderBody(intent(), 1, "loc", 3);
  const property = quantityBased.properties.clientOrderId;
  assert.ok(body.clientOrderId.length <= property.maxLength);
  assert.match(body.clientOrderId, new RegExp(property.pattern));
  // A UUID is 36 characters of exactly the permitted alphabet, so it survives intact.
  assert.equal(body.clientOrderId, intent().id);
});

test("US tick rules: two decimals at or above a dollar, four below, truncated", () => {
  assert.equal(usLimitPrice(379.4005), "379.40");
  assert.equal(usLimitPrice(185.999), "185.99");
  assert.equal(usLimitPrice(0.123456), "0.1234");
  assert.equal(usLimitPrice(1), "1.00");
  for (const value of [0.5, 1, 12.345, 999.999]) {
    assert.match(usLimitPrice(value), new RegExp(quantityBased.properties.price.pattern));
  }
});

test("quantities are whole-share strings, never floats", () => {
  const body = buildOrderBody(intent(), 7, "loc", 3);
  assert.equal(typeof body.quantity, "string");
  assert.match(body.quantity, new RegExp(quantityBased.properties.quantity.pattern));
  assert.ok(!body.quantity.includes("."), "fractional quantity is only legal for US market sells");
});
