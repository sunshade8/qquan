import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  emptyDashboard,
  startDashboard,
  BrokerRejection,
} from "../lib/trading-engine.ts";
import { tickCTDashboard } from "../lib/ct-trading-engine.ts";
import { ctHash, executableCT } from "../lib/ct-spec.ts";
import { spec, contract, bars } from "./helpers/ct-fixture.mjs";
async function fixture(mode = "live") {
  const rule = spec(),
    c = contract(),
    rows = bars(10);
  let now = rows.at(-1).endMs + 1000,
    id = 0,
    saved;
  let state = startDashboard(emptyDashboard(mode), {
    now: () => now,
    id: () => String(++id),
  });
  state.cashUsd = c.capital;
  state.initialCapitalUsd = c.capital;
  state.peakEquityUsd = c.capital;
  state.ctRules = [
    {
      id: "ct1",
      spec: rule,
      hash: await ctHash(executableCT(rule)),
      contract: c,
    },
  ];
  state.strategyIds = ["ct1"];
  state.strategies = {
    ct1: {
      id: "ct1",
      name: rule.name,
      slot: "open",
      signals: 0,
      entries: 0,
      missed: 0,
      closed: 0,
      compliant: 0,
      deviations: 0,
      wins: 0,
      pnlUsd: 0,
      commissionUsd: 0,
    },
  };
  const orders = new Map(),
    submitted = [],
    canceled = [];
  let reject = null,
    lose = false,
    quotePrice = rows.at(-1).close;
  const broker = {
    mode,
    quote: async () => ({
      price: quotePrice,
      bid: quotePrice - 0.01,
      ask: quotePrice + 0.01,
      timestamp: new Date(now).toISOString(),
      bookTimestamp: new Date(now).toISOString(),
    }),
    buyingPowerUsd: async () => c.capital,
    sellableQuantity: async () => 1e9,
    submit: async (r) => {
      assert.equal(
        saved.orders.at(-1).status,
        "submitting",
        "intent before network",
      );
      submitted.push(r);
      if (reject) throw reject;
      orders.set(r.clientOrderId, {
        id: "B" + submitted.length,
        status: "working",
        filledQuantity: 0,
        averageFillPrice: null,
        commissionUsd: 0,
      });
      if (lose) throw new Error("lost response");
      return { brokerOrderId: "B" + submitted.length };
    },
    recover: async (o) => orders.get(o.clientOrderId)?.id ?? null,
    poll: async (o) => orders.get(o.clientOrderId),
    cancel: async (o) => {
      canceled.push(o.clientOrderId);
      orders.get(o.clientOrderId).status = "canceled";
    },
  };
  const deps = {
    now: () => now,
    id: () => String(++id),
    broker,
    bars: async () => rows,
    entryAllowed: async () => true,
    checkpoint: async (s) => {
      saved = structuredClone(s);
    },
  };
  return {
    get state() {
      return state;
    },
    set state(v) {
      state = v;
    },
    deps,
    orders,
    submitted,
    canceled,
    async tick() {
      state = await tickCTDashboard(state, deps);
      return state;
    },
    fill(q, price) {
      const o = orders.values().next().value;
      o.filledQuantity = q;
      o.averageFillPrice = price;
      o.commissionUsd = q * price * 0.001;
    },
    setQuote(p) {
      quotePrice = p;
    },
    reject(e) {
      reject = e;
    },
    lose() {
      lose = true;
    },
    advance(ms) {
      now += ms;
    },
  };
}
test("CT pins hash, checkpoints intent before submit and reconciles response loss without resubmission", async () => {
  const f = await fixture();
  f.lose();
  await f.tick();
  assert.equal(f.submitted.length, 1);
  assert.equal(f.state.orders[0].status, "submitting");
  await f.tick();
  assert.equal(f.submitted.length, 1);
  assert.ok(f.state.orders[0].brokerOrderId);
  const q = f.state.orders[0].quantity;
  f.fill(q / 2, 101);
  await f.tick();
  const cash = f.state.cashUsd;
  await f.tick();
  assert.equal(f.state.cashUsd, cash);
  assert.equal(f.state.trades[0].boughtQuantity, q / 2);
});
test("CT partial buy cancels before stop sells only owned filled quantity", async () => {
  const f = await fixture();
  await f.tick();
  const q = f.state.orders[0].quantity;
  f.fill(q / 2, 101);
  await f.tick();
  f.state.status = "stopping";
  await f.tick();
  assert.equal(f.submitted.length, 1);
  assert.ok(f.canceled.length);
  await f.tick();
  assert.equal(f.submitted.length, 2);
  assert.equal(f.submitted[1].side, "sell");
  assert.equal(f.submitted[1].quantity, q / 2);
  const exit = f.orders.get(f.submitted[1].clientOrderId);
  Object.assign(exit, {
    status: "filled",
    filledQuantity: q / 2,
    averageFillPrice: 101,
    commissionUsd: (q / 2) * 101 * 0.001,
  });
  await f.tick();
  assert.equal(f.state.status, "stopped");
  assert.equal(f.state.trades[0].status, "closed");
});
test("CT ambiguous unresolved order blocks all new entries and shutdown completion", async () => {
  const f = await fixture();
  f.deps.broker.submit = async () => {
    throw new Error("ambiguous");
  };
  await f.tick();
  await f.tick();
  assert.equal(f.state.orders.length, 1);
  f.state.status = "stopping";
  await f.tick();
  assert.equal(f.state.status, "stopping");
});
test("CT live missing buying power, stale quotes and expired signal cannot send an order", async () => {
  for (const mode of ["balance", "stale", "expired"]) {
    const f = await fixture();
    if (mode === "balance") delete f.deps.broker.buyingPowerUsd;
    if (mode === "stale")
      f.deps.broker.quote = async () => ({
        price: 101,
        bid: 100.99,
        ask: 101.01,
        timestamp: "2020-01-01",
        bookTimestamp: "2020-01-01",
      });
    if (mode === "expired") f.advance(300000);
    await f.tick();
    assert.equal(f.submitted.length, 0, mode);
  }
});
test("CT rejects definite broker denial and refuses changed approved rules", async () => {
  const f = await fixture();
  f.reject(new BrokerRejection("denied", "test"));
  await f.tick();
  assert.equal(f.state.orders[0].status, "rejected");
  assert.equal(f.state.trades[0].status, "missed");
  f.state.ctRules[0].spec.exit.stopPct = 2;
  await assert.rejects(() => f.tick(), /해시/);
});
test("CT trading path contains no model or research-runtime imports", () => {
  for (const file of ["ct-trading-engine", "ct-engine"])
    assert.doesNotMatch(
      readFileSync(new URL(`../lib/${file}.ts`, import.meta.url), "utf8"),
      /generationCall|openaiClient|claudeClient|ask\(/,
    );
});

test("CT stores engine trade evidence before entry and after actual reconciled close; evidence outage cannot suppress stop monitoring", async () => {
  const f = await fixture(),
    snapshots = [];
  f.deps.evidence = async (trade, rows) =>
    snapshots.push(structuredClone({ trade, rows }));
  await f.tick();
  assert.ok(snapshots[0].rows.length);
  assert.equal(snapshots[0].trade.ctHash, f.state.ctRules[0].hash);
  const q = f.state.orders[0].quantity;
  f.fill(q, 101.1);
  f.orders.values().next().value.status = "filled";
  await f.tick();
  assert.ok(snapshots.some((s) => s.trade.entryAt));
  f.deps.evidence = async () => {
    throw new Error("fixture chart storage outage");
  };
  f.setQuote(95);
  await f.tick();
  assert.equal(f.submitted.length, 2);
  f.deps.evidence = async (trade, rows) =>
    snapshots.push(structuredClone({ trade, rows }));
  const sell = [...f.orders.values()][1];
  Object.assign(sell, {
    status: "filled",
    filledQuantity: q,
    averageFillPrice: 95,
    commissionUsd: q * 95 * 0.001,
  });
  await f.tick();
  assert.ok(
    snapshots.some(
      (s) => s.trade.status === "closed" && s.trade.exitPrice === 95,
    ),
  );
});
test("CT signal expiring while evidence/intent is persisted never reaches the broker", async () => {
  const f = await fixture();
  f.deps.evidence = async () => f.advance(600000);
  await f.tick();
  assert.equal(f.submitted.length, 0);
  assert.equal(f.state.orders[0].status, "rejected");
});
