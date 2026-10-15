import test from "node:test";
import assert from "node:assert/strict";
import { dayInfo, labelMoves, moveFeatures, walkForward } from "../lib/ct-moves.ts";
import { EXEC_REASON, fundingBetween, labelCostPct, labelExecution, markoutBp } from "../lib/ct-execution.ts";
import { walk } from "./helpers/ct-golden-cases.mjs";

const MIN = 60_000;
const DAY0 = Date.UTC(2026, 0, 5);
function flat(count, over = {}, start = DAY0) {
  return Array.from({ length: count }, (_, i) => ({
    startMs: start + i * MIN,
    endMs: start + (i + 1) * MIN,
    open: 100,
    high: 100.01,
    low: 99.99,
    close: 100,
    volume: 10,
    ...(over[i] ?? {}),
  }));
}
// Taker legs 0.4% + 0.1% impact → c = 1% (taker); maker 0.2% + 0.4% + 0.1% → c = 0.7% (maker).
const FEES = { makerFeePct: 0.2, takerFeePct: 0.4, impactPct: 0.1, k: 3, m: 1, holdBars: 60 };
const ex = (bars, o) => labelExecution(bars, dayInfo(bars, "crypto"), { side: 1, exec: "taker", ...FEES, ...o });

test("execution: taker long is labelMoves exactly (label, gross, exit, reason) and its net is gross − c", () => {
  const bars = walk(7, DAY0, 3 * 1440, 100, 0.002);
  const day = dayInfo(bars, "crypto");
  for (const holdBars of [60, 240, Infinity]) {
    const c = labelCostPct({ exec: "taker", ...FEES });
    const a = labelMoves(bars, day, { costPct: c, k: 3, m: 1, holdBars });
    const b = labelExecution(bars, day, { side: 1, exec: "taker", ...FEES, holdBars });
    assert.deepEqual(b.label, a.label);
    assert.deepEqual(b.grossPct, a.grossPct);
    assert.deepEqual(b.exitIndex, a.exitIndex);
    assert.deepEqual(b.reason, a.reason);
    for (let i = 0; i < bars.length; i++) {
      if (a.label[i] < 0) continue;
      assert.ok(Math.abs(b.netPct[i] - (a.grossPct[i] - c)) < 1e-6);
      assert.ok(Math.abs(b.net2Pct[i] - (a.grossPct[i] - 2 * c)) < 1e-6);
      assert.equal(b.filled[i], 1);
    }
  }
});

test("execution: walk-forward with explicit nets and one side equals the plain walk-forward", () => {
  const bars = walk(21, DAY0, 45 * 1440, 100, 0.0009);
  const day = dayInfo(bars, "crypto");
  const features = moveFeatures(bars, day, "crypto", "BTCUSDT");
  const c = labelCostPct({ exec: "taker", ...FEES, takerFeePct: 0.1, impactPct: 0.05 });
  const base = { bars, day, features, costPct: c, folds: 4, depth: 3, trainStride: 4 };
  const plain = walkForward({ ...base, labels: labelMoves(bars, day, { costPct: c, k: 3, m: 1, holdBars: Infinity }) });
  const exec = labelExecution(bars, day, { side: 1, exec: "taker", ...FEES, takerFeePct: 0.1, impactPct: 0.05, holdBars: Infinity });
  const viaSides = walkForward({ ...base, labels: exec, sides: [exec] });
  assert.deepEqual(viaSides.folds, plain.folds);
  assert.equal(viaSides.trades, plain.trades);
  assert.ok(Math.abs(viaSides.dailyMeanPct - plain.dailyMeanPct) < 1e-9);
  assert.ok(Math.abs(viaSides.dailyMean2xPct - plain.dailyMean2xPct) < 1e-6);
});

