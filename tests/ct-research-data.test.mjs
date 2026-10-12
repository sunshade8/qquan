import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { contract } from "./helpers/ct-fixture.mjs";
register("./helpers/slot-test-loader.mjs", import.meta.url);
globalThis.__strategyTestEnv = { MASSIVE_API_KEY: "fixture", MASSIVE_CALLS_PER_MINUTE: "100000" };
const { ctDataPage, ctResearchPageStart } = await import("../lib/ct-data.ts");

test("stock research fetches unadjusted historical Massive bars without Toss credentials or auth", async () => {
  const c = contract("stock"), original = globalThis.fetch, requests = [];
  const timestamp = Date.UTC(2025, 0, 2, 15);
  globalThis.fetch = async (value) => {
    const url = new URL(value);
    requests.push(url);
    assert.equal(url.hostname, "api.massive.com", "research must never authenticate with Toss");
    assert.equal(url.searchParams.get("adjusted"), "false");
    assert.match(url.pathname, /\/range\/1\/minute\//);
    return Response.json({ results: [
      { t: timestamp, o: 100, h: 102, l: 99, c: 101, v: 20 },
      { t: c.toMs, o: 100, h: 102, l: 99, c: 101, v: 20 },
    ] });
  };
  try {
    const bars = await ctDataPage(c, "SPY", c.toMs);
    assert.equal(requests.length, 1);
    assert.deepEqual(bars, [{ startMs: timestamp, endMs: timestamp + 60000,
      open: 100, high: 102, low: 99, close: 101, volume: 20 }]);
  } finally { globalThis.fetch = original; }
});

test("empty historical windows advance by bounded time instead of ending collection", async () => {
  const c = { ...contract("stock"), toMs: Date.UTC(2025, 1, 1) };
  assert.equal(ctResearchPageStart(c, c.toMs), c.toMs - 7 * 86400000);
  assert.equal(ctResearchPageStart(c, c.fromMs + 86400000), c.fromMs);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).hostname, "api.massive.com");
    return Response.json({ results: [] });
  };
  try { assert.deepEqual(await ctDataPage(c, "SPY", c.toMs), []); }
  finally { globalThis.fetch = original; }
});
