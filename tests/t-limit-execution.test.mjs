// T replica of tests/ct-limit-execution.test.mjs: T is a separate copy of CT (docs/t.md) and does not follow CT automatically.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// binance-api imports cloudflare:workers; the loader stubs it like the other CT tests.
register("./helpers/slot-test-loader.mjs", import.meta.url);
import {
  CT_LIMIT_DEFAULTS,
  ctForwardReturnPct,
  ctFreezeFees,
  ctLegCosts,
  ctScanEntry,
  ctSimulateStopExit,
  ctStopLimitPrice,
  ctThroughHit,
  ctTickRound,
} from "../lib/t-limit-execution.ts";
import { CT_COST_PROFILES, CT_COST_PROFILE_HISTORY, ctCostProfile, ctCostsRoundTripPct, ctExecutionNote, ctProfileCosts } from "../lib/t-costs.ts";
import { ctExitStep, ctNetTradePct, ctRoundTripCostPct, replayCT } from "../lib/t-engine.ts";
import { CT_ENGINE, CT_POLICY_V6 } from "../lib/t-spec.ts";
const { parseCommission } = await import("../lib/t-account-fees.ts");

const MIN = 60_000;
const DAY = 86_400_000;
const FROM = Date.UTC(2026, 5, 1);
const bar = (i, o, h, l, c, v = 50) => ({ startMs: FROM + i * MIN, endMs: FROM + (i + 1) * MIN, open: o, high: h, low: l, close: c, volume: v });
/** `plan` maps bar index → [open, high, low, close]; everything else is a flat 100 bar that never trades through a limit at 100. */
const bars = (n, plan = {}) => Array.from({ length: n }, (_, i) => (plan[i] ? bar(i, ...plan[i]) : bar(i, 100, 100.2, 100, 100)));
const policy = () => ctProfileCosts("crypto", ["BTCUSDT"], 1000).execution;

test("a touch is not a fill: the price must trade at least one tick THROUGH the limit", () => {
  const tick = 0.01;
  assert.equal(ctThroughHit("buy", 100, { low: 100, high: 101 }, tick, 1), false, "low == limit is a touch");
  assert.equal(ctThroughHit("buy", 100, { low: 99.99, high: 101 }, tick, 1), true, "one tick through");
  assert.equal(ctThroughHit("buy", 100, { low: 99.99, high: 101 }, tick, 0), true, "0 is read as 1: strictly through");
  assert.equal(ctThroughHit("buy", 100, { low: 99.99, high: 101 }, tick, 3), false, "three ticks asked for");
  assert.equal(ctThroughHit("buy", 100, { low: 99.97, high: 101 }, tick, 3), true);
  // Sell side is the mirror image.
  assert.equal(ctThroughHit("sell", 102, { low: 100, high: 102 }, tick, 1), false);
  assert.equal(ctThroughHit("sell", 102, { low: 100, high: 102.01 }, tick, 1), true);
});

test("buy limits round down and sell limits up to the tick", () => {
  assert.equal(ctTickRound(100.019, 0.01, "down"), 100.01);
  assert.equal(ctTickRound(100.011, 0.01, "up"), 100.02);
  assert.equal(ctTickRound(100.01, 0.01, "down"), 100.01, "already on the grid: unchanged, no float drift");
  assert.equal(ctTickRound(83000.1, 0.01, "up"), 83000.1);
});

test("entry scan: filled inside the lifetime, unfilled after it, gap when bars are missing", () => {
  const p = policy();
  assert.equal(p.entryTtlBars, CT_LIMIT_DEFAULTS.entryTtlBars);
  const rows = bars(10, { 3: [100, 100.2, 99.99, 100] });
  // Order placed at bar 1's close: bars 2..4 are inside a 3-bar life; bar 3 trades through 100.
  assert.deepEqual(ctScanEntry(rows, 1, 100, p, "BTCUSDT"), { kind: "filled", index: 3, price: 100 });
  // Placed at bar 3's close: bars 4..6 never trade through it.
  assert.deepEqual(ctScanEntry(rows, 3, 100, p, "BTCUSDT"), { kind: "unfilled" });
  // Placed at bar 0: the fill would be at bar 3, one past a 3-bar life? bars 1,2,3 → still inside.
  assert.equal(ctScanEntry(rows, 0, 100, p, "BTCUSDT").kind, "filled");
  const holed = rows.filter((_, i) => i !== 2);
  assert.equal(ctScanEntry(holed, 1, 100, p, "BTCUSDT").kind, "gap");
});

