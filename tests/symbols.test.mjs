import assert from "node:assert/strict";
import test from "node:test";
import { resolveSymbol } from "../lib/symbols.ts";

test("resolves SpaceX to its current listed common stock", async () => {
  const asset = await resolveSymbol("SpaceX");
  assert.equal(asset.public, true);
  assert.equal(asset.symbol, "SPCX");
  assert.notEqual(asset.quoteType, "FUTURE");
  assert.notEqual(asset.quoteType, "ETF");
  assert.ok(["listed", "candidate"].includes(asset.listingStatus));
});

test("maps Korean nicknames and index names to stable ticker candidates", async () => {
  assert.equal((await resolveSymbol("엔비디아")).symbol, "NVDA");
  assert.equal((await resolveSymbol("삼성전자")).symbol, "005930.KS");
  assert.equal((await resolveSymbol("나스닥")).symbol, "^IXIC");
  assert.equal((await resolveSymbol("Rocket Lab")).tradingView, "NASDAQ:RKLB");
});
