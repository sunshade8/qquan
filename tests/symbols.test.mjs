import assert from "node:assert/strict";
import test from "node:test";
import { resolveSymbol } from "../lib/symbols.ts";

test("does not fabricate a public price series for private companies", async () => {
  const asset = await resolveSymbol("SpaceX");
  assert.equal(asset.public, false);
  assert.equal(asset.symbol, null);
  assert.match(asset.note, /비상장/);
});

test("maps Korean nicknames and index names without a network call", async () => {
  assert.equal((await resolveSymbol("엔비디아")).symbol, "NVDA");
  assert.equal((await resolveSymbol("삼성전자")).symbol, "005930.KS");
  assert.equal((await resolveSymbol("나스닥")).symbol, "^IXIC");
  assert.equal((await resolveSymbol("Rocket Lab")).tradingView, "NASDAQ:RKLB");
});
