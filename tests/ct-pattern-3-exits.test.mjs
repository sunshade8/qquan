import test from "node:test";
import assert from "node:assert/strict";
import {
  CT_ENGINE,
  CT_ENGINE_V2,
  ctHash,
  ctSpecSchema,
  executableCT,
  validateCTSpec,
} from "../lib/ct-spec.ts";
import {
  replayCT,
  ctExit,
  ctExitStep,
  ctOpenPosition,
  ctRebuildPosition,
  ctForcedExit,
  ctQuantity,
} from "../lib/ct-engine.ts";
import { ctQueryReturns, ctQuerySchema, ctQuerySpec } from "../lib/ct-design-tools.ts";
import { tickCTDashboard } from "../lib/ct-trading-engine.ts";
import { emptyDashboard, startDashboard } from "../lib/trading-engine.ts";
import { CT_EXIT_REASON_TEXT, ctTradeLevels, ctStopAt } from "../lib/ct-trade-levels.ts";
import { walk, rng, contractFor } from "./helpers/ct-golden-cases.mjs";

const MIN = 60_000,
  DAY = 86_400_000,
  DAY0 = Date.UTC(2026, 0, 5);

const managed = (over = {}) => ({ stop: { type: "pct", value: 1 }, maxHoldBars: 390, ...over });
const baseSpec = (exit, over = {}) =>
  ctSpecSchema.parse({
    version: 1,
    engine: CT_ENGINE,
    name: "exit fixture",
    market: "crypto",
    symbols: ["BTCUSDT"],
    minutes: 1,
    stages: [{ label: "stage one", maxGapBars: 1, conditions: [{ feature: "return_pct", lookback: 3, offset: 0, timeframe: 1, op: "gte", value: 0.25 }] }],
    entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
    exit,
    sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 120, participationPct: 1 },
    sourceIds: ["g"],
    assumptions: ["exit fixture"],
    ...over,
  });
const signal = (over = {}) => ({ symbol: "BTCUSDT", decidedAt: DAY0, validUntil: DAY0 + MIN, reference: 100, patternFrom: DAY0 - 3 * MIN, patternLow: 99.5, resistance: 101, support: 99, stages: [], swings: [], ...over });
let clock = DAY0;
const bar = (open, high, low, close) => {
  const b = { startMs: clock, endMs: clock + MIN, open, high, low, close, volume: 100 };
  clock += MIN;
  return b;
};
const freeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") freeze(v);
  return Object.freeze(o);
};

/* ----------------------------------------------------------------- opening */

test("opening a position: every stop type, an unusable stop is refused, the stop stress scales the distance", () => {
  const open = (exit, sig = signal(), entry = 100) => ctOpenPosition(baseSpec(exit), sig, entry, DAY0);
  const pct = open(managed({ target: { type: "r", value: 3 } }));
  assert.equal(pct.initialStop, 99);
  assert.equal(pct.initialRisk, 1);
  assert.equal(pct.targetLevel, 103, "R target = entry + 3 × initial risk");
  assert.equal(open(managed({ stop: { type: "atr", value: 2 }, target: { type: "atr", value: 4 } }), signal({ exitAtr: 0.5 })).initialStop, 99);
  assert.equal(open(managed({ stop: { type: "atr", value: 2 }, target: { type: "atr", value: 4 } }), signal({ exitAtr: 0.5 })).targetLevel, 102);
  assert.equal(open(managed({ stop: { type: "pattern_low", value: 0.1 } }), signal({ patternLow: 99.5 })).initialStop, 99.5 * 0.999);
  const swing = signal({ swings: [{ kind: "high", at: 1, confirmedAt: 2, price: 105 }, { kind: "low", at: 1, confirmedAt: 2, price: 98.7 }, { kind: "low", at: 3, confirmedAt: 4, price: 99.2 }] });
  assert.equal(open(managed({ stop: { type: "swing_low", value: 0 } }), swing).initialStop, 99.2, "the latest confirmed swing low");
  // unusable stops: no entry, never a guessed one
  assert.equal(open(managed({ stop: { type: "atr", value: 2 } }), signal()), null, "no ATR at the decision");
  assert.equal(open(managed({ stop: { type: "swing_low", value: 0 } }), signal()), null, "no confirmed swing low");
  assert.equal(open(managed({ stop: { type: "pattern_low", value: 0 } }), signal({ patternLow: 100.2 })), null, "the pattern low is above the entry: initial risk ≤ 0");
  assert.equal(open(managed({ stop: { type: "pattern_low", value: 0 } }), signal({ patternLow: 100 })), null, "initial risk 0");
  assert.equal(open(managed({ stop: { type: "pattern_low", value: 0 } }), signal({ patternLow: 80 })), null, "a stop 20% away is not a day-trading stop");
  assert.equal(open(managed({ stop: { type: "atr", value: 40 } }), signal({ exitAtr: 0.5 })), null, "ATR stop 20% away");
  // ±10% stress scales the INITIAL distance only
  const wide = ctOpenPosition(baseSpec(managed({ target: { type: "r", value: 3 } })), signal(), 100, DAY0, { stopScale: 1.1 });
  assert.ok(Math.abs(wide.initialStop - 98.9) < 1e-9);
  assert.ok(Math.abs(wide.targetLevel - (100 + 3 * 1.1)) < 1e-9, "an R target follows the (scaled) risk it is defined by");
  const narrow = ctOpenPosition(baseSpec(managed()), signal(), 100, DAY0, { stopScale: 0.9 });
  assert.ok(Math.abs(narrow.initialStop - 99.1) < 1e-9);
});

