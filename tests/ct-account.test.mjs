import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
register("./helpers/slot-test-loader.mjs", import.meta.url);
const sqlite = new DatabaseSync(":memory:");
class Statement {
  constructor(sql, values = []) {
    this.sql = sql;
    this.values = values;
  }
  bind(...values) {
    return new Statement(this.sql, values);
  }
  async run() {
    return {
      meta: {
        changes: Number(sqlite.prepare(this.sql).run(...this.values).changes),
      },
    };
  }
  async all() {
    return { results: sqlite.prepare(this.sql).all(...this.values) };
  }
}
globalThis.__strategyTestEnv = { DB: { prepare: (s) => new Statement(s) } };
const locks = await import("../lib/trading-account-lock.ts");
sqlite.exec(
  "CREATE TABLE trading_dashboards (id TEXT PRIMARY KEY,state_payload TEXT)",
);
const put = (id, mode, orders) =>
  sqlite
    .prepare("INSERT OR REPLACE INTO trading_dashboards VALUES (?,?)")
    .run(id, JSON.stringify({ mode, orders }));
const buy = (status, quantity = 3, filledQuantity = 1) => ({
  side: "buy",
  status,
  quantity,
  filledQuantity,
  limitPrice: 100,
});
test("CT account reservations include remaining working/canceling buys across Toss books, exclude paper and Upbit", async () => {
  put("live", "live", [
    buy("working"),
    buy("filled"),
    { ...buy("working"), side: "sell" },
  ]);
  put("surge-live", "live", [buy("cancel_requested")]);
  put("ct-stock-live", "live", [buy("working", 100)]);
  put("ct-crypto-live", "live", [buy("submitting", 1000)]);
  put("surge-paper", "paper", [buy("working", 1000)]);
  assert.equal(await locks.otherBookReservations("ct-stock-live"), 404);
  assert.equal(await locks.otherBookReservations("ct-crypto-live"), 0);
  assert.equal(await locks.accountHasUncertainOrders("ct-stock-live"), false);
  put("live", "live", [buy("submitting")]);
  assert.equal(await locks.accountHasUncertainOrders("ct-stock-live"), true);
  assert.equal(await locks.accountHasUncertainOrders("ct-crypto-live"), false);
});
test("CT account lease rejects concurrent writer and expired owner cannot renew or release successor", async () => {
  assert.equal(await locks.accountLock("toss", "a"), true);
  assert.equal(await locks.accountLock("toss", "b"), false);
  sqlite
    .prepare("UPDATE trading_account_locks SET until_ms=0 WHERE id=?")
    .run("toss");
  assert.equal(await locks.accountLock("toss", "b"), true);
  await assert.rejects(() => locks.renewAccountLock("toss", "a"), /잠금 만료/);
  await locks.releaseAccountLock("toss", "a");
  assert.equal(await locks.accountLock("toss", "c"), false);
  await locks.releaseAccountLock("toss", "b");
  assert.equal(await locks.accountLock("toss", "c"), true);
  assert.equal(await locks.accountLock("upbit", "d"), true);
});
