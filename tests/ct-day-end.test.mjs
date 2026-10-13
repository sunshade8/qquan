import test from "node:test";
import assert from "node:assert/strict";
import { emptyDashboard, startDashboard } from "../lib/trading-engine.ts";
import { tickCTDashboard } from "../lib/ct-trading-engine.ts";
import { ctHash, executableCT, CT_ENGINE, CT_ENGINE_V1 } from "../lib/ct-spec.ts";
import {
  replayCT,
  ctDayClosing,
  ctEntryBlocked,
  ctForcedExit,
  ctCryptoDayClosing,
  ctDayEndMs,
  ctSessionClosing,
} from "../lib/ct-engine.ts";
import { contractFor } from "./helpers/ct-golden-cases.mjs";

const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY0 = Date.UTC(2026, 0, 5);

/** Rising one-minute bars: the "prior high" condition below holds on every bar. */
function rising(from, to) {
  const out = [];
  for (let t = from; t < to; t += MIN) {
    const i = (t - DAY0) / MIN;
    const open = 100 + i * 0.001;
    out.push({ startMs: t, endMs: t + MIN, open, close: open + 0.001, high: open + 0.002, low: open - 0.001, volume: 100 });
  }
  return out;
}
const spec = (engine, over = {}) => ({
  version: 1,
  engine,
  name: "day end fixture",
  market: "crypto",
  symbols: ["BTCUSDT"],
  minutes: 1,
  stages: [{ label: "stage one", maxGapBars: 1, conditions: [{ feature: "prior_high_distance_pct", lookback: 3, offset: 0, timeframe: 1, op: "gte", value: -0.3 }] }],
  entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2, ...(over.entry ?? {}) },
  exit: { stopPct: 5, targetPct: 5, maxHoldBars: 390, invalidation: "stop", ...(over.exit ?? {}) },
  sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 1, participationPct: 1 },
  sourceIds: ["g"],
  assumptions: ["day end fixture"],
});
const contract = (engine) => ({ ...contractFor("crypto", DAY0, 4), engine });
const at = (day, h = 0, m = 0) => DAY0 + day * 86_400_000 + h * HOUR + m * MIN;

test("the day-closing rule: crypto closes on the 23:59 UTC bar for ct-pattern-2 only; stocks always at the session end", () => {
  assert.equal(ctCryptoDayClosing(at(0, 23, 58)), false);
  assert.equal(ctCryptoDayClosing(at(0, 23, 59)), true, "the bar that closes at 23:59 is the last tradable bar");
  assert.equal(ctCryptoDayClosing(at(1, 0, 0)), false, "00:00 belongs to the new day's first bar");
  assert.equal(ctDayClosing({ engine: CT_ENGINE }, "crypto", at(0, 23, 59)), true);
  assert.equal(ctDayClosing({ engine: CT_ENGINE_V1 }, "crypto", at(0, 23, 59)), false);
  // Stock closing is the historical ctSessionClosing, whatever the engine.
  const close = Date.parse("2025-11-26T20:59:00Z"); // 15:59 ET, regular close 16:00
  assert.equal(ctDayClosing({ engine: CT_ENGINE_V1 }, "stock", close), ctSessionClosing(close));
  assert.equal(ctDayClosing({ engine: CT_ENGINE }, "stock", close), true);
  const bar = { startMs: at(0, 23, 58), endMs: at(0, 23, 59), open: 1, high: 1, low: 1, close: 7, volume: 1 };
  assert.deepEqual(ctForcedExit({ engine: CT_ENGINE }, "crypto", bar), { price: 7, reason: "day_end" });
  assert.equal(ctForcedExit({ engine: CT_ENGINE_V1 }, "crypto", bar), null);
  assert.equal(ctDayEndMs("crypto", at(0, 12)), at(1, 0));
  assert.equal(ctDayEndMs("crypto", at(1, 0)), at(1, 0), "a bar closing at 00:00 still belongs to the day that just ended");
});

test("noEntryBeforeDayEndMinutes: entries stop that many minutes before the day ends; 0 changes nothing", () => {
  const base = { engine: CT_ENGINE, entry: {} };
  const guarded = { engine: CT_ENGINE, entry: { noEntryBeforeDayEndMinutes: 60 } };
  assert.equal(ctEntryBlocked(guarded, "crypto", at(0, 22, 59)), false);
  assert.equal(ctEntryBlocked(guarded, "crypto", at(0, 23, 0)), true);
  assert.equal(ctEntryBlocked(guarded, "crypto", at(1, 0, 30)), false);
  assert.equal(ctEntryBlocked(base, "crypto", at(0, 23, 0)), false);
  assert.equal(ctEntryBlocked(base, "crypto", at(0, 23, 59)), true, "the last bar never opens a position");
  assert.equal(ctEntryBlocked({ engine: CT_ENGINE_V1, entry: {} }, "crypto", at(0, 23, 59)), false);
  // Stocks: 30 minutes before the 16:00 ET close is 15:30 ET = 20:30Z in January? (EST) — use a winter date.
  const stock = { engine: CT_ENGINE, entry: { noEntryBeforeDayEndMinutes: 30 } };
  assert.equal(ctEntryBlocked(stock, "stock", Date.parse("2026-01-06T20:29:00Z")), false);
  assert.equal(ctEntryBlocked(stock, "stock", Date.parse("2026-01-06T20:30:00Z")), true);
  // The hash ignores an explicit 0.
  const a = spec(CT_ENGINE), b = spec(CT_ENGINE, { entry: { noEntryBeforeDayEndMinutes: 0 } });
  return Promise.all([ctHash(executableCT(a)), ctHash(executableCT(b))]).then(([x, y]) => assert.equal(x, y));
});