/* -------------------------------------------------------------- the stepper */

test("breakeven: +1R moves the stop to entry + offset from the NEXT bar; the same bar's low cannot hit the raised stop", () => {
  clock = DAY0;
  const spec = baseSpec(managed({ target: { type: "r", value: 3 }, breakeven: { triggerR: 1, offsetPct: 0.1 } }));
  let p = ctOpenPosition(spec, signal(), 100, DAY0);
  const b1 = bar(100, 100.5, 99.6, 100.2),
    b2 = bar(100.2, 101.2, 99.5, 101),
    b3 = bar(101, 101.1, 100.0, 100.5);
  let step = ctExitStep(spec, signal(), p, b1);
  assert.equal(step.exit, null);
  assert.equal(step.position.stopLevel, 99);
  assert.equal(step.position.highestHigh, 100.5);
  step = ctExitStep(spec, signal(), step.position, b2);
  assert.equal(step.exit, null, "bar 2's low 99.5 is under the NEW stop 100.1, but the new stop is not in force during bar 2");
  assert.ok(Math.abs(step.position.stopLevel - 100.1) < 1e-9);
  assert.equal(step.position.stopSource, "breakeven");
  assert.equal(step.position.moves.length, 1);
  assert.equal(step.position.moves[0].at, b2.endMs);
  step = ctExitStep(spec, signal(), step.position, b3);
  assert.equal(step.exit.reason, "breakeven");
  assert.ok(Math.abs(step.exit.price - 100.1) < 1e-9);
});

test("trail: arms at +activateR, follows the highest high, only ever rises, exits with reason trail", () => {
  clock = DAY0;
  const spec = baseSpec(managed({ trail: { type: "pct", value: 0.5, activateR: 2 } }));
  let p = ctOpenPosition(spec, signal(), 100, DAY0);
  const run = (b) => {
    const s = ctExitStep(spec, signal(), p, b);
    p = s.position;
    return s;
  };
  run(bar(100, 101, 99.9, 100.9));
  assert.equal(p.stopLevel, 99, "+1R: not armed yet");
  run(bar(100.9, 102.1, 100.8, 102));
  assert.ok(Math.abs(p.stopLevel - 102.1 * 0.995) < 1e-9, "+2.1R armed: trail from the high");
  assert.equal(p.stopSource, "trail");
  const level = p.stopLevel;
  run(bar(102, 101.9, 101.7, 101.8));
  assert.equal(p.stopLevel, level, "a lower high never loosens the trail");
  assert.equal(p.highestHigh, 102.1);
  run(bar(101.8, 103.5, 101.7, 103.4));
  assert.ok(Math.abs(p.stopLevel - 103.5 * 0.995) < 1e-9);
  const s = run(bar(103.4, 103.45, 102.5, 103));
  assert.equal(s.exit.reason, "trail");
  assert.ok(Math.abs(s.exit.price - 103.5 * 0.995) < 1e-9);
  assert.equal(p.moves.length, 2, "two trail raises were recorded, none for the lower high");
});

test("property: whatever the bars do, the stop never falls, the high never falls and every move is recorded in order", () => {
  const spec = baseSpec(managed({ target: { type: "r", value: 6 }, breakeven: { triggerR: 0.7, offsetPct: 0.05 }, trail: { type: "pct", value: 0.4, activateR: 1 }, timeStop: { bars: 40, minR: 0.2 } }));
  const r = rng(5);
  for (let trial = 0; trial < 200; trial++) {
    clock = DAY0;
    let price = 100;
    let p = ctOpenPosition(spec, signal(), price, DAY0);
    for (let i = 0; i < 80; i++) {
      const open = price,
        close = open * (1 + (r() - 0.46) * 0.004),
        b = bar(open, Math.max(open, close) * (1 + r() * 0.002), Math.min(open, close) * (1 - r() * 0.002), close);
      price = close;
      const s = ctExitStep(spec, signal(), p, b);
      assert.ok(s.position.stopLevel >= p.stopLevel, "stop never falls");
      assert.ok(s.position.highestHigh >= p.highestHigh);
      assert.equal(s.position.bars, p.bars + (s.exit ? 0 : 1));
      if (s.exit) break;
      p = s.position;
    }
    const levels = [p.initialStop, ...p.moves.map((m) => m.to)];
    assert.deepEqual(levels, [...levels].sort((a, b) => a - b), "moves are increasing");
    for (let i = 1; i < p.moves.length; i++) assert.ok(p.moves[i].at >= p.moves[i - 1].at, "breakeven and trail may move in the same bar, never backwards in time");
  }
});