test("stop-limit: the limit sits slackPct beyond the stop, rounded down to a tick", () => {
  assert.equal(ctStopLimitPrice(99, CT_LIMIT_DEFAULTS.stop, 0.01), 98.9);
  assert.equal(ctStopLimitPrice(83000, { ...CT_LIMIT_DEFAULTS.stop, slackPct: 0.05 }, 0.01), 82958.5);
});

test("a stop that did not gap past its limit is marketable: it fills there as a taker", () => {
  const p = policy();
  const fill = ctSimulateStopExit({ rows: bars(5), triggerStartMs: FROM + 2 * MIN, triggerPrice: 99, stopLevel: 99, policy: p, symbol: "BTCUSDT" });
  assert.deepEqual(fill, { price: 99, leg: "taker", chases: 0, fillEndMs: FROM + 3 * MIN });
});

test("a gap past the stop-limit rests, is re-priced lower, and fills as a maker when the price comes back to it", () => {
  const p = policy();
  // Stop 99, limit 98.90. Bar 2 gaps open at 97 and stays below; bar 3 rebounds to 98.85: the 2nd window's limit is 98.80 → maker fill there.
  const rows = bars(12, { 2: [97, 97.5, 96, 96.5], 3: [96.5, 98.85, 96.5, 98], 4: [98, 98, 97, 97] });
  const fill = ctSimulateStopExit({ rows, triggerStartMs: FROM + 2 * MIN, triggerPrice: 97, stopLevel: 99, policy: p, symbol: "BTCUSDT" });
  assert.deepEqual(fill, { price: 98.8, leg: "maker", chases: 1, fillEndMs: FROM + 4 * MIN });
});

test("after the last re-price the one allowed market sell takes the next open; without it the chase just goes on", () => {
  const p = policy();
  const rows = bars(20, Object.fromEntries(Array.from({ length: 18 }, (_, k) => [2 + k, [96, 96.1, 95.9, 96]])));
  const fill = ctSimulateStopExit({ rows, triggerStartMs: FROM + 2 * MIN, triggerPrice: 96, stopLevel: 99, policy: p, symbol: "BTCUSDT" });
  assert.equal(fill.leg, "emergency");
  assert.equal(fill.chases, p.stop.maxChases);
  assert.equal(fill.price, 96);
  assert.equal(fill.fillEndMs, FROM + (2 + p.stop.maxChases + 2) * MIN, "the window after maxChases re-prices");
  // Emergency off: the limit keeps stepping down; at 98.9 × 0.999^k it never reaches 96 within 20 bars → no fill in the data.
  const off = { ...p, stop: { ...p.stop, emergencyMarket: false } };
  assert.equal(ctSimulateStopExit({ rows, triggerStartMs: FROM + 2 * MIN, triggerPrice: 96, stopLevel: 99, policy: off, symbol: "BTCUSDT" }), null);
  // Once a chased limit is at or below the market's open, it is marketable: a taker at that open.
  const high = bars(30, Object.fromEntries(Array.from({ length: 25 }, (_, k) => [2 + k, [98.7, 98.71, 98.5, 98.6]])));
  const taker = ctSimulateStopExit({ rows: high, triggerStartMs: FROM + 2 * MIN, triggerPrice: 98.7, stopLevel: 99, policy: off, symbol: "BTCUSDT" });
  assert.equal(taker.leg, "taker");
  assert.equal(taker.price, 98.7);
});

test("legs: maker fills pay the maker fee and no impact; taker and emergency legs pay the taker fee and the impact; the stress doubles both", () => {
  const p = { makerFeePct: 0.02, takerFeePct: 0.05 };
  assert.deepEqual(ctLegCosts("entry", p, 0.01), { feePct: 0.02, impactPct: 0 });
  assert.deepEqual(ctLegCosts("maker", p, 0.01), { feePct: 0.02, impactPct: 0 });
  assert.deepEqual(ctLegCosts("taker", p, 0.01), { feePct: 0.05, impactPct: 0.01 });
  assert.deepEqual(ctLegCosts("emergency", p, 0.01, 2), { feePct: 0.1, impactPct: 0.02 });
});

