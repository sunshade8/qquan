import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./helpers/slot-test-loader.mjs", import.meta.url);
const { upbitEnabled, assertUpbitStartAllowed, isUpbitContract, UPBIT_OFF_MESSAGE } = await import("../lib/upbit-flag.ts");
const { CT_COST_PROFILES, ctCostProfile } = await import("../lib/ct-costs.ts");
const { contract } = await import("./helpers/ct-fixture.mjs");

test("Upbit is off unless QQUAN_ENABLE_UPBIT=true exactly", () => {
  assert.equal(upbitEnabled(() => undefined), false);
  assert.equal(upbitEnabled(() => "false"), false);
  assert.equal(upbitEnabled(() => "1"), false);
  assert.equal(upbitEnabled((k) => (k === "QQUAN_ENABLE_UPBIT" ? "true" : undefined)), true);
});
test("a new Upbit (KRW) start is refused by the server while off, and allowed again with the flag; Binance (USDT) is never affected", () => {
  assert.equal(isUpbitContract({ currency: "KRW" }), true);
  assert.throws(() => assertUpbitStartAllowed({ currency: "KRW" }, false), new RegExp(UPBIT_OFF_MESSAGE.slice(0, 8)));
  assert.doesNotThrow(() => assertUpbitStartAllowed({ currency: "KRW" }, true));
  assert.doesNotThrow(() => assertUpbitStartAllowed({ currency: "USDT" }, false));
});
test("the server gates are wired: ctStartState asserts, the runner hides KRW packages, readiness explains (static check — ct-trading pulls in Toss modules the loader cannot run)", async () => {
  const { readFileSync } = await import("node:fs");
  const trading = readFileSync(new URL("../lib/ct-trading.ts", import.meta.url), "utf8");
  assert.match(trading, /assertUpbitStartAllowed\(chosen\.contract\)/);
  assert.match(trading, /UPBIT_OFF_MESSAGE/);
  const runner = readFileSync(new URL("../lib/trading-runner.ts", import.meta.url), "utf8");
  assert.equal((runner.match(/upbitEnabled\(\)\|\|!isUpbitContract/g) ?? []).length, 2, "dashboards and start both filter");
});
test("old Upbit records stay readable with the flag off: the upbit-krw profile and its stored numbers", () => {
  assert.equal(process.env.QQUAN_ENABLE_UPBIT, undefined);
  assert.equal(contract("crypto").currency, "KRW");
  assert.equal(CT_COST_PROFILES["upbit-krw"].feePct, 0.05);
  assert.ok(ctCostProfile("upbit-krw"));
});