test("the stop is judged first (a gap fills at the open), then the target; an ambiguous bar is a stop", () => {
  clock = DAY0;
  const spec = baseSpec(managed({ target: { type: "r", value: 3 } }));
  const p = ctOpenPosition(spec, signal(), 100, DAY0);
  const gap = ctExitStep(spec, signal(), p, bar(98, 98.5, 97.5, 98.2));
  assert.deepEqual(gap.exit, { price: 98, reason: "stop" }, "an adverse gap fills at the open, not at the stop");
  const up = ctExitStep(spec, signal(), p, bar(104, 105, 103.5, 104.5));
  assert.deepEqual(up.exit, { price: 104, reason: "target" }, "a gap through the target fills at the open");
  const both = ctExitStep(spec, signal(), p, bar(100, 103.5, 98.9, 101));
  assert.equal(both.exit.reason, "stop", "low under the stop and high over the target in one bar: stop first");
  const forcedWins = ctExitStep(spec, signal(), p, bar(100, 100.4, 98.9, 99.5), { price: 99.5, reason: "day_end" });
  assert.equal(forcedWins.exit.reason, "stop", "the stop is checked before the day-end exit");
  const forced = ctExitStep(spec, signal(), p, bar(100, 100.4, 99.5, 100.1), { price: 100.1, reason: "day_end" });
  assert.deepEqual(forced.exit, { price: 100.1, reason: "day_end" });
});

test("time stop: after N bars (the entry bar is the first) exit if the profit is under minR, once", () => {
  const spec = baseSpec(managed({ timeStop: { bars: 3, minR: 0.5 } }));
  for (const [close, exits] of [[100.2, true], [100.8, false]]) {
    clock = DAY0;
    let p = ctOpenPosition(spec, signal(), 100, DAY0);
    const s1 = ctExitStep(spec, signal(), p, bar(100, 100.3, 99.9, 100.1)),
      s2 = ctExitStep(spec, signal(), s1.position, bar(100.1, 100.3, 100, 100.15));
    assert.equal(s1.exit ?? s2.exit, null);
    const s3 = ctExitStep(spec, signal(), s2.position, bar(100.15, Math.max(100.3, close), 100, close));
    assert.equal(Boolean(s3.exit), exits);
    if (exits) assert.deepEqual(s3.exit, { price: close, reason: "time_stop" });
    else {
      // later bars are not judged against the time stop again
      const s4 = ctExitStep(spec, signal(), s3.position, bar(close, close + 0.1, close - 0.3, close - 0.2));
      assert.equal(s4.exit, null);
    }
  }
});

test("max hold: classic exits keep the reason \"time\", managed exits say max_hold", () => {
  clock = DAY0;
  const classic = baseSpec({ stopPct: 5, targetPct: 5, maxHoldBars: 2, invalidation: "stop" });
  const man = baseSpec(managed({ stop: { type: "pct", value: 5 }, maxHoldBars: 2 }));
  for (const [spec, reason] of [[classic, "time"], [man, "max_hold"]]) {
    clock = DAY0;
    const p = ctOpenPosition(spec, signal(), 100, DAY0);
    const a = ctExitStep(spec, signal(), p, bar(100, 100.1, 99.9, 100));
    const b = ctExitStep(spec, signal(), a.position, bar(100, 100.1, 99.9, 100.05));
    assert.equal(a.exit, null);
    assert.deepEqual(b.exit, { price: 100.05, reason });
  }
});

test("ATR stop, target and trail use the ATR measured at the decision; a swing-low trail follows the latest confirmed swing", () => {
  clock = DAY0;
  const spec = baseSpec(managed({ stop: { type: "atr", value: 2 }, target: { type: "atr", value: 6 }, trail: { type: "atr", value: 1, activateR: 1 } }));
  const sig = signal({ exitAtr: 0.5 });
  let p = ctOpenPosition(spec, sig, 100, DAY0);
  assert.equal(p.initialStop, 99);
  assert.equal(p.targetLevel, 103);
  p = ctExitStep(spec, sig, p, bar(100, 101.2, 99.9, 101)).position;
  assert.ok(Math.abs(p.stopLevel - (101.2 - 0.5)) < 1e-9, "trail = highest high − 1 ATR");

  clock = DAY0;
  const swing = baseSpec(managed({ trail: { type: "swing_low", value: 0, activateR: 0 } }));
  let q = ctOpenPosition(swing, signal(), 100, DAY0);
  const lows = [100.5, 100.3, 100.0, 100.4, 100.6];
  for (const [i, low] of lows.entries()) {
    const s = ctExitStep(swing, signal(), q, bar(101, 101.5, low, 101.2));
    q = s.position;
    if (i < 4) assert.equal(q.stopLevel, 99, "no swing yet: two bars after the low are still needed");
  }
  assert.equal(q.swingLow, 100.0);
  assert.equal(q.stopLevel, 100.0, "the trail sits on the confirmed swing low");
  assert.equal(q.stopSource, "trail");
});

test("ctExitStep is pure: the position it is given is not modified", () => {
  clock = DAY0;
  const spec = baseSpec(managed({ breakeven: { triggerR: 1 }, trail: { type: "pct", value: 0.5, activateR: 1 } }));
  const p = freeze(ctOpenPosition(spec, signal(), 100, DAY0));
  const before = JSON.stringify(p);
  const s = ctExitStep(spec, freeze(signal()), p, freeze(bar(100, 102, 99.9, 101.9)));
  assert.equal(JSON.stringify(p), before);
  assert.notEqual(s.position, p);
  assert.equal(s.position.moves.length >= 1, true);
});