test("the fee frozen into a contract is max(official table, the account's own rate); a BNB discount is never assumed", () => {
  const official = { makerPct: 0.1, takerPct: 0.1, url: "u", checkedAt: "2026-10-17" };
  assert.deepEqual(ctFreezeFees(official, null), { makerFeePct: 0.1, takerFeePct: 0.1 });
  assert.deepEqual(ctFreezeFees(official, { makerPct: 0.075, takerPct: 0.075, readAt: "x", endpoint: "e" }), { makerFeePct: 0.1, takerFeePct: 0.1 }, "a lower account rate never lowers the frozen fee");
  assert.deepEqual(ctFreezeFees(official, { makerPct: 0.12, takerPct: 0.1, readAt: "x", endpoint: "e" }), { makerFeePct: 0.12, takerFeePct: 0.1 }, "a higher one raises it");
  const priced = ctProfileCosts("crypto", ["BTCUSDT"], 1000, undefined, { fees: { makerPct: 0.11, takerPct: 0.13, readAt: "2026-10-17T00:00:00Z", endpoint: "GET /api/v3/account/commission" }, note: null });
  assert.equal(priced.execution.makerFeePct, 0.11);
  assert.equal(priced.execution.takerFeePct, 0.13);
  assert.equal(priced.costs.feePct, 0.13, "costs.feePct is the taker fee");
  assert.equal(priced.execution.fees.official.makerPct, 0.1);
  assert.equal(priced.execution.fees.account.takerPct, 0.13, "both sources are recorded");
  assert.ok(priced.notes.some((n) => /더 높은 값을 동결/.test(n)));
  const unread = ctProfileCosts("crypto", ["BTCUSDT"], 1000, undefined, { fees: null, note: "Binance 자격증명 없음" });
  assert.equal(unread.execution.fees.account, null);
  assert.ok(unread.notes.some((n) => /공식 표만 동결/.test(n)));
});

test("account commission responses are parsed from their fixtures (spot standard+tax, futures maker/taker rates)", () => {
  const spot = parseCommission("spot", { standardCommission: { maker: "0.00100000", taker: "0.00100000" }, taxCommission: { maker: "0", taker: "0" }, discount: { enabledForAccount: true, enabledForSymbol: true, discountAsset: "BNB", discount: "0.75" } }, "t");
  assert.equal(spot.fees.makerPct, 0.1);
  assert.equal(spot.fees.takerPct, 0.1);
  assert.deepEqual(spot.discount, { enabledForAccount: true, enabledForSymbol: true }, "reported, never applied");
  const usdm = parseCommission("usdm", { symbol: "BTCUSDT", makerCommissionRate: "0.000200", takerCommissionRate: "0.000500" }, "t");
  assert.equal(usdm.fees.makerPct, 0.02);
  assert.equal(usdm.fees.takerPct, 0.05);
  assert.equal(parseCommission("usdm", {}, "t").fees, null);
});

test("cost profiles: spot v2 is limit-only, v1 stays reachable, USDⓈ-M v1 carries 0.02% / 0.05% and a source", () => {
  const v2 = CT_COST_PROFILES["binance-spot-usdt"];
  assert.equal(v2.version, 2);
  assert.ok(v2.execution);
  assert.equal(ctCostProfile("binance-spot-usdt", 1).execution, undefined, "the earlier version is unchanged");
  assert.ok(CT_COST_PROFILE_HISTORY.some((p) => p.id === "binance-spot-usdt" && p.version === 1));
  const um = CT_COST_PROFILES["binance-usdm"];
  assert.equal(um.execution.makerFeePct, 0.02);
  assert.equal(um.execution.takerFeePct, 0.05);
  assert.match(um.source.fee.url, /binance\.com/);
  assert.match(um.source.fee.checkedAt, /^2026-10-17$/);
  assert.throws(() => ctProfileCosts("crypto", ["BTCUSDT"], 1000, "binance-usdm"), /측정값/, "no futures book measured yet: it cannot price a contract");
  // Spot Regular has maker = taker: the note says so, plainly.
  assert.match(ctExecutionNote({ execution: policy() }), /수수료는 줄지 않고/);
  assert.doesNotMatch(ctExecutionNote({ execution: { ...policy(), makerFeePct: 0.02, takerFeePct: 0.05 } }), /수수료는 줄지 않고/);
});

