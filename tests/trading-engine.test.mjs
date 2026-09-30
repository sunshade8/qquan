import assert from "node:assert/strict";
import test from "node:test";
import {
  createPaperBroker, dashboardSummary, emptyDashboard, heldQuantity, requestStop, startDashboard, tickDashboard, BrokerRejection,
} from "../lib/trading-engine.ts";
import { aggregateFiveMinute, aggregateMinuteCandles, rangeAfter } from "../lib/live-bars.ts";
import { easternWallTimeToEpoch } from "../lib/market-clock.ts";
import { assessTrade } from "../lib/trade-adherence.ts";
import { rollUpComplete } from "../lib/bar-rollup.ts";

const DATE = "2026-09-16"; // a Wednesday, US daylight time
const at = (time, seconds = 0) => easternWallTimeToEpoch(DATE, time) + seconds * 1000;

/** Flat 5-minute bars from 04:00 with per-time overrides. */
function dayBars(price, overrides = {}) {
  const bars = [];
  for (let minute = 4 * 60; minute < 20 * 60; minute += 5) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const bar = overrides[time] ?? {};
    const close = bar.close ?? price;
    bars.push({ date: DATE, time, open: bar.open ?? close, high: bar.high ?? close, low: bar.low ?? close, close, volume: 1_000 });
  }
  return bars;
}

/** Market data that only ever hands out bars whose five minutes are over. */
function fakeMarket(bars, ranges = []) {
  const calls = { sessionBars: [] };
  return {
    calls,
    async sessionBars(symbol, date, nowMs) {
      calls.sessionBars.push(nowMs);
      return (bars[symbol] ?? []).filter((bar) => easternWallTimeToEpoch(date, bar.time) + 300_000 <= nowMs);
    },
    async priorSessions() { return []; },
    async range(symbol, fromMs, toMs) {
      const inside = ranges.filter((item) => item.symbol === symbol && item.atMs > fromMs && item.atMs <= toMs);
      return inside.length ? { low: Math.min(...inside.map((item) => item.low)), high: Math.max(...inside.map((item) => item.high)) } : null;
    },
  };
}

/** A resting-order broker: orders stay open until the test fills or cancels them. */
function fakeLiveBroker(prices) {
  const book = new Map();
  let sequence = 0;
  const broker = {
    mode: "live",
    submits: [],
    cancels: [],
    loseNextResponse: false,
    rejectNext: null,
    async quote(symbol) { return { price: prices[symbol], bid: prices[symbol] - 0.01, ask: prices[symbol] + 0.01 }; },
    async submit(request) {
      broker.submits.push(request);
      if (broker.rejectNext) { const message = broker.rejectNext; broker.rejectNext = null; throw new BrokerRejection(message, "order-hours-closed"); }
      let existing = [...book.values()].find((order) => order.clientOrderId === request.clientOrderId);
      if (!existing) {
        existing = { id: `B${(sequence += 1)}`, clientOrderId: request.clientOrderId, request, status: "working", filledQuantity: 0, averageFillPrice: null, commissionUsd: 0 };
        book.set(existing.id, existing);
      }
      if (broker.loseNextResponse) { broker.loseNextResponse = false; throw new Error("network timeout"); }
      return { brokerOrderId: existing.id };
    },
    async poll(order) {
      const resting = book.get(order.brokerOrderId);
      return { status: resting.status, filledQuantity: resting.filledQuantity, averageFillPrice: resting.averageFillPrice, commissionUsd: resting.commissionUsd };
    },
    async cancel(order) { broker.cancels.push(order.brokerOrderId); book.get(order.brokerOrderId).cancelRequested = true; },
    async sellableQuantity() { return 10_000; },
    async buyingPowerUsd() { return 50_000; },
    fill(predicate, quantity, price) {
      const order = [...book.values()].find(predicate);
      const filled = order.filledQuantity + quantity;
      order.averageFillPrice = ((order.averageFillPrice ?? 0) * order.filledQuantity + price * quantity) / filled;
      order.filledQuantity = filled;
      order.commissionUsd = Number((order.averageFillPrice * filled * 0.001).toFixed(6));
      if (filled >= order.request.quantity) order.status = "filled";
      return order;
    },
    confirmCancels() { for (const order of book.values()) if (order.cancelRequested && order.status === "working") order.status = "canceled"; },
    orders: () => [...book.values()],
  };
  return broker;
}