test("classic exits: ctExitStep decides exactly like ctExit on random bars (stop, target, time, gap, day end)", () => {
  const r = rng(11);
  let compared = 0;
  for (let trial = 0; trial < 300; trial++) {
    const stopPct = 0.2 + r() * 2,
      targetPct = 0.2 + r() * 3,
      invalidation = r() < 0.3 ? "last_stage_low" : "stop";
    const spec = baseSpec({ stopPct, targetPct, maxHoldBars: 1 + Math.floor(r() * 30), invalidation }, { market: "crypto" });
    clock = DAY0;
    let price = 100;
    const entryAt = DAY0;
    const sig = signal({ patternLow: 99.2 + r() * 0.7 });
    let p = ctOpenPosition(spec, sig, price, entryAt);
    if (!p) continue;
    for (let i = 0; i < 60; i++) {
      const open = price * (1 + (r() - 0.5) * 0.004),
        close = open * (1 + (r() - 0.5) * 0.006),
        b = bar(open, Math.max(open, close) * (1 + r() * 0.003), Math.min(open, close) * (1 - r() * 0.003), close);
      price = close;
      const forced = r() < 0.03 ? ctForcedExit({ engine: CT_ENGINE_V2 }, "crypto", b) ?? { price: b.close, reason: "day_end" } : null;
      const legacy = ctExit(spec, sig, 100, entryAt, b) ?? forced;
      const step = ctExitStep(spec, sig, p, b, forced);
      assert.deepEqual(step.exit, legacy);
      compared++;
      if (legacy) break;
      p = step.position;
    }
  }
  assert.ok(compared > 2000);
});

test("sizing: a managed exit is sized from the actual stop distance; a classic exit from stopPct as always", () => {
  const classic = baseSpec({ stopPct: 1, targetPct: 2, maxHoldBars: 60, invalidation: "stop" });
  const contract = { ...contractFor("crypto", DAY0, 5), engine: CT_ENGINE, capital: 1000 };
  const q1 = ctQuantity(classic, contract, 1000, 1000, 100, 1e9);
  const wide = baseSpec(managed({ stop: { type: "pct", value: 2 } })),
    tight = baseSpec(managed({ stop: { type: "pct", value: 0.5 } }));
  const qWide = ctQuantity(wide, contract, 1000, 1000, 100, 1e9, 2),
    qTight = ctQuantity(tight, contract, 1000, 1000, 100, 1e9, 0.5);
  assert.ok(qTight >= qWide, "a tighter stop risks less per unit, so it can hold more (up to the allocation cap)");
  assert.equal(ctQuantity(wide, contract, 1000, 1000, 100, 1e9), 0, "a managed exit with no stop distance cannot be sized");
  assert.ok(q1 > 0);
});

/* ------------------------------------------------- one path through every engine */

/**
 * A market that signals once and then goes the way the managed exit was built for: up through
 * breakeven (+1R) and the trail arming (+2R), then a bar with a long lower wick that pierces
 * the trailing stop but closes above it.
 */
function trendingPath() {
  clock = DAY0;
  const rows = [];
  let price = 100;
  const push = (close, high = Math.max(price, close) + 0.05, low = Math.min(price, close) - 0.02) => {
    rows.push(bar(price, high, low, close));
    price = close;
  };
  for (let i = 0; i < 10; i++) push(100); // flat
  push(100.15);
  push(100.3); // 3-bar return 0.3% ≥ 0.25: the signal bar closes at 100.30, entry at the next open
  for (let i = 0; i < 12; i++) push(Number((100.3 + 0.2 * (i + 1)).toFixed(2))); // 100.5 … 102.7
  push(102.8, 103.0, 102.2); // long wick through the trail, closes above it
  for (let i = 0; i < 6; i++) push(Number((102.9 + 0.05 * i).toFixed(2)));
  return rows;
}
const identityContract = () => ({ ...contractFor("crypto", DAY0, 1), engine: CT_ENGINE, capital: 1000, costs: { feePct: 0.1, sellTaxPct: 0, spreadPct: 0, slippagePct: 0, minimumOrder: 5, quantityDecimals: 8 } });
const identitySpec = (exit) => baseSpec(exit);

