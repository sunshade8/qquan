import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { golden } from "./helpers/ct-golden-cases.mjs";

// The digests were recorded with the engine as it stood before ct-pattern-2 (day-end exits,
// 60/240/1440-minute timeframes, cost profiles, noEntryBeforeDayEndMinutes). A registered
// ct-pattern-1 package must keep judging bit for bit the same.
const expected = JSON.parse(readFileSync(new URL("./fixtures/ct-pattern-1-golden.json", import.meta.url), "utf8"));

test("ct-pattern-1 signals, trades, equity curve and gate are unchanged bit for bit", () => {
  const actual = golden();
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const id of Object.keys(expected)) {
    assert.equal(actual[id].trades, expected[id].trades, `${id}: trade count`);
    assert.equal(actual[id].net, expected[id].net, `${id}: net return`);
    assert.equal(actual[id].digest, expected[id].digest, `${id}: full result digest`);
  }
});