function strategy({ slot = "open", signalAt = "09:30", stopPct = 1, targetPct = null, symbol = "RKLB" } = {}) {
  const seen = [];
  return {
    seen,
    id: `rule-${slot}`, name: `규칙 ${slot}`, slot, summary: "", universe: [symbol], rules: [], evidence: "", cautions: [], warmupSessions: 0,
    scan: ({ asOf, window }) => {
      seen.push({ asOf, last: window[symbol].at(-1)?.time });
      return asOf === signalAt ? { symbol, stopPct, targetPct, reason: "테스트" } : null;
    },
  };
}

let ids = 0;
const nextId = () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, "0")}`;

function deps({ nowMs, broker, market, strategies }) {
  return { now: () => nowMs, id: nextId, strategies, broker, market, limitBandPct: 1 };
}

test("paper: a signal on a closed bar fills, the stop fires, and the trade is scored", async () => {
  const prices = { RKLB: 50 };
  const broker = createPaperBroker(async (symbol) => ({ price: prices[symbol], bid: null, ask: null }));
  const rule = strategy({ stopPct: 1 });
  const market = fakeMarket({ RKLB: dayBars(50) }, [{ symbol: "RKLB", atMs: at("09:37"), low: 49.4, high: 50 }]);
  let state = startDashboard(emptyDashboard("paper"), { now: () => at("09:20"), id: nextId });

  // 09:34:30 — the 09:30 bar is still forming; the rule must not be asked about it.
  state = await tickDashboard(state, deps({ nowMs: at("09:34", 30), broker, market, strategies: [rule] }));
  assert.equal(rule.seen.length, 0);

  // 09:35:05 — the 09:30 bar has closed: signal, and the paper fill at the quote.
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 5), broker, market, strategies: [rule] }));
  assert.deepEqual(rule.seen, [{ asOf: "09:30", last: "09:30" }]);
  const trade = state.trades[0];
  assert.equal(trade.status, "open");
  assert.equal(trade.boughtQuantity, Math.floor(1_000 / (50 * (1 + 0.138 / 100))));
  assert.ok(state.cashUsd < 1_000 - 50 * 19, "cash pays for the shares and the modelled cost");

  // 09:38 — a minute candle traded through the 1% stop (49.5); the paper sell fills at the current price.
  prices.RKLB = 49.45;
  state = await tickDashboard(state, deps({ nowMs: at("09:38"), broker, market, strategies: [rule] }));
  const closed = state.trades[0];
  assert.equal(closed.status, "closed");
  assert.equal(closed.exit, "stop");
  assert.ok(closed.pnlUsd < 0);
  assert.equal(closed.compliant, true, "0.1% past the stop is inside the execution tolerance");
  const summary = dashboardSummary(state);
  assert.equal(summary.adherencePct, 100);
  assert.ok(Math.abs(summary.totalPnlUsd - closed.pnlUsd) < 0.02, "the only P&L is the closed trade");
  assert.equal(state.daily.length, 1);
  assert.equal(state.daily[0].trades, 1);
  assert.equal(state.strategies[rule.id].signals, 1);
});

test("stop: cancel the unfilled buy, sell only what the dashboard bought, then confirm", async () => {
  const prices = { RKLB: 20 };
  const broker = fakeLiveBroker(prices);
  const rule = strategy({ stopPct: 5 });
  const market = fakeMarket({ RKLB: dayBars(20) });
  let state = startDashboard(emptyDashboard("live"), { now: () => at("09:20"), id: nextId });

  state = await tickDashboard(state, deps({ nowMs: at("09:35", 2), broker, market, strategies: [rule] }));
  const [buy] = broker.orders();
  assert.equal(buy.request.side, "buy");
  assert.equal(buy.request.limitPrice, 20.21, "a marketable limit one band above the ask");
  broker.fill((order) => order.id === buy.id, 10, 20.02);

  state = await tickDashboard(state, deps({ nowMs: at("09:35", 20), broker, market, strategies: [rule] }));
  assert.equal(heldQuantity(state.trades[0]), 10);
  assert.equal(state.orders.find((order) => order.side === "buy").status, "working", "the rest of the buy is still resting");

  state = requestStop(state, at("09:35", 25));
  assert.equal(state.stopPhase, "cancel_buys");

  // ① The buy is canceled first; nothing is sold while a buy could still fill.
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 30), broker, market, strategies: [rule] }));
  assert.deepEqual(broker.cancels, [buy.id]);
  assert.equal(broker.submits.filter((request) => request.side === "sell").length, 0);
  assert.equal(state.stopPhase, "cancel_buys");

  // ② Once the broker confirms the cancel, the ten filled shares — and only those — are sold.
  broker.confirmCancels();
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 45), broker, market, strategies: [rule] }));
  const sells = broker.submits.filter((request) => request.side === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0].quantity, 10);
  assert.equal(state.stopPhase, "confirm");
  assert.equal(state.status, "stopping", "a sent sell is not a filled sell");

  // ③ The sell fills; only then is the dashboard stopped.
  broker.fill((order) => order.request.side === "sell", 10, 20.1);
  state = await tickDashboard(state, deps({ nowMs: at("09:36"), broker, market, strategies: [rule] }));
  assert.equal(state.status, "stopped");
  assert.equal(state.trades[0].exit, "shutdown");
  assert.equal(heldQuantity(state.trades[0]), 0);
  const pnl = 10 * 20.1 - 10 * 20.02 - state.trades[0].commissionUsd;
  assert.ok(Math.abs(state.cashUsd - (1_000 + pnl)) < 1e-6);
  const phases = state.events.map((item) => item.message).filter((message) => /^[①②③]/.test(message));
  assert.equal(phases.length, 3);
});

test("stop with nothing open finishes in one tick", async () => {
  const broker = fakeLiveBroker({ RKLB: 20 });
  let state = startDashboard(emptyDashboard("live"), { now: () => at("09:20"), id: nextId });
  state = requestStop(state, at("09:21"));
  state = await tickDashboard(state, deps({ nowMs: at("09:21", 5), broker, market: fakeMarket({}), strategies: [] }));
  assert.equal(state.status, "stopped");
});

test("a submit whose answer was lost is re-sent with the same key, never doubled", async () => {
  const broker = fakeLiveBroker({ RKLB: 20 });
  broker.loseNextResponse = true;
  const rule = strategy();
  const market = fakeMarket({ RKLB: dayBars(20) });
  let state = startDashboard(emptyDashboard("live"), { now: () => at("09:20"), id: nextId });
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 2), broker, market, strategies: [rule] }));
  assert.equal(state.orders[0].status, "submitting");
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 20), broker, market, strategies: [rule] }));
  assert.equal(broker.submits.length, 2);
  assert.equal(broker.submits[0].clientOrderId, broker.submits[1].clientOrderId);
  assert.equal(broker.orders().length, 1, "the broker holds exactly one order");
  assert.equal(state.orders[0].status, "working");
  assert.ok(broker.submits[0].clientOrderId.length <= 36 && /^[A-Za-z0-9_-]+$/.test(broker.submits[0].clientOrderId));
});

test("a signal from a bar the runner slept through is recorded as missed, not chased", async () => {
  const broker = fakeLiveBroker({ RKLB: 20 });
  const rule = strategy({ signalAt: "09:30" });
  const market = fakeMarket({ RKLB: dayBars(20) });
  let state = startDashboard(emptyDashboard("live"), { now: () => at("09:20"), id: nextId });
  state = await tickDashboard(state, deps({ nowMs: at("09:52"), broker, market, strategies: [rule] }));
  assert.equal(broker.submits.length, 0);
  assert.equal(state.trades[0].status, "missed");
  assert.match(state.trades[0].violations[0], /다음 봉이 이미 지남/);
  assert.equal(dashboardSummary(state).missedSignals, 1);
});

test("an ambiguous order past the replay window remains active and blocks new orders and stop completion", async () => {
  const broker = fakeLiveBroker({ RKLB: 20 });
  broker.loseNextResponse = true;
  const rule = strategy(), laterRule = strategy({ slot: "trend", signalAt: "10:00" });
  const market = fakeMarket({ RKLB: dayBars(20) });
  let state = startDashboard(emptyDashboard("live"), { now: () => at("09:20"), id: nextId });
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 2), broker, market, strategies: [rule, laterRule] }));
  broker.fill(() => true, broker.orders()[0].request.quantity, 20);
  state = await tickDashboard(state, deps({ nowMs: at("10:05", 2), broker, market, strategies: [rule, laterRule] }));
  assert.equal(state.orders[0].status, "submitting");
  assert.match(state.orders[0].message, /계좌 대사/);
  assert.equal(state.trades[0].status, "entering");
  assert.equal(broker.submits.length, 1, "never resend past the broker deduplication window or place a new slot order");
  state = requestStop(state, at("10:06"));
  state = await tickDashboard(state, deps({ nowMs: at("10:06", 2), broker, market, strategies: [rule, laterRule] }));
  assert.equal(state.status, "stopping", "cannot claim stopped while a possibly filled order is unresolved");
  assert.equal(state.stopPhase, "cancel_buys");
});

test("an unfilled entry is canceled after a minute and counted as a missed signal", async () => {
  const broker = fakeLiveBroker({ RKLB: 20 });
  const rule = strategy();
  const market = fakeMarket({ RKLB: dayBars(20) });
  let state = startDashboard(emptyDashboard("live"), { now: () => at("09:20"), id: nextId });
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 2), broker, market, strategies: [rule] }));
  state = await tickDashboard(state, deps({ nowMs: at("09:36", 10), broker, market, strategies: [rule] }));
  assert.equal(broker.cancels.length, 1);
  broker.confirmCancels();
  state = await tickDashboard(state, deps({ nowMs: at("09:36", 25), broker, market, strategies: [rule] }));
  assert.equal(state.trades[0].status, "missed");
  assert.equal(state.strategies[rule.id].missed, 1);
});

test("a position still open at the slot's end is sold, and a late fill is flagged", async () => {
  const prices = { RKLB: 20 };
  const broker = fakeLiveBroker(prices);
  const rule = strategy({ stopPct: 5 });
  const market = fakeMarket({ RKLB: dayBars(20) });
  let state = startDashboard(emptyDashboard("live"), { now: () => at("09:20"), id: nextId });
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 2), broker, market, strategies: [rule] }));
  broker.fill((order) => order.request.side === "buy", 49, 20.3);
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 20), broker, market, strategies: [rule] }));

  state = await tickDashboard(state, deps({ nowMs: at("10:00", 3), broker, market, strategies: [rule] }));
  const sell = broker.submits.find((request) => request.side === "sell");
  assert.ok(sell, "the slot ended, so the balance is handed back");
  broker.fill((order) => order.request.side === "sell", 49, 20.0);
  state = await tickDashboard(state, deps({ nowMs: at("10:00", 20), broker, market, strategies: [rule] }));
  const trade = state.trades[0];
  assert.equal(trade.exit, "slot_end");
  assert.equal(trade.compliant, false, "filled 1.45% above the quote at the decision");
  assert.match(trade.violations.join(" "), /진입가 괴리/);
});

test("a broker refusal during the stop is retried a minute later, not every tick", async () => {
  const broker = fakeLiveBroker({ RKLB: 20 });
  const rule = strategy({ stopPct: 5 });
  const market = fakeMarket({ RKLB: dayBars(20) });
  let state = startDashboard(emptyDashboard("live"), { now: () => at("09:20"), id: nextId });
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 2), broker, market, strategies: [rule] }));
  broker.fill((order) => order.request.side === "buy", 49, 20.01);
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 10), broker, market, strategies: [rule] }));
  state = requestStop(state, at("09:35", 11));
  broker.rejectNext = "지금은 주문을 접수할 수 없는 시간입니다.";
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 15), broker, market, strategies: [rule] }));
  assert.equal(state.stopPhase, "liquidate");
  state = await tickDashboard(state, deps({ nowMs: at("09:35", 30), broker, market, strategies: [rule] }));
  assert.equal(broker.submits.filter((request) => request.side === "sell").length, 1, "no retry inside the minute");
  state = await tickDashboard(state, deps({ nowMs: at("09:36", 20), broker, market, strategies: [rule] }));
  assert.equal(broker.submits.filter((request) => request.side === "sell").length, 2);
  assert.equal(state.stopPhase, "confirm");
});

test("live bars: a forming bucket is never returned, and ranges ignore the straddling candle", () => {
  const start = at("09:30");
  const candles = Array.from({ length: 8 }, (_, index) => ({ endMs: start + (index + 1) * 60_000, open: 10 + index, high: 10.5 + index, low: 9.5 + index, close: 10.2 + index, volume: 100 }));
  const partway = aggregateFiveMinute(candles, start + 8 * 60_000 + 1_000);
  assert.equal(partway.length, 1, "09:35 bar has only three of five minutes");
  assert.deepEqual(partway[0], { date: DATE, time: "09:30", open: 10, high: 14.5, low: 9.5, close: 14.2, volume: 500 });
  assert.deepEqual(rangeAfter(candles, start + 90_000, start + 8 * 60_000), { low: 11.5, high: 17.5 });
});

test("adherence: a stop that ran past its level without firing is named", () => {
  const result = assessTrade({ stopPct: 1, targetPct: null, referenceEntryPrice: 100, entryPrice: 100, exitPrice: 97, exit: "slot_end", tolerancePct: 0.25 });
  assert.equal(result.compliant, false);
  assert.match(result.violations[0], /손절 미실행/);
});

test("live buying-power failure must not fall back to the dashboard's cash", async () => {
  const broker=fakeLiveBroker({RKLB:10});broker.buyingPowerUsd=async()=>{throw new Error("offline")};
  const state=startDashboard(emptyDashboard("live"),{now:()=>at("09:30"),id:nextId},"test");
  const next=await tickDashboard(state,{now:()=>at("09:35",1),id:nextId,strategies:[strategy()],broker,market:fakeMarket({RKLB:dayBars(10)}),limitBandPct:1});
  assert.equal(broker.submits.length,0);assert.equal(next.trades[0].status,"missed");assert.match(next.trades[0].violations.join(" "),/주문 가능 금액/);
});
test("an order intent is checkpointed before submit and a failed checkpoint prevents transmission", async () => {
  const broker=fakeLiveBroker({RKLB:10});let snapshot=null;
  const state=startDashboard(emptyDashboard("live"),{now:()=>at("09:30"),id:nextId},"test");
  const deps={now:()=>at("09:35",1),id:nextId,strategies:[strategy()],broker,market:fakeMarket({RKLB:dayBars(10)}),limitBandPct:1,checkpoint:async s=>{assert.equal(broker.submits.length,0);snapshot=structuredClone(s);}};
  await tickDashboard(state,deps);assert.equal(snapshot.orders[0].status,"submitting");assert.equal(snapshot.orders[0].clientOrderId,broker.submits[0].clientOrderId);
  broker.submits.length=0;deps.checkpoint=async()=>{throw new Error("storage offline")};
  await assert.rejects(()=>tickDashboard(state,deps),/storage offline/);assert.equal(broker.submits.length,0);
});
test("generated live rules refuse stale quotes and crossed books",async()=>{
 for(const invalid of ["old","crossed"]){
  const broker=fakeLiveBroker({RKLB:10});broker.entryProblem=async()=>null;
  broker.quote=async()=>({price:10,bid:10,ask:invalid==="crossed"?9:10.01,timestamp:new Date(at(invalid==="old"?"09:30":"09:35")).toISOString(),bookTimestamp:new Date(at("09:35")).toISOString()});
  const rule={...strategy(),execution:{participationPct:1,reservePct:1,maxDailyLossPct:3,maxEntryDriftPct:0.5,maxSpreadPct:0.2}};
  const state=startDashboard(emptyDashboard("live"),{now:()=>at("09:30"),id:nextId},"test");
  const next=await tickDashboard(state,{now:()=>at("09:35",1),id:nextId,strategies:[rule],broker,market:fakeMarket({RKLB:dayBars(10)}),limitBandPct:1});
  assert.equal(broker.submits.length,0);assert.equal(next.trades[0].status,"missed");
 }
});

test("paper fills respect the generated strategy's limit even when the next quote jumps",async()=>{
 const broker=createPaperBroker(async()=>({price:110,bid:109.99,ask:110.01}));
 await assert.rejects(()=>broker.submit({clientOrderId:"limit-test",symbol:"NVDA",side:"buy",quantity:9,referencePrice:100,limitPrice:100.5}),/지정가/);
});

/** Market data at any resolution: `bars[symbol]` are minutes, rolled up to the requested step. */
function minuteMarket(minutes) {
  const calls = [];
  return {
    calls,
    async sessionBars(symbol, date, nowMs, step = 5, from = "04:00") {
      calls.push({ symbol, step, from });
      const rolled = rollUpComplete(minutes[symbol] ?? [], step);
      return rolled.filter((bar) => bar.time >= from && easternWallTimeToEpoch(date, bar.time) + step * 60_000 <= nowMs);
    },
    async priorSessions() { return []; },
    async range() { return null; },
  };
}

function flatMinutes(price, from = "09:30", to = "11:00") {
  const bars = [];
  for (let minute = Number(from.slice(0, 2)) * 60 + Number(from.slice(3)); minute < Number(to.slice(0, 2)) * 60 + Number(to.slice(3)); minute += 1) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    bars.push({ date: DATE, time, open: price, high: price, low: price, close: price, volume: 1_000 });
  }
  return bars;
}

test("a one-minute rule is asked on one-minute bars, fills a minute later, and a late tick misses by one bar, not five", async () => {
  const prices = { RKLB: 50 };
  const broker = createPaperBroker(async (symbol) => ({ price: prices[symbol], bid: null, ask: null }));
  const market = minuteMarket({ RKLB: flatMinutes(50) });
  const seen = [];
  const rule = {
    id: "one-minute", name: "1분 규칙", slot: "open", barMinutes: 1, summary: "", universe: ["RKLB"], rules: [], evidence: "", cautions: [], warmupSessions: 0,
    scan: ({ asOf }) => { seen.push(asOf); return asOf === "09:33" ? { symbol: "RKLB", stopPct: 1, targetPct: null, reason: "1분봉" } : null; },
  };
  let state = startDashboard(emptyDashboard("paper"), { now: () => at("09:20"), id: nextId });
  state = await tickDashboard(state, deps({ nowMs: at("09:33", 30), broker, market, strategies: [rule] }));
  assert.deepEqual(seen, ["09:30", "09:31", "09:32"], "every closed minute, none still forming");
  assert.deepEqual([...new Set(market.calls.map((call) => call.step))], [1]);
  state = await tickDashboard(state, deps({ nowMs: at("09:34", 5), broker, market, strategies: [rule] }));
  const trade = state.trades[0];
  assert.equal(trade.signalTime, "09:33");
  assert.equal(trade.barMinutes, 1);
  assert.equal(trade.decidedAt, new Date(at("09:34")).toISOString(), "the decision exists when the one-minute bar closes");
  assert.equal(trade.status, "open");
  assert.equal(trade.slotEndsAt, new Date(at("10:00")).toISOString(), "a slot rule still exits at its slot's end");

  // The same rule on a tick that arrives two minutes late is a missed signal.
  const late = await tickDashboard(startDashboard(emptyDashboard("paper"), { now: () => at("09:20"), id: nextId }),
    deps({ nowMs: at("09:36", 5), broker, market, strategies: [{ ...rule, scan: ({ asOf }) => (asOf === "09:33" ? { symbol: "RKLB", stopPct: 1, targetPct: null, reason: "1분봉" } : null) }] }));
  assert.equal(late.trades[0].status, "missed");
  assert.match(late.trades[0].violations[0], /다음 봉이 이미 지남/);
});

test("a rule with its own window re-enters after its exit, skips bars it held through, and never repeats a name", async () => {
  const prices = { AAA: 20, BBB: 30 };
  const broker = createPaperBroker(async (symbol) => ({ price: prices[symbol], bid: null, ask: null }));
  const market = minuteMarket({ AAA: flatMinutes(20, "09:30", "12:00"), BBB: flatMinutes(30, "09:30", "12:00") });
  const asked = [];
  const rule = {
    id: "event-rule", name: "사건 규칙", slot: "open", barMinutes: 5, window: { from: "09:30", to: "15:55" },
    maxEntriesPerDay: 2, maxHoldMinutes: 15,
    summary: "", universe: ["AAA", "BBB"], rules: [], evidence: "", cautions: [], warmupSessions: 0,
    scan: ({ asOf, window }) => {
      asked.push({ asOf, symbols: Object.keys(window) });
      // Wants AAA whenever it may have it, BBB otherwise.
      return { symbol: "AAA" in window ? "AAA" : "BBB", stopPct: 5, targetPct: null, reason: "사건" };
    },
  };
  let state = startDashboard(emptyDashboard("paper"), { now: () => at("09:20"), id: nextId });
  const tick = async (time, seconds = 5) => { state = await tickDashboard(state, deps({ nowMs: at(time, seconds), broker, market, strategies: [rule] })); };

  await tick("09:35");
  assert.equal(state.trades[0].symbol, "AAA");
  assert.equal(state.trades[0].slotEndsAt, new Date(at("09:50")).toISOString(), "fill at 09:35 plus 15 minutes, not the window's end");
  assert.deepEqual(market.calls.map((call) => call.from), ["09:30", "09:30"], "no candles before the rule's window are fetched");

  // While AAA is held, the rule is not asked; those bars are skipped, not replayed later.
  await tick("09:40");
  await tick("09:45");
  assert.equal(asked.length, 1);
  await tick("09:50");
  assert.equal(state.trades[0].status, "closed");
  assert.equal(state.trades[0].exit, "slot_end");

  await tick("09:55");
  assert.deepEqual(asked.at(-1), { asOf: "09:50", symbols: ["BBB"] }, "the next decision is the first bar after the exit, and AAA is out of reach");
  assert.equal(state.trades[1].symbol, "BBB");
  assert.equal(state.slotProgress[`${DATE}:event-rule`].entries, 2);

  // Two entries used: the rule is done for the day.
  prices.BBB = 30;
  await tick("10:10");
  await tick("10:15");
  const before = asked.length;
  await tick("10:20");
  assert.equal(asked.length, before);
  assert.equal(state.trades.length, 2);
});

test("three-minute aggregation and execution exclude incomplete bars and exit on the last full bar", async () => {
  const start = at("09:30");
  const candles = Array.from({ length: 5 }, (_, i) => ({ endMs: start + (i + 1) * 60000, open: 20, high: 20, low: 20, close: 20, volume: 1000 }));
  assert.deepEqual(aggregateMinuteCandles(candles, at("09:35"), 3).map(b => b.time), ["09:30"]);
  assert.equal(aggregateMinuteCandles(candles.filter((_, i) => i !== 1), at("09:35"), 3).length, 0);
  const broker = createPaperBroker(async () => ({ price: 20, bid: null, ask: null }));
  const rule = { ...strategy({ signalAt: "15:30" }), barMinutes: 3, window: { from: "09:30", to: "15:55" } };
  const market = minuteMarket({ RKLB: flatMinutes(20, "09:30", "16:00") });
  let state = startDashboard(emptyDashboard("paper"), { now: () => at("15:30"), id: nextId });
  state = await tickDashboard(state, deps({ nowMs: at("15:33", 1), broker, market, strategies: [rule] }));
  assert.equal(state.trades[0].slotEndsAt, new Date(at("15:54")).toISOString());
  state = await tickDashboard(state, deps({ nowMs: at("15:54"), broker, market, strategies: [rule] }));
  assert.equal(state.trades[0].status, "closed");
});

test("a one-minute buy cannot remain working beyond its next-bar fill window", async () => {
  const broker = fakeLiveBroker({ RKLB: 50 });
  const rule = { ...strategy(), barMinutes: 1 };
  const market = minuteMarket({ RKLB: flatMinutes(50) });
  let state = startDashboard(emptyDashboard("live"), { now: () => at("09:30"), id: nextId });
  state = await tickDashboard(state, deps({ nowMs: at("09:31", 50), broker, market, strategies: [rule] }));
  assert.equal(broker.submits.length, 1);
  state = await tickDashboard(state, deps({ nowMs: at("09:32"), broker, market, strategies: [rule] }));
  assert.equal(broker.cancels.length, 1, "only ten seconds elapsed, but the intended fill bar ended");
  assert.equal(state.orders[0].status, "cancel_requested");
});

test("a slow buying-power request cannot turn an expired one-minute signal into a live order", async () => {
  let now = at("09:31", 30);
  const broker = fakeLiveBroker({ RKLB: 50 });
  broker.buyingPowerUsd = async () => { now = at("09:32"); return 1000; };
  const rule = { ...strategy(), barMinutes: 1 };
  const initial = startDashboard(emptyDashboard("live"), { now: () => at("09:30"), id: nextId });
  const state = await tickDashboard(initial, { ...deps({ nowMs: now, broker, market: minuteMarket({ RKLB: flatMinutes(50) }), strategies: [rule] }), now: () => now });
  assert.equal(broker.submits.length, 0);
  assert.equal(state.trades[0].status, "missed");
  assert.match(state.trades[0].violations[0], /진입 시간이 지남/);
});