async function paperRun(spec, rows, { stopAfter = Infinity, state: resume } = {}) {
  const c = identityContract();
  let n = 0,
    now = DAY0,
    state = resume ?? startDashboard(emptyDashboard("paper"), { now: () => now, id: () => String(++n) });
  if (!resume) {
    state.cashUsd = c.capital;
    state.initialCapitalUsd = c.capital;
    state.peakEquityUsd = c.capital;
    state.ctRules = [{ id: "ct1", spec, hash: await ctHash(executableCT(spec)), contract: c }];
    state.strategyIds = ["ct1"];
    state.strategies = { ct1: { id: "ct1", name: spec.name, slot: "open", signals: 0, entries: 0, missed: 0, closed: 0, compliant: 0, deviations: 0, wins: 0, pnlUsd: 0, commissionUsd: 0 } };
  }
  const orders = new Map(),
    submitted = [];
  for (const o of state.orders) orders.set(o.clientOrderId, { id: o.brokerOrderId, status: o.status, filledQuantity: o.filledQuantity, averageFillPrice: o.averageFillPrice, commissionUsd: o.commissionUsd });
  const last = () => rows.filter((b) => b.endMs <= now).at(-1);
  const broker = {
    mode: "paper",
    quote: async () => ({ price: last().close, bid: last().close, ask: last().close, timestamp: new Date(now).toISOString(), bookTimestamp: new Date(now).toISOString() }),
    buyingPowerUsd: async () => c.capital,
    sellableQuantity: async () => 1e9,
    submit: async (r) => {
      submitted.push({ ...r, at: now });
      orders.set(r.clientOrderId, { id: "B" + (submitted.length + state.orders.length), status: "working", filledQuantity: 0, averageFillPrice: null, commissionUsd: 0 });
      return { brokerOrderId: orders.get(r.clientOrderId).id };
    },
    recover: async (o) => orders.get(o.clientOrderId)?.id ?? null,
    poll: async (o) => orders.get(o.clientOrderId),
    cancel: async () => {},
  };
  const deps = { now: () => now, id: () => String(++n), broker, bars: async () => rows.filter((b) => b.endMs <= now), entryAllowed: async () => true, checkpoint: async () => {} };
  const trail = [];
  for (let k = 0; k < rows.length && k < stopAfter; k++) {
    now = rows[k].endMs + 1000;
    state = await tickCTDashboard(state, deps);
    // the harness fills what the engine sent, at the price the market is at (= the next bar's open)
    for (const r of submitted) {
      const o = orders.get(r.clientOrderId);
      if (o.status === "working") Object.assign(o, { status: "filled", filledQuantity: r.quantity, averageFillPrice: last().close, commissionUsd: 0 });
    }
    const t = state.trades[0];
    if (t?.ctPosition) trail.push({ at: rows[k].endMs, stop: t.ctPosition.stopLevel });
  }
  return { state, submitted, trail, trade: state.trades[0] };
}

test("one market, three judges: replayCT, the paper engine and a rebuild from the bars agree on the exit, its reason and every stop move", async () => {
  const rows = trendingPath();
  const spec = identitySpec(managed({ breakeven: { triggerR: 1, offsetPct: 0.1 }, trail: { type: "pct", value: 0.5, activateR: 2 } }));
  const contract = identityContract();
  const replay = replayCT(spec, { BTCUSDT: rows }, contract, DAY0, DAY0 + DAY, "h");
  assert.equal(replay.trades.length, 1);
  const rt = replay.trades[0];
  assert.equal(rt.reason, "trail", "the wick pierces the trailing stop");
  assert.ok(rt.management.moves.some((m) => m.source === "breakeven") && rt.management.moves.some((m) => m.source === "trail"));

  const live = await paperRun(spec, rows);
  const sell = live.submitted.find((o) => o.side === "sell");
  assert.ok(sell, "the paper engine sold");
  assert.equal(live.trade.ctExitReason, rt.reason);
  assert.equal(sell.at - 1000, rt.exitAt, "sold at the tick after the same bar closed");
  assert.ok(Math.abs(live.trade.ctPosition.stopLevel - rt.exit) < 0.011, `the exit price is the stop level in force (${live.trade.ctPosition.stopLevel} vs ${rt.exit})`);
  assert.equal(live.trade.ctPosition.moves.length, rt.management.moves.length);
  live.trade.ctPosition.moves.forEach((m, i) => {
    const e = rt.management.moves[i];
    assert.equal(m.at, e.at);
    assert.equal(m.source, e.source);
    assert.ok(Math.abs(m.to - e.to) < 1e-9 && Math.abs(m.from - e.from) < 1e-9);
  });
  assert.ok(Math.abs(live.trade.ctPosition.initialStop - rt.management.initialStop) < 1e-9);

  // a rebuild from nothing but the rule, the signal, the fill and the bars gives the same position
  const rebuilt = ctRebuildPosition(spec, rt.signal, rt.entry, rt.signal.decidedAt, rows.filter((b) => b.startMs >= rt.signal.decidedAt));
  assert.equal(rebuilt.exit.reason, rt.reason);
  assert.equal(rebuilt.exitBar.endMs, rt.exitAt);
  assert.deepEqual(rebuilt.position.moves.map((m) => [m.at, m.source]), rt.management.moves.map((m) => [m.at, m.source]));
});