/* ------------------------------------------------------------------ replayCT */

const priced = ctProfileCosts("crypto", ["BTCUSDT"], 1000);
const contract = (over = {}) => ({
  market: "crypto", symbols: ["BTCUSDT"], minutes: 1, fromMs: FROM, trainingToMs: FROM + DAY, developmentToMs: FROM + 2 * DAY, toMs: FROM + 3 * DAY,
  currency: "USDT", timezone: "UTC", capital: 1000, costs: priced.costs, costProfile: priced.costProfile, execution: priced.execution,
  policy: CT_POLICY_V6, engine: CT_ENGINE, createdAt: "2026-10-17T00:00:00Z", selection: "test", ...over,
});
const spec = (exit = {}) => ({
  version: 1, engine: CT_ENGINE, name: "always", market: "crypto", symbols: ["BTCUSDT"], minutes: 1,
  stages: [{ label: "always", maxGapBars: 1, conditions: [{ feature: "range_position", lookback: 3, offset: 0, timeframe: 1, op: "lte", value: 1 }] }],
  entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
  exit: { stopPct: 1, targetPct: 2, maxHoldBars: 5, invalidation: "stop", ...exit },
  sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 1, participationPct: 1 },
  sourceIds: ["x"], assumptions: ["probe"],
});
const withoutExecution = (c) => {
  const copy = { ...c };
  delete copy.execution;
  return copy;
};
const run = (rows, c = contract(), s = spec(), options = {}) => replayCT(s, { BTCUSDT: rows }, c, FROM, FROM + DAY, "h", options);
/** Bars where only bars 4+ matter: the always-on rule signals at bar 3 (its close = 100), the limit rests at 100 for bars 4..6. */
const probe = (plan) => bars(40, plan);

test("replay: a bar that trades through the limit fills it AT the limit (maker fee, no spread or impact), and the exit pays taker costs", () => {
  const dips = Object.fromEntries(Array.from({ length: 36 }, (_, k) => [4 + k, [100, 100.2, 99.9, 100]]));
  const r = run(probe(dips));
  assert.ok(r.trades.length > 3);
  const t = r.trades[0];
  assert.equal(t.entry, 100, "filled exactly at the limit");
  assert.equal(r.execution.fillRatePct, 100);
  const exitPrice = t.exit;
  assert.ok(exitPrice < 100 && exitPrice >= 99.98, "time exit: bar close less the per-side impact");
  const fee = (t.quantity * 100 * 0.1) / 100 + (t.quantity * exitPrice * 0.1) / 100;
  assert.ok(Math.abs(t.fees - fee) < 1e-9, "maker entry fee + taker exit fee");
  assert.ok(Math.abs(t.executionCost - t.quantity * (100 - exitPrice)) < 1e-9, "the entry has no impact; only the exit leg is charged");
  assert.equal(t.exitFill.leg, "marketable");
});

test("replay: touching the limit is not a fill — the signal is counted as unfilled, not as a trade", () => {
  const touches = Object.fromEntries(Array.from({ length: 36 }, (_, k) => [4 + k, [100, 100.2, 100, 100]]));
  const r = run(probe(touches));
  assert.equal(r.trades.length, 0);
  assert.ok(r.execution.unfilled > 5);
  assert.equal(r.execution.filled, 0);
  assert.equal(r.execution.fillRatePct, 0);
  assert.ok(r.blocked.unfilled > 5);
  assert.match(r.diagnostics.join(" "), /지정가 미체결/);
});

