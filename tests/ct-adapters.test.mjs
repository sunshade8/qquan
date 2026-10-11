import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { register } from "node:module";
import { D1HttpDatabase } from "../lib/runtime/d1-http.ts";
register("./helpers/slot-test-loader.mjs", import.meta.url);
globalThis.__strategyTestEnv = { UPBIT_TRADING_DISABLED: "true" };
const u = await import("../lib/upbit.ts");
test("Upbit JWT uses raw SHA512 query and HS512 with unique nonce, no base64-decoded secret", async () => {
  const query = "market=KRW-BTC&identifier=ct-id",
    token = await u.upbitJwt(
      "fixture-access",
      "fixture-secret",
      query,
      "fixture-nonce",
    ),
    [h, p, s] = token.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url")).alg, "HS512");
  assert.equal(
    JSON.parse(Buffer.from(p, "base64url")).query_hash,
    createHash("sha512").update(query).digest("hex"),
  );
  assert.equal(
    s,
    createHmac("sha512", "fixture-secret")
      .update(`${h}.${p}`)
      .digest("base64url"),
  );
  assert.notEqual(
    await u.upbitJwt("a", "b", ""),
    await u.upbitJwt("a", "b", ""),
  );
});
test("Upbit decimal precision and authoritative tick avoid binary rounding", () => {
  assert.equal(u.decimalFloor("0.123456789", 8), "0.12345678");
  assert.equal(u.upbitLimit("100001.9", "buy"), "100000");
  assert.equal(u.upbitLimit("100001.9", "sell"), "100100");
  assert.equal(u.upbitLimit("0.000001239", "buy"), "0.00000123");
});
test("Upbit live lock blocks before any network or order side effect", async () => {
  await assert.rejects(
    () =>
      u.upbitSubmit({
        symbol: "KRW-BTC",
        side: "buy",
        quantity: "1",
        price: "100000",
        identifier: "fixture",
      }),
    /실주문 잠금/,
  );
});
test("D1 Node adapter has no ephemeral fallback and preserves parameterized batch", async () => {
  await assert.rejects(
    () => new D1HttpDatabase(() => ({})).prepare("SELECT 1").all(),
    /연결 미설정/,
  );
  const fetchOriginal = globalThis.fetch,
    requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return Response.json({
      success: true,
      result: JSON.parse(options.body).batch.map(() => ({
        success: true,
        results: [{ value: 7 }],
        meta: { changes: 1 },
      })),
    });
  };
  try {
    const db = new D1HttpDatabase(() => ({
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_D1_DATABASE_ID:
        "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12),
      CLOUDFLARE_D1_API_TOKEN: "fixture",
    }));
    await db.batch([
      db.prepare("INSERT INTO t VALUES (?)").bind("a'); DROP TABLE t;--"),
      db.prepare("SELECT ? AS value").bind(7),
    ]);
    assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0].body);
    assert.equal(body.batch[0].sql, "INSERT INTO t VALUES (?)");
    assert.equal(body.batch[0].params[0], "a'); DROP TABLE t;--");
    assert.equal(await db.prepare("SELECT value FROM t").first("value"), 7);
    assert.deepEqual(await db.prepare("SELECT value FROM t").raw(), [[7]]);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
test("D1 ambiguous mutation response is never blindly retried", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("lost");
  };
  try {
    const db = new D1HttpDatabase(() => ({
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_D1_DATABASE_ID: "a".repeat(36),
      CLOUDFLARE_D1_API_TOKEN: "fixture",
    }));
    await assert.rejects(() => db.prepare("UPDATE t SET x=1").run(), /lost/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("CT document reader rejects private, loopback, metadata and reserved DNS addresses", async () => {
  const { ctPublicAddress } = await import("../lib/ct-source-network.ts");
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "100.64.0.1",
    "198.18.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ])
    assert.equal(ctPublicAddress(ip), false, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(ctPublicAddress(ip), true, ip);
});

test("CT replay executable prices round conservatively to stock and KRW ticks", async () => {
  const { ctFillPrice } = await import("../lib/market-precision.ts");
  assert.equal(ctFillPrice(100001.9, "crypto", "buy"), 100100);
  assert.equal(ctFillPrice(100001.9, "crypto", "sell"), 100000);
  assert.equal(ctFillPrice(101.001, "stock", "buy"), 101.01);
  assert.equal(ctFillPrice(101.009, "stock", "sell"), 101);
});