test("a runner that restarts mid-trade continues from the stored state — or rebuilds it from the bars — to the same result", async () => {
  const rows = trendingPath();
  const spec = identitySpec(managed({ breakeven: { triggerR: 1, offsetPct: 0.1 }, trail: { type: "pct", value: 0.5, activateR: 2 } }));
  const whole = await paperRun(spec, rows);
  const cut = 26; // inside the trade, after breakeven armed and the trail started
  const first = await paperRun(spec, rows, { stopAfter: cut });
  assert.ok(first.trade.ctPosition.moves.length >= 2, "the state at the restart is not trivial");
  // the stored state goes through JSON, as the database does
  const stored = JSON.parse(JSON.stringify(first.state));
  const second = await paperRunFrom(spec, rows, stored, cut);
  assert.equal(second.trade.ctExitReason, whole.trade.ctExitReason);
  assert.deepEqual(second.trade.ctPosition, whole.trade.ctPosition);
  // dropping the stored position altogether: a rebuild from the bars lands on the same levels
  const dropped = JSON.parse(JSON.stringify(first.state));
  const gone = dropped.trades[0].ctPosition;
  const rebuilt = ctRebuildPosition(spec, dropped.trades[0].ctSignal, dropped.trades[0].entryPrice, dropped.trades[0].ctSignal.decidedAt, rows.filter((b) => b.startMs >= dropped.trades[0].ctSignal.decidedAt && b.endMs <= rows[cut - 1].endMs)).position;
  assert.deepEqual(rebuilt, gone, "incremental state == deterministic rebuild");
});
async function paperRunFrom(spec, rows, stored, from) {
  // Same loop as paperRun, starting at tick `from` with a stored state (a new process).
  const c = identityContract();
  let n = 1000,
    now = rows[from - 1].endMs + 1000,
    state = stored;
  const orders = new Map(),
    submitted = [];
  for (const o of state.orders) orders.set(o.clientOrderId, { id: o.brokerOrderId, status: o.status, filledQuantity: o.filledQuantity, averageFillPrice: o.averageFillPrice, commissionUsd: o.commissionUsd });
  const last = () => rows.filter((b) => b.endMs <= now).at(-1);
  const broker = {
    mode: "paper",
    quote: async () => ({ price: last().close, bid: last().close, ask: last().close, timestamp: new Date(now).toISOString(), bookTimestamp: new Date(now).toISOString() }),
    buyingPowerUsd: async () => c.capital,
    sellableQuantity: async () => 1e9,
    submit: async (r) => {
      submitted.push({ ...r, at: now });
      orders.set(r.clientOrderId, { id: "N" + submitted.length, status: "working", filledQuantity: 0, averageFillPrice: null, commissionUsd: 0 });
      return { brokerOrderId: orders.get(r.clientOrderId).id };
    },
    recover: async (o) => orders.get(o.clientOrderId)?.id ?? null,
    poll: async (o) => orders.get(o.clientOrderId),
    cancel: async () => {},
  };
  const deps = { now: () => now, id: () => String(++n), broker, bars: async () => rows.filter((b) => b.endMs <= now), entryAllowed: async () => true, checkpoint: async () => {} };
  for (let k = from; k < rows.length; k++) {
    now = rows[k].endMs + 1000;
    state = await tickCTDashboard(state, deps);
    for (const r of submitted) {
      const o = orders.get(r.clientOrderId);
      if (o.status === "working") Object.assign(o, { status: "filled", filledQuantity: r.quantity, averageFillPrice: last().close, commissionUsd: 0 });
    }
  }
  return { state, submitted, trade: state.trades[0] };
}

test("classic exits go through the same stepper in the paper engine: a target is a target, the position is stored too", async () => {
  const rows = trendingPath();
  const spec = identitySpec({ stopPct: 1, targetPct: 1.5, maxHoldBars: 120, invalidation: "stop" });
  const replay = replayCT(spec, { BTCUSDT: rows }, identityContract(), DAY0, DAY0 + DAY, "h");
  assert.equal(replay.trades[0].reason, "target");
  assert.equal(replay.trades[0].management, undefined, "classic trades gain no new fields");
  const live = await paperRun(spec, rows);
  assert.equal(live.trade.ctExitReason, "target");
  assert.equal(live.submitted.find((o) => o.side === "sell").at - 1000, replay.trades[0].exitAt);
  assert.equal(live.trade.ctPosition.targetLevel, live.trade.entryPrice * 1.015);
});

/* ------------------------------------------------------------ old specs stay */

test("old rules judge exactly as before: a classic rule on ct-pattern-2 and on ct-pattern-3 replays to the same trades", () => {
  const data = walk(91, DAY0, 4 * 1440, 100, 0.0012);
  const make = (engine, exit) =>
    ctSpecSchema.parse({
      version: 1,
      engine,
      name: "regression",
      market: "crypto",
      symbols: ["BTCUSDT"],
      minutes: 1,
      stages: [
        { label: "drop", maxGapBars: 3, conditions: [{ feature: "return_pct", lookback: 5, offset: 0, timeframe: 1, op: "lte", value: -0.12 }] },
        { label: "hourly", maxGapBars: 3, conditions: [{ feature: "sma_distance_pct", lookback: 5, offset: 0, timeframe: 60, op: "lte", value: 0.3 }] },
      ],
      entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2, noEntryBeforeDayEndMinutes: 20 },
      exit,
      sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 3, participationPct: 1 },
      sourceIds: ["g"],
      assumptions: ["regression"],
    });
  const contract = (engine) => ({ ...contractFor("crypto", DAY0, 4), engine });
  const reasons = new Set();
  for (const exit of [
    { stopPct: 0.5, targetPct: 0.6, maxHoldBars: 240, invalidation: "last_stage_low" },
    { stopPct: 4, targetPct: 6, maxHoldBars: 90, invalidation: "stop" },
    { stopPct: 4, targetPct: 6, maxHoldBars: 1440, invalidation: "stop" },
  ]) {
    const a = replayCT(make(CT_ENGINE_V2, exit), { BTCUSDT: data }, contract(CT_ENGINE_V2), DAY0, DAY0 + 4 * DAY, "h"),
      b = replayCT(make(CT_ENGINE, exit), { BTCUSDT: data }, contract(CT_ENGINE), DAY0, DAY0 + 4 * DAY, "h");
    assert.ok(a.trades.length > 3, "the fixture trades");
    const strip = (r) => JSON.stringify({ ...r, engine: undefined });
    assert.equal(strip(b), strip(a));
    assert.ok(a.trades.every((t) => t.management === undefined), "classic trades carry no new fields");
    a.trades.forEach((t) => reasons.add(t.reason));
  }
  for (const reason of ["stop", "target", "time", "day_end"]) assert.ok(reasons.has(reason), `the fixtures exercise ${reason}`);
});