test("execution: short taker mirrors the long (target below, stop above, both in one bar = stop)", () => {
  // Short entry at bar 1's open 100, c = 1%: target 97, stop 101.
  const win = ex(flat(40, { 3: { low: 96.8 } }), { side: -1 });
  assert.equal(win.label[0], 1);
  assert.ok(Math.abs(win.grossPct[0] - 3) < 1e-5);
  const lose = ex(flat(40, { 3: { high: 101.2 }, 5: { low: 90 } }), { side: -1 });
  assert.equal(lose.label[0], 0);
  assert.ok(Math.abs(lose.grossPct[0] + 1) < 1e-5);
  const both = ex(flat(40, { 3: { high: 101.5, low: 96 } }), { side: -1 });
  assert.equal(both.reason[0], EXEC_REASON.stop);
  const gap = ex(flat(40, { 3: { open: 103, high: 103.5, low: 102.5, close: 103 } }), { side: -1 });
  assert.ok(Math.abs(gap.grossPct[0] + 3) < 1e-5, "an adverse gap fills at the open");
});

test("execution: the maker price uses bar i only, and the fill is decided by bar i+1 only", () => {
  // Decision bar 0 closes at 100; bar 1 must touch 100.
  const filled = ex(flat(40), { exec: "maker" });
  assert.equal(filled.filled[0], 1, "bar 1 low 99.99 ≤ 100");
  const missed = ex(flat(40, { 1: { open: 100.05, low: 100.02, high: 100.3, close: 100.2 } }), { exec: "maker" });
  assert.equal(missed.filled[0], 0);
  assert.equal(missed.netPct[0], 0);
  assert.equal(missed.label[0], 0, "an unfilled order is a valid row worth nothing");
  assert.equal(missed.exitIndex[0], 1, "it occupies the next bar only");
  assert.equal(missed.reason[0], EXEC_REASON.unfilled);
  // Rewriting everything after bar i+1 never changes whether row i filled.
  const bars = walk(3, DAY0, 2 * 1440, 100, 0.002);
  const a = ex(bars, { exec: "maker" });
  for (const i of [100, 700, 1500]) {
    const poisoned = bars.map((b, j) => (j > i + 1 ? { ...b, open: b.open * 1.3, high: b.high * 1.4, low: b.low * 0.6, close: b.close * 0.7 } : b));
    const b = ex(poisoned, { exec: "maker" });
    assert.equal(b.filled[i], a.filled[i], `row ${i}`);
    const touched = bars.map((x, j) => (j === i + 1 ? { ...x, low: bars[i].close * 1.001, open: bars[i].close * 1.002, high: Math.max(x.high, bars[i].close * 1.003), close: bars[i].close * 1.002 } : x));
    assert.equal(ex(touched, { exec: "maker" }).filled[i], 0, "bar i+1 alone decides");
  }
});

test("execution: a maker order never fills on an empty (zero-volume) minute; strict needs a trade-through", () => {
  const empty = ex(flat(40, { 1: { volume: 0, open: 100, high: 100, low: 100, close: 100 } }), { exec: "maker" });
  assert.equal(empty.filled[0], 0);
  const touch = flat(40, { 1: { low: 100, open: 100.01, high: 100.02, close: 100.01 } });
  assert.equal(ex(touch, { exec: "maker" }).filled[0], 1, "touch fills");
  assert.equal(ex(touch, { exec: "maker", strict: true }).filled[0], 0, "strict needs low < P");
});

test("execution: in the maker fill bar only the stop counts; the target is a maker leg filled exactly at the target", () => {
  // Maker c = 0.7%: entry 100 → stop 99.3, target 102.1.
  const sameBar = ex(flat(40, { 1: { high: 103, low: 99.95 } }), { exec: "maker" });
  assert.notEqual(sameBar.exitIndex[0], 1, "a target in the fill bar is not credited");
  const stopInFill = ex(flat(40, { 1: { low: 99.0 } }), { exec: "maker" });
  assert.equal(stopInFill.reason[0], EXEC_REASON.stop);
  assert.equal(stopInFill.exitIndex[0], 1);
  assert.ok(Math.abs(stopInFill.grossPct[0] + 0.7) < 1e-5, "filled at the stop, not the low");
  // Stop exit: maker entry 0.2 + taker 0.4 + impact 0.1.
  assert.ok(Math.abs(stopInFill.netPct[0] - (-0.7 - 0.7)) < 1e-5);
  const win = ex(flat(40, { 4: { open: 103, high: 104, low: 102.9, close: 103.5 } }), { exec: "maker" });
  assert.equal(win.reason[0], EXEC_REASON.target);
  assert.ok(Math.abs(win.grossPct[0] - 2.1) < 1e-5, "no gap improvement for a resting limit");
  assert.ok(Math.abs(win.netPct[0] - (2.1 - 0.4)) < 1e-5, "two maker legs");
  assert.ok(Math.abs(win.net2Pct[0] - (2.1 - 0.8)) < 1e-5);
});

