import test from "node:test";
import assert from "node:assert/strict";
import { emptyDashboard, startDashboard } from "../lib/trading-engine.ts";
import { tickCTDashboard } from "../lib/ct-trading-engine.ts";
import { ctHash, executableCT } from "../lib/ct-spec.ts";
import { ctProfileCosts } from "../lib/ct-costs.ts";
import { ctStopLimitPrice } from "../lib/ct-limit-execution.ts";
import { paperLimitFill, paperWouldMatchNow } from "../lib/ct-paper-fills.ts";
import { spec, contract, bars } from "./helpers/ct-fixture.mjs";

const execution = ctProfileCosts("crypto", ["BTCUSDT"], 1000).execution;
async function fixture() {
  const rule = spec(),
    c = { ...contract(), currency: "USDT", execution },
    rows = bars(10);
  let now = rows.at(-1).endMs + 1000,
    id = 0,
    saved;
  let state = startDashboard(emptyDashboard("live"), { now: () => now, id: () => String(++id) });
  state.cashUsd = c.capital;
  state.initialCapitalUsd = c.capital;
  state.peakEquityUsd = c.capital;
  state.ctRules = [{ id: "ct1", spec: rule, hash: await ctHash(executableCT(rule)), contract: c }];
  state.strategyIds = ["ct1"];
  state.strategies = { ct1: { id: "ct1", name: rule.name, slot: "open", signals: 0, entries: 0, missed: 0, closed: 0, compliant: 0, deviations: 0, wins: 0, pnlUsd: 0, commissionUsd: 0 } };
  const orders = new Map(), submitted = [], canceled = [], ledger = [];
  let quotePrice = rows.at(-1).close;
  const broker = {
    mode: "live",
    quote: async () => ({ price: quotePrice, bid: quotePrice - 0.01, ask: quotePrice + 0.01, timestamp: new Date(now).toISOString(), bookTimestamp: new Date(now).toISOString() }),
    buyingPowerUsd: async () => c.capital,
    sellableQuantity: async () => 1e9,
    submit: async (r) => {
      submitted.push(r);
      orders.set(r.clientOrderId, { id: "B" + submitted.length, status: "working", filledQuantity: 0, averageFillPrice: null, commissionUsd: 0 });
      return { brokerOrderId: "B" + submitted.length };
    },
    recover: async (o) => orders.get(o.clientOrderId)?.id ?? null,
    poll: async (o) => orders.get(o.clientOrderId),
    cancel: async (o) => {
      canceled.push(o.clientOrderId);
      const s = orders.get(o.clientOrderId);
      if (s.status === "working") s.status = "canceled";
    },
  };
  const deps = {
    now: () => now, id: () => String(++id), broker, bars: async () => rows, entryAllowed: async () => true,
    checkpoint: async (s) => { saved = structuredClone(s); },
    intents: {
      prepare: async (o) => { assert.equal(saved.orders.at(-1).status, "submitting", "state intent first"); ledger.push(["prepare", o.id, o.orderType]); },
      settle: async (o, status) => { ledger.push(["settle", o.id, status]); },
    },
  };
  return {
    get state() { return state; }, deps, orders, submitted, canceled, ledger,
    async tick() { state = await tickCTDashboard(state, deps); return state; },
    fillOrder(i, q, price) { const o = orders.get(submitted[i].clientOrderId); Object.assign(o, { status: "filled", filledQuantity: q, averageFillPrice: price, commissionUsd: q * price * 0.001 }); },
    setQuote(p) { quotePrice = p; },
    advance(ms) { now += ms; },
  };
}

test("live limit entry: a post-only buy at the decision close rounded down, intent written before the order leaves", async () => {
  const f = await fixture();
  await f.tick();
  const r = f.submitted[0];
  assert.equal(r.side, "buy");
  assert.equal(r.orderType, "limit_maker");
  assert.equal(r.limitPrice, 101.1, "the signal bar's close, not the ask");
  assert.notEqual(r.limitPrice, f.state.orders[0].limitPrice + 1);
  assert.equal(f.state.orders[0].feePct, execution.makerFeePct);
  assert.deepEqual(f.ledger.map((l) => l[0]), ["prepare", "settle"]);
  assert.equal(f.ledger[1][2], "acknowledged");
});

test("live limit entry: an order not filled within entryTtlBars bars is cancelled and the signal is counted missed", async () => {
  const f = await fixture();
  await f.tick();
  f.advance(execution.entryTtlBars * 300000);
  await f.tick();
  assert.equal(f.canceled.length, 1);
  await f.tick();
  assert.equal(f.state.trades[0].status, "missed");
  assert.equal(f.state.strategies.ct1.missed, 1);
  assert.ok(f.ledger.some((l) => l[0] === "settle" && l[2] === "canceled"));
});

