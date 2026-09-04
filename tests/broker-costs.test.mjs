import assert from "node:assert/strict";
import test from "node:test";
import { costBps, costInR, roundTripPct, TOSS_US_EQUITY } from "../lib/broker-costs.ts";

test("round trip charges the commission twice plus the sell-side fee and slippage", () => {
  // 0.1 x 2 + 0.0008 + 0.03
  assert.ok(Math.abs(roundTripPct() - 0.2308) < 1e-9);
  assert.ok(Math.abs(costBps() - 11.54) < 1e-9);
});

test("the FX spread is excluded from per-trade cost because it is not paid per trade", () => {
  assert.ok(TOSS_US_EQUITY.fxSpreadPct > 0);
  assert.ok(roundTripPct() < TOSS_US_EQUITY.fxSpreadPct + 0.2308);
});

test("cost in R scales inversely with the stop, which is the whole point", () => {
  assert.ok(Math.abs(costInR(1) - 0.2308) < 1e-9);
  // A quarter of the stop is four times the cost against risk.
  assert.ok(Math.abs(costInR(0.25) - costInR(1) * 4) < 1e-9);
  assert.ok(costInR(3) < costInR(1));
  // A zero stop cannot divide by zero and silently return Infinity downstream.
  assert.ok(Number.isFinite(costInR(0)));
});
