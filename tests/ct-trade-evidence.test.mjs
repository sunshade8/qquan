import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { bars, spec, contract } from "./helpers/ct-fixture.mjs";
import { ctHash, executableCT } from "../lib/ct-spec.ts";
import { detectCT } from "../lib/ct-engine.ts";
register("./helpers/slot-test-loader.mjs", import.meta.url);
const sqlite = new DatabaseSync(":memory:");
class Statement {
  constructor(sql, values = []) {
    this.sql = sql;
    this.values = values;
  }
  bind(...v) {
    return new Statement(this.sql, v);
  }
  async first() {
    return sqlite.prepare(this.sql).get(...this.values) ?? null;
  }
  async run() {
    return {
      meta: {
        changes: Number(sqlite.prepare(this.sql).run(...this.values).changes),
      },
    };
  }
}
globalThis.__strategyTestEnv = { DB: { prepare: (s) => new Statement(s) } };
const evidence = await import("../lib/ct-trade-evidence.ts");
sqlite.exec(
  "CREATE TABLE ct_trade_charts (book TEXT,mode TEXT,trade_id TEXT,payload TEXT,PRIMARY KEY(book,mode,trade_id))",
);
test("CT trade chart stores observed original candles, survives cache loss, isolates book/mode and refuses altered approved rules", async () => {
  const data = bars(10),
    now = data.at(-1).endMs,
    rule = {
      id: "ct1",
      spec: spec(),
      contract: contract(),
      hash: await ctHash(executableCT(spec())),
    };
  const trade = {
    id: "t1",
    ctHash: rule.hash,
    ctSignal: detectCT(rule.spec, "KRW-BTC", data, now),
    status: "entering",
  };
  await evidence.saveCTTradeEvidence(
    "ct-crypto",
    "paper",
    trade,
    rule,
    [...data, ...bars(2, now)],
    now,
  );
  let packet = await evidence.getCTTradeEvidence("ct-crypto", "paper", "t1");
  assert.equal(packet.bars.length, 10);
  assert.ok(packet.bars.every((b) => b.endMs <= now));
  assert.equal(
    await evidence.getCTTradeEvidence("ct-stock", "paper", "t1"),
    null,
  );
  assert.equal(
    await evidence.getCTTradeEvidence("ct-crypto", "live", "t1"),
    null,
  );
  await evidence.saveCTTradeEvidence(
    "ct-crypto",
    "paper",
    { ...trade, status: "closed" },
    rule,
    [],
    now + 60000,
  );
  packet = await evidence.getCTTradeEvidence("ct-crypto", "paper", "t1");
  assert.equal(packet.bars.length, 10);
  assert.equal(packet.trade.status, "closed");
  await assert.rejects(
    () =>
      evidence.saveCTTradeEvidence(
        "ct-crypto",
        "paper",
        trade,
        {
          ...rule,
          spec: { ...rule.spec, exit: { ...rule.spec.exit, stopPct: 2 } },
        },
        [],
        now,
      ),
    /해시/,
  );
  const corrected = data.map((b) => ({ ...b }));
  corrected[3].close += 0.01;
  await assert.rejects(
    () =>
      evidence.saveCTTradeEvidence(
        "ct-crypto",
        "paper",
        trade,
        rule,
        corrected,
        now,
      ),
    /과거 봉 변경/,
  );
  assert.equal(
    (await evidence.getCTTradeEvidence("ct-crypto", "paper", "t1")).bars[3]
      .close,
    data[3].close,
  );
});