test("replay: the entry order lives entryTtlBars bars; a later dip does not fill it", () => {
  const p = priced.execution;
  const late = { 4: [100, 100.1, 100, 100], 5: [100, 100.1, 100, 100], 6: [100, 100.1, 100, 100], 7: [100, 100.2, 99.9, 100] };
  const r = run(bars(10, late), contract({ execution: { ...p, entryTtlBars: 3 } }));
  assert.equal(r.trades.filter((t) => t.signal.decidedAt === FROM + 4 * MIN).length, 0, "bar 7 is the 4th bar of the order placed at bar 3's close");
  const r4 = run(bars(10, late), contract({ execution: { ...p, entryTtlBars: 4 } }));
  assert.ok(r4.execution.filled >= 1);
});

test("replay: the target is a resting sell — filled at its own price with the maker fee, not in the bar the entry filled in, and only through the price", () => {
  // Signal at bar 3 (close 100). Bar 4 fills the entry AND spikes to 103: the target (102) must not count in the fill bar.
  // Bar 5 only touches 102.00; bar 6 trades through to 102.01 → target fills at 102.00.
  const plan = { 4: [100, 103, 99.9, 100.5], 5: [100.5, 102, 100.4, 101], 6: [101, 102.01, 100.9, 101], 7: [101, 101, 101, 101] };
  const r = run(bars(8, plan), contract(), spec({ maxHoldBars: 50 }));
  const t = r.trades[0];
  assert.equal(t.reason, "target");
  assert.equal(t.entry, 100);
  assert.equal(t.exit, 102, "the resting sell fills at its price, never a better open");
  assert.equal(t.exitAt, FROM + 7 * MIN, "bar 6 — not the fill bar and not the touch");
  assert.ok(Math.abs(t.fees - (t.quantity * 100 * 0.1 + t.quantity * 102 * 0.1) / 100) < 1e-9);
  assert.equal(t.executionCost, 0, "a maker-filled round trip pays no spread or impact");
  assert.equal(r.execution.exits.target, 1);
  // The same path in the earlier model would have sold in the fill bar at the open-or-target.
  const taker = withoutExecution(contract());
  const before = run(bars(8, plan), taker, spec({ maxHoldBars: 50 }));
  assert.notEqual(before.trades[0].exitAt, t.exitAt);
});

test("replay: a stop the market gapped past rests as a limit, is chased down, and the emergency market sell closes it; the position stays open meanwhile", () => {
  const down = Object.fromEntries(Array.from({ length: 34 }, (_, k) => [6 + k, [96, 96.1, 95.9, 96]]));
  const plan = { 4: [100, 100.2, 99.9, 100], 5: [97, 97.5, 96, 96], ...down };
  const rows = bars(40, plan);
  const r = run(rows, contract(), spec({ maxHoldBars: 200 }));
  const t = r.trades[0];
  assert.equal(t.reason, "stop");
  assert.equal(t.exitFill.leg, "emergency");
  assert.equal(t.exitFill.chases, priced.execution.stop.maxChases);
  assert.equal(r.execution.exits.emergency, 1);
  assert.ok(t.exit < 96 && t.exit > 95.9, "emergency market sell: the open less the measured impact");
  assert.ok(t.exitAt >= FROM + 9 * MIN, "closed only when the chase ended, not at the gap bar");
  assert.match(r.diagnostics.join(" "), /비상 시장가 청산 1건/);
  // With the emergency market off the loss has no cap: no fill within this data → the boundary closes it.
  const off = run(rows, contract({ execution: { ...priced.execution, stop: { ...priced.execution.stop, emergencyMarket: false } } }), spec({ maxHoldBars: 200 }));
  assert.notEqual(off.trades[0].exitFill.leg, "emergency", "no market order");
  assert.ok(off.trades[0].exitFill.chases > priced.execution.stop.maxChases, "the limit just keeps stepping down until the price comes to it");
  assert.equal(off.execution.exits.emergency, 0);
});

test("replay: a stop that did not gap is a marketable stop-limit — taker fee and impact at the stop level", () => {
  const plan = { 4: [100, 100.2, 99.9, 100], 5: [100, 100, 98.5, 98.6], 6: [98.6, 98.7, 98.5, 98.6] };
  const r = run(bars(10, plan), contract(), spec({ maxHoldBars: 50 }));
  const t = r.trades[0];
  assert.equal(t.reason, "stop");
  assert.equal(t.exitFill.leg, "marketable");
  assert.equal(t.exitFill.chases, 0);
  assert.ok(t.exit <= 99 && t.exit > 98.98);
  assert.equal(r.execution.exits.stopTaker, 1);
});