test("a managed rule with no valid stop for a signal is skipped and counted, never traded with a guessed stop", () => {
  const data = walk(92, DAY0, 2 * 1440, 100, 0.0012);
  const spec = ctSpecSchema.parse({
    ...baseSpec(managed({ stop: { type: "swing_low", value: 0 } })),
    stages: [{ label: "drop", maxGapBars: 3, conditions: [{ feature: "return_pct", lookback: 5, offset: 0, timeframe: 1, op: "lte", value: -0.12 }] }],
    sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 3, participationPct: 1 },
  });
  const r = replayCT(spec, { BTCUSDT: data }, { ...contractFor("crypto", DAY0, 2), engine: CT_ENGINE }, DAY0, DAY0 + 2 * DAY, "h");
  assert.ok(r.signals > 0);
  assert.ok(r.trades.every((t) => t.management.initialRisk > 0 && t.management.initialStop < t.entry));
  assert.ok(r.trades.every((t) => (t.management.initialRisk / t.entry) * 100 <= 15));
});

test("stop sensitivity for a managed exit scales the initial distance in the replay and leaves the other numbers alone", () => {
  const data = walk(93, DAY0, 3 * 1440, 100, 0.0012);
  const spec = ctSpecSchema.parse({
    ...baseSpec(managed({ target: { type: "r", value: 1.5 }, breakeven: { triggerR: 1 }, maxHoldBars: 240 })),
    stages: [{ label: "drop", maxGapBars: 3, conditions: [{ feature: "return_pct", lookback: 5, offset: 0, timeframe: 1, op: "lte", value: -0.12 }] }],
    sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 3, participationPct: 1 },
  });
  const c = { ...contractFor("crypto", DAY0, 3), engine: CT_ENGINE };
  const base = replayCT(spec, { BTCUSDT: data }, c, DAY0, DAY0 + 3 * DAY, "h");
  const wide = replayCT(spec, { BTCUSDT: data }, c, DAY0, DAY0 + 3 * DAY, "h", { stopScale: 1.1 });
  const narrow = replayCT(spec, { BTCUSDT: data }, c, DAY0, DAY0 + 3 * DAY, "h", { stopScale: 0.9 });
  assert.ok(base.trades.length > 3 && wide.trades.length > 3 && narrow.trades.length > 3);
  const risk = (r) => r.trades.map((t) => t.management.initialRisk / t.entry);
  assert.ok(Math.abs(risk(wide)[0] / risk(base)[0] - 1.1) < 1e-6);
  assert.ok(Math.abs(risk(narrow)[0] / risk(base)[0] - 0.9) < 1e-6);
  assert.deepEqual(base.trades[0].management.moves.every((m) => m.source === "breakeven"), true);
});

/* ------------------------------------------------------------- design tools */