test("execution: funding is charged only for settlements held between entry and exit, with the side's sign", () => {
  const f = { times: Float64Array.from([DAY0 + 5 * MIN, DAY0 + 30 * MIN, DAY0 + 200 * MIN]), rates: Float64Array.from([0.001, 0.002, 0.004]) };
  assert.equal(fundingBetween(f, DAY0, DAY0 + 5 * MIN), 0.001);
  assert.equal(fundingBetween(f, DAY0 + 5 * MIN, DAY0 + 29 * MIN), 0, "a settlement at the entry instant is not held");
  // Entry bar 1, time exit on bar 60 (hold 60): settlements at 5 and 30 minutes are held, 200 is not.
  const long = ex(flat(300), { funding: f });
  const short = ex(flat(300), { funding: f, side: -1 });
  assert.ok(Math.abs(long.fundingPct[0] + 0.3) < 1e-6, "longs pay a positive rate");
  assert.ok(Math.abs(short.fundingPct[0] - 0.3) < 1e-6, "shorts receive it");
  assert.equal(long.fundingPct[100], 0, "entered after 30m, out before 200m");
});

test("execution: two-sided walk-forward picks by training leaf means only — rewriting validation outcomes cannot change the picks", () => {
  const bars = walk(44, DAY0, 45 * 1440, 100, 0.0012);
  const day = dayInfo(bars, "crypto");
  const features = moveFeatures(bars, day, "crypto", "BTCUSDT");
  const o = { ...FEES, makerFeePct: 0.01, takerFeePct: 0.02, impactPct: 0, holdBars: 60 };
  const L = labelExecution(bars, day, { side: 1, exec: "maker", ...o }),
    S = labelExecution(bars, day, { side: -1, exec: "maker", ...o });
  const run = (l, s) => walkForward({ bars, day, labels: l, sides: [l, s], sideNames: ["L", "S"], features, costPct: 0, folds: 4, depth: 3, trainStride: 4 });
  const a = run(L, S);
  // Poison the nets of the last block's rows (validation of fold 3, never trained on): picks of every fold stay put.
  const keys = [...new Set(day.key)].sort((x, y) => x - y);
  const lastBlockFrom = keys[Math.floor((4 * keys.length) / 5)];
  const poison = (lab) => {
    const net = Float32Array.from(lab.netPct);
    for (let i = 0; i < net.length; i++) if (day.key[i] >= lastBlockFrom && Number.isFinite(net[i])) net[i] = net[i] * -50 + 7;
    return { ...lab, netPct: net };
  };
  const b = run(poison(L), poison(S));
  assert.deepEqual(b.signals.map((t) => [t.row, t.side]), a.signals.map((t) => [t.row, t.side]));
  assert.ok(a.signals.length > 0 || a.folds.every((f) => f.selectedLeaves.length === 0));
  for (const t of a.signals) assert.ok(t.side === 0 || t.side === 1);
  assert.ok(a.trades <= a.signals.length, "unfilled signals are not trades");
});

test("execution: a markout looks only h bars ahead inside the same unbroken day", () => {
  const bars = flat(40, { 6: { close: 101 } });
  const day = dayInfo(bars, "crypto");
  assert.ok(Math.abs(markoutBp(bars, day, 1, 1, 5) - 100) < 1e-9);
  assert.ok(Math.abs(markoutBp(bars, day, 1, -1, 5) + 100) < 1e-9);
  const holed = flat(40);
  holed.splice(4, 1);
  assert.ok(Number.isNaN(markoutBp(holed, dayInfo(holed, "crypto"), 1, 1, 5)));
});