test("replay: the 2× stress doubles fees and impact and nothing else", () => {
  const dips = Object.fromEntries(Array.from({ length: 36 }, (_, k) => [4 + k, [100, 100.2, 99.9, 100]]));
  const one = run(probe(dips));
  const two = run(probe(dips), contract(), spec(), { costMultiplier: 2 });
  assert.equal(two.trades[0].entry, one.trades[0].entry);
  assert.ok(two.trades[0].fees > one.trades[0].fees * 1.99);
  assert.ok(two.netReturnPct < one.netReturnPct);
});

test("adverse selection: the report compares the later return of signals that filled with those that did not", () => {
  // Bars 4–15 fall steadily (every limit gets traded through, and the price then keeps falling); bars 16–39 rise with each
  // bar's low exactly at the previous close (every limit is only touched, and the price then keeps rising).
  const plan = {};
  let prev = 100;
  for (let i = 4; i < 40; i++) {
    const close = i < 16 ? prev - 0.3 : prev + 0.3;
    plan[i] = i < 16 ? [prev, prev + 0.05, close - 0.2, close] : [prev, close + 0.05, prev, close];
    prev = close;
  }
  const r = run(bars(40, plan));
  assert.ok(r.execution.filled > 0 && r.execution.unfilled > 0, JSON.stringify(r.execution));
  assert.equal(typeof r.execution.adverseSelectionPct, "number");
  assert.ok(r.execution.adverseSelectionPct < 0);
  assert.match(r.diagnostics.join(" "), /역선택/);
  assert.ok(Number.isNaN(ctForwardReturnPct(bars(5), 0, 100, 10)), "unreachable horizon is NaN");
});

test("a contract without an execution policy replays exactly as before (next open ± impact, taker fee)", () => {
  const taker = withoutExecution(contract());
  const flat = bars(40, Object.fromEntries(Array.from({ length: 36 }, (_, k) => [4 + k, [100, 100, 100, 100]])));
  const r = run(flat, taker);
  assert.ok(r.trades.length > 3, "a flat market fills at the next open in the earlier model");
  assert.equal(r.execution, undefined);
  assert.equal(r.trades[0].exitFill, undefined);
  assert.ok(Math.abs(ctNetTradePct(taker, 100, 100) + ctRoundTripCostPct(taker)) < 1e-12);
});

test("the screen formula equals the engine's: a limit contract costs maker entry + taker exit, without the entry's impact", () => {
  const c = contract();
  assert.ok(Math.abs(ctRoundTripCostPct(c) - ctCostsRoundTripPct(c.costs, 1, c.execution)) < 1e-12);
  const taker = withoutExecution(c);
  assert.ok(ctRoundTripCostPct(c) < ctRoundTripCostPct(taker), "removing the entry impact lowers the hurdle");
  assert.ok(ctRoundTripCostPct(c, 2) > ctRoundTripCostPct(c) * 1.99);
});

test("ctExitStep: without limit options it is the function it always was; with them a touch of the target does not exit", () => {
  const s = spec();
  const position = { entry: 100, entryAt: FROM + 4 * MIN, initialStop: 99, initialRisk: 1, stopLevel: 99, stopSource: "initial", targetLevel: 102, highestHigh: 100, breakevenArmed: false, trailArmed: false, bars: 0, lows: [], swingLow: null, moves: [] };
  const touch = bar(5, 101, 102, 100.5, 101);
  assert.equal(ctExitStep(s, {}, position, touch).exit.reason, "target");
  assert.equal(ctExitStep(s, {}, position, touch, null, { tick: 0.01, penetrationTicks: 1, fillBar: false }).exit, null);
  assert.equal(ctExitStep(s, {}, position, bar(5, 101, 102.01, 100.5, 101), null, { tick: 0.01, penetrationTicks: 1, fillBar: true }).exit, null, "not in the fill bar");
});