test("query_conditional_returns: entry windows restrict the events; exitCompare lays the structures side by side", () => {
  const days = 20;
  const data = walk(94, DAY0, days * 1440, 100, 0.0013);
  const contract = { ...contractFor("crypto", DAY0, Math.ceil(days / 0.6)), engine: CT_ENGINE, trainingToMs: DAY0 + days * DAY };
  const query = (extra = {}) =>
    ctQuerySchema.parse({
      stages: [{ maxGapBars: 3, conditions: [{ feature: "return_pct", lookback: 5, offset: 0, timeframe: 1, op: "lte", value: -0.15 }] }],
      horizons: [60, 240],
      grid: null,
      cooldownBars: 30,
      ...extra,
    });
  const free = ctQueryReturns(query(), { BTCUSDT: data }, contract);
  const windowed = ctQueryReturns(query({ entryWindows: [{ fromMinute: 0, toMinute: 360 }] }), { BTCUSDT: data }, contract);
  assert.ok(free.events > 20);
  assert.ok(windowed.events > 0 && windowed.events < free.events);
  const compare = ctQueryReturns(
    query({ exitCompare: { stopPcts: [0.5, 1], targetRs: [1.5, 3], breakevenTriggerR: 1, trail: { pct: 0.4, activateR: 1.5 }, timeStop: { bars: 30, minR: 0.3 } } }),
    { BTCUSDT: data },
    contract,
  );
  assert.equal(compare.exitCompare.length, 2 * (2 * 3 + 1), "per stop: 2 targets × (fixed, breakeven, time stop) + one trail");
  assert.deepEqual([...new Set(compare.exitCompare.map((r) => r.mode))].sort(), ["breakeven", "fixed", "time_stop", "trail"]);
  for (const row of compare.exitCompare) {
    assert.ok(row.events > 0 && row.events <= free.events);
    for (const key of ["winRatePct", "avgR", "netMeanPct", "netMean2xCostPct", "dailyNetPct"]) assert.ok(Number.isFinite(row[key]), `${row.label} ${key}`);
    assert.ok(Math.abs(Object.values(row.exits).reduce((s, v) => s + v, 0) - 100) < 0.2, "exit shares add up");
    assert.ok(row.netMean2xCostPct <= row.netMeanPct + 1e-9, "doubled costs never help");
  }
  const fixed = compare.exitCompare.find((r) => r.mode === "fixed");
  assert.ok(Object.keys(fixed.exits).every((k) => ["stop", "target", "max_hold", "day_end"].includes(k)));
  // size caps: the schema refuses a bigger grid than 3 stops × 2 targets
  assert.throws(() => query({ exitCompare: { stopPcts: [0.5, 1, 1.5, 2], targetRs: [2], breakevenTriggerR: null, trail: null, timeStop: null } }));
  assert.throws(() => query({ exitCompare: { stopPcts: [0.5], targetRs: [1, 2, 3], breakevenTriggerR: null, trail: null, timeStop: null } }));
  assert.throws(() => ctQueryReturns(query({ exitCompare: { stopPcts: [1], targetRs: [2], breakevenTriggerR: null, trail: null, timeStop: { bars: 240, minR: 0 } } }), { BTCUSDT: data }, contract), /timeStop/);
  // the old engine refuses the new fields instead of ignoring them
  assert.throws(() => ctQuerySpec(query({ entryWindows: [{ fromMinute: 0, toMinute: 60 }] }), { ...contract, engine: CT_ENGINE_V2 }), /entryWindows/);
  assert.throws(() => validateCTSpec(baseSpec(managed()), { ...contract, engine: CT_ENGINE_V2 }, ["g"]), /엔진/);
});

test("level features work through the design tool: a VWAP/previous-day query finds events and ATR-unit thresholds mean what they say", () => {
  const days = 16;
  const data = walk(95, DAY0, days * 1440, 100, 0.0013);
  const contract = { ...contractFor("crypto", DAY0, Math.ceil(days / 0.6)), engine: CT_ENGINE, trainingToMs: DAY0 + days * DAY };
  const q = (conditions) =>
    ctQuerySchema.parse({ stages: [{ maxGapBars: 3, conditions }], horizons: [60], grid: null, cooldownBars: 60 });
  const c = (over) => ({ feature: "vwap_distance_pct", lookback: 2, offset: 0, timeframe: 1, op: "lte", value: -0.2, ...over });
  const vwap = ctQueryReturns(q([c({})]), { BTCUSDT: data }, contract);
  assert.ok(vwap.events > 10, "below VWAP happens");
  const deeper = ctQueryReturns(q([c({ value: -0.6 })]), { BTCUSDT: data }, contract);
  assert.ok(deeper.events < vwap.events, "a deeper threshold is rarer");
  const atr = ctQueryReturns(q([c({ unit: "atr", atrTimeframe: 60, value: -1.5 })]), { BTCUSDT: data }, contract);
  assert.ok(atr.events >= 0 && atr.roundTripCostPct > 0);
  const prev = ctQueryReturns(q([c({ feature: "prev_day_low_distance_pct", op: "lte", value: 0.3 }), c({ feature: "vwap_distance_pct", value: -0.1 })]), { BTCUSDT: data }, contract);
  assert.ok(prev.events >= 0);
  assert.ok(prev.events <= ctQueryReturns(q([c({ value: -0.1 })]), { BTCUSDT: data }, contract).events, "the extra condition can only remove events");
});

test("the screens know every exit reason the engine can write, and a trade's stop path is readable from its record", () => {
  const reasons = new Set(["stop", "breakeven", "trail", "target", "time_stop", "max_hold", "time", "day_end", "session", "boundary", "invalid_stop"]);
  for (const r of reasons) assert.ok(CT_EXIT_REASON_TEXT[r], `Korean label for ${r}`);
  const spec = baseSpec(managed({ breakeven: { triggerR: 1 }, trail: { type: "pct", value: 0.5, activateR: 2 } }));
  const rows = trendingPath();
  const replay = replayCT(spec, { BTCUSDT: rows }, identityContract(), DAY0, DAY0 + DAY, "h");
  const t = replay.trades[0];
  const levels = ctTradeLevels(spec, t);
  assert.equal(levels.stop, t.management.initialStop);
  assert.equal(levels.moves.length, t.management.moves.length);
  assert.equal(ctStopAt(levels, levels.moves[0].at - 1), levels.stop, "before the first move the initial stop stands");
  assert.equal(ctStopAt(levels, levels.moves.at(-1).at), levels.moves.at(-1).to);
  const classic = baseSpec({ stopPct: 1, targetPct: 2, maxHoldBars: 60, invalidation: "stop" });
  const cl = ctTradeLevels(classic, { entry: 100, signal: signal(), management: undefined });
  assert.deepEqual(cl, { stop: 99, target: 102, moves: [] });
  assert.equal(ctTradeLevels(spec, { entry: 100, signal: signal(), management: undefined }), null, "a managed trade without its record has no levels to draw");
});