test("backtest: a ct-pattern-2 crypto position is closed at the UTC day end with reason day_end; ct-pattern-1 carries it over", () => {
  const data = rising(at(0, 22), at(2, 6));
  const run = (engine) => replayCT(spec(engine), { BTCUSDT: data }, contract(engine), at(0), at(3), "h");
  const v2 = run(CT_ENGINE),
    v1 = run(CT_ENGINE_V1);
  const first = v2.trades[0];
  assert.equal(first.reason, "day_end");
  assert.equal(first.exitAt, at(0, 23, 59), "exits on the bar closing 23:59 UTC");
  assert.ok(v2.trades.every((t) => Math.floor(t.entryAt / 86_400_000) === Math.floor((t.exitAt - 1) / 86_400_000)), "no v2 trade spans midnight");
  assert.ok(v2.trades.length >= 2 && v2.trades.slice(1).every((t) => t.entryAt >= at(1)), "the next entry is on the new day");
  // v1: no day end, the same position runs through midnight and ends on its own 390-bar clock.
  assert.ok(v1.trades[0].exitAt > at(1) && v1.trades[0].reason === "time");
});

test("backtest: noEntryBeforeDayEndMinutes keeps late-evening entries out", () => {
  // Every signal here fires after 22:40 — inside the last 90 minutes of the day.
  const data = rising(at(0, 22, 40), at(1, 6));
  const guarded = spec(CT_ENGINE, { entry: { noEntryBeforeDayEndMinutes: 90 } });
  const r = replayCT(guarded, { BTCUSDT: data }, contract(CT_ENGINE), at(0), at(2), "h");
  assert.ok(r.trades.length > 0);
  assert.ok(r.trades.every((t) => t.entryAt >= at(1)), "nothing opened before midnight");
  assert.ok(r.blocked && r.signals >= 0);
  const open = replayCT(spec(CT_ENGINE), { BTCUSDT: data }, contract(CT_ENGINE), at(0), at(2), "h");
  assert.ok(open.trades[0].entryAt < at(1), "without the guard the same data trades at 22:4x");
  assert.equal(open.trades[0].reason, "day_end");
});

/* The paper/live engine sells on the same rule. */
async function paper(engine) {
  const rule = spec(engine, { exit: { maxHoldBars: 390 } });
  const c = { ...contract(engine), symbols: ["BTCUSDT"], capital: 1000 };
  let now = at(0, 23, 30) + 1000,
    n = 0,
    saved;
  let state = startDashboard(emptyDashboard("paper"), { now: () => now, id: () => String(++n) });
  state.cashUsd = c.capital;
  state.initialCapitalUsd = c.capital;
  state.peakEquityUsd = c.capital;
  state.ctRules = [{ id: "ct1", spec: rule, hash: await ctHash(executableCT(rule)), contract: c }];
  state.strategyIds = ["ct1"];
  state.strategies = { ct1: { id: "ct1", name: rule.name, slot: "open", signals: 0, entries: 0, missed: 0, closed: 0, compliant: 0, deviations: 0, wins: 0, pnlUsd: 0, commissionUsd: 0 } };
  const rows = rising(at(0, 22), at(1, 1)),
    orders = new Map(),
    submitted = [];
  const last = () => rows.filter((b) => b.endMs <= now).at(-1);
  const broker = {
    mode: "paper",
    quote: async () => ({ price: last().close, bid: last().close - 0.001, ask: last().close + 0.001, timestamp: new Date(now).toISOString(), bookTimestamp: new Date(now).toISOString() }),
    buyingPowerUsd: async () => c.capital,
    sellableQuantity: async () => 1e9,
    submit: async (r) => {
      submitted.push(r);
      orders.set(r.clientOrderId, { id: "B" + submitted.length, status: "working", filledQuantity: 0, averageFillPrice: null, commissionUsd: 0 });
      return { brokerOrderId: "B" + submitted.length };
    },
    recover: async (o) => orders.get(o.clientOrderId)?.id ?? null,
    poll: async (o) => orders.get(o.clientOrderId),
    cancel: async () => {},
  };
  const deps = { now: () => now, id: () => String(++n), broker, bars: async () => rows.filter((b) => b.endMs <= now), entryAllowed: async () => true, checkpoint: async (s) => { saved = structuredClone(s); } };
  void saved;
  return {
    submitted,
    async tick() { state = await tickCTDashboard(state, deps); },
    fillBuy() {
      const o = orders.values().next().value, q = submitted[0].quantity;
      Object.assign(o, { status: "filled", filledQuantity: q, averageFillPrice: submitted[0].price ?? last().close, commissionUsd: 0 });
    },
    at(ms) { now = ms; },
  };
}

test("paper/live: the engine sells at the day end for ct-pattern-2 crypto and holds on for ct-pattern-1", async () => {
  for (const [engine, sells] of [[CT_ENGINE, true], [CT_ENGINE_V1, false]]) {
    const p = await paper(engine);
    await p.tick();
    assert.equal(p.submitted[0]?.side, "buy", `${engine} entered`);
    p.fillBuy();
    await p.tick();
    p.at(at(0, 23, 57) + 5000);
    await p.tick();
    assert.equal(p.submitted.filter((o) => o.side === "sell").length, 0, "still holding before the last bar");
    p.at(at(0, 23, 59) + 5000);
    await p.tick();
    assert.equal(p.submitted.some((o) => o.side === "sell"), sells, `${engine} day-end sell`);
  }
});
