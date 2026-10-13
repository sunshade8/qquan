import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { goldenV2 } from "./helpers/ct-golden-v2.mjs";

// Digests recorded with the engine before ct-pattern-3 (see tests/helpers/ct-golden-v2.mjs):
// classic exits on ct-pattern-1 and ct-pattern-2, higher timeframes, day-end exits, stock sessions,
// the 2× cost and 1-bar delay stress runs — every field of every result, the gate verdict and the summary.
test("classic rules judge bit for bit as they did before ct-pattern-3 (signals, trades, daily curve, gate, stress runs)", () => {
  const golden = JSON.parse(readFileSync(new URL("./fixtures/ct-pattern-2-golden.json", import.meta.url), "utf8"));
  const now = goldenV2();
  assert.deepEqual(Object.keys(now), Object.keys(golden));
  for (const key of Object.keys(golden)) assert.equal(now[key], golden[key], key);
  assert.ok(Object.values(golden).some((v) => Number(v.split(":")[1]) > 100), "the cases are not empty");
});