test("live limit exits: the resting target waits for the bar after the fill, a stop cancels it, then the stop-limit is chased and ends in the one emergency market sell", async () => {
  const f = await fixture();
  await f.tick();
  const q = f.state.orders[0].quantity;
  f.fillOrder(0, q, 101.1);
  await f.tick();
  assert.equal(f.submitted.length, 1, "no target in the bar the entry filled in");
  f.advance(300000);
  await f.tick();
  const target = f.submitted[1];
  assert.equal(target.side, "sell");
  assert.equal(target.orderType, "limit_maker");
  assert.ok(target.limitPrice > 101.1 * 1.0199 && target.limitPrice < 101.1 * 1.0201, "2% above the fill, rounded up to the tick");
  assert.equal(f.state.orders.at(-1).purpose, "target");
  // The price falls through the stop: the target is cancelled first (one sell at a time), then the stop-limit goes out.
  f.setQuote(95);
  await f.tick();
  assert.equal(f.canceled.length, 1);
  await f.tick();
  const stop = f.submitted[2];
  assert.equal(stop.orderType, "limit");
  const stopLevel = f.state.trades[0].ctPosition.stopLevel;
  assert.equal(stop.limitPrice, ctStopLimitPrice(stopLevel, execution.stop, 0.01), "limit sits slackPct beyond the stop level");
  // Not filled within chaseSeconds: cancelled and re-priced lower, each time.
  const prices = [stop.limitPrice];
  for (let k = 1; k <= execution.stop.maxChases; k++) {
    f.advance((execution.stop.chaseSeconds + 1) * 1000);
    await f.tick(); // cancel
    await f.tick(); // canceled seen → chase counter
    await f.tick(); // re-priced sell
    const last = f.submitted.at(-1);
    assert.equal(last.orderType, "limit");
    prices.push(last.limitPrice);
  }
  assert.ok(prices.every((p, i) => i === 0 || p < prices[i - 1]), `strictly lower each time: ${prices}`);
  // After maxChases re-prices: the emergency market sell, recorded.
  f.advance((execution.stop.chaseSeconds + 1) * 1000);
  await f.tick();
  await f.tick();
  await f.tick();
  const last = f.submitted.at(-1);
  assert.equal(last.orderType, "market");
  assert.equal(last.limitPrice, null);
  assert.equal(f.state.trades[0].ctEmergency, true);
  assert.ok(f.state.events.some((e) => /비상 시장가/.test(e.message)));
});

test("a resting target that fills by itself closes the trade with exit 'target'", async () => {
  const f = await fixture();
  await f.tick();
  const q = f.state.orders[0].quantity;
  f.fillOrder(0, q, 101.1);
  await f.tick();
  f.advance(300000);
  await f.tick();
  f.fillOrder(1, q, f.submitted[1].limitPrice);
  await f.tick();
  assert.equal(f.state.trades[0].status, "closed");
  assert.equal(f.state.trades[0].exit, "target");
  assert.equal(f.state.trades[0].ctExitReason, "target");
});

test("paper limit fills use the backtest rule on real candles: a touch never fills, a candle in progress at submit time is ignored", () => {
  const candle = (startMs, low, high) => ({ startMs, endMs: startMs + 60000, open: 100, high, low, close: 100, volume: 1 });
  const base = { side: "buy", orderType: "limit_maker", limitPrice: 100, submittedAtMs: 1_000_000, tick: 0.01, penetrationTicks: 1 };
  const quote = { bid: 100.05, ask: 100.06 };
  assert.equal(paperLimitFill(base, quote, [candle(1_000_001, 100, 101)]), null, "touch");
  assert.equal(paperLimitFill(base, quote, [candle(940_000, 99.9, 101)]), null, "started before the order");
  assert.deepEqual(paperLimitFill(base, quote, [candle(1_060_000, 99.99, 101)]), { price: 100, leg: "maker" });
  assert.deepEqual(paperLimitFill({ ...base, side: "sell", limitPrice: 100.3 }, quote, [candle(1_060_000, 100, 100.31)]), { price: 100.3, leg: "maker" });
  // Marketable limit sell and the emergency market sell take the bid as a taker.
  assert.deepEqual(paperLimitFill({ ...base, side: "sell", orderType: "limit", limitPrice: 100 }, quote, []), { price: 100.05, leg: "taker" });
  assert.deepEqual(paperLimitFill({ ...base, side: "sell", orderType: "market", limitPrice: null }, quote, []), { price: 100.05, leg: "taker" });
  assert.equal(paperWouldMatchNow({ side: "buy", limitPrice: 100.06 }, quote), true, "post-only would be refused");
  assert.equal(paperWouldMatchNow({ side: "buy", limitPrice: 100 }, quote), false);
});
