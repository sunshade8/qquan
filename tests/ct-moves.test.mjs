import test from "node:test";
import assert from "node:assert/strict";
import { dayInfo, labelMoves, moveFeatures, walkForward, MOVE_FEATURES, MOVE_REASON } from "../lib/ct-moves.ts";
import { ctFeature } from "../lib/ct-engine.ts";
import { walk } from "./helpers/ct-golden-cases.mjs";

const MIN = 60_000;
const DAY0 = Date.UTC(2026, 0, 5);
/** Flat 100 bars, minute by minute, then overrides by index. */
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
const label = (bars, o, market = "crypto") => labelMoves(bars, dayInfo(bars, market), { costPct: 1, k: 3, m: 1, holdBars: 60, ...o });

test("label: target first is positive, stop first is not, and both in one bar is stop first", () => {
  // Entry at bar 1's open (100); stop 99, target 103 (cost 1%, k=3, m=1).
  const up = label(flat(40, { 3: { high: 103.5 } }));
  assert.equal(up.label[0], 1);
  assert.equal(up.reason[0], MOVE_REASON.target);
  assert.ok(Math.abs(up.grossPct[0] - 3) < 1e-6, "filled at the target price");
  assert.equal(up.exitIndex[0], 3);

  const down = label(flat(40, { 3: { low: 98.9 }, 5: { high: 104 } }));
  assert.equal(down.label[0], 0);
  assert.equal(down.reason[0], MOVE_REASON.stop);
  assert.ok(Math.abs(down.grossPct[0] + 1) < 1e-6);

  const both = label(flat(40, { 3: { low: 98.5, high: 104 } }));
  assert.equal(both.label[0], 0, "same bar touching both counts as the stop");
  assert.equal(both.reason[0], MOVE_REASON.stop);

  const early = label(flat(40, { 2: { high: 103.2 }, 4: { low: 98 } }));
  assert.equal(early.label[0], 1, "the earlier touch decides");
});

test("label: an adverse gap through the stop fills at the open, a gap above the target at the open", () => {
  const gapDown = label(flat(40, { 3: { open: 97, high: 97.5, low: 96.5, close: 97 } }));
  assert.equal(gapDown.label[0], 0);
  assert.ok(Math.abs(gapDown.grossPct[0] + 3) < 1e-6, "worse than the stop: fills at the gap open");
  const gapUp = label(flat(40, { 3: { open: 104, high: 105, low: 103.9, close: 104 } }));
  assert.equal(gapUp.label[0], 1);
  assert.ok(Math.abs(gapUp.grossPct[0] - 4) < 1e-6);
});

test("label: the holding cap is a time exit at that bar's close", () => {
  const rows = flat(40, { 5: { close: 100.4, high: 100.5 } });
  const r = label(rows, { holdBars: 5 });
  // entry bar 1, holds bars 1..5, closes on bar 5.
  assert.equal(r.reason[0], MOVE_REASON.time);
  assert.equal(r.exitIndex[0], 5);
  assert.ok(Math.abs(r.grossPct[0] - 0.4) < 1e-6);
  // A target after the cap is never reached.
  const late = label(flat(40, { 9: { high: 110 } }), { holdBars: 5 });
  assert.equal(late.label[0], 0);
});

test("label: a trade never crosses the UTC day: the target that only exists after midnight does not count", () => {
  const dayStart = DAY0;
  const n = 1440 + 30;
  const rows = flat(n, { [1442]: { high: 120 } }, dayStart);
  const r = label(rows, { holdBars: Infinity });
  const entryBar = 1400; // signal bar; entry on 1401
  assert.equal(r.label[entryBar], 0, "the +20% bar is tomorrow's");
  assert.equal(r.reason[entryBar], MOVE_REASON.day_end);
  // Day's final tradable bar is the one closing at 23:59 (index 1438): exit there, at its close.
  assert.equal(r.exitIndex[entryBar], 1438);
  // The signal closing at 23:58 still enters on the 23:58 bar (a one-bar trade, like the stock 15:58 case);
  // a signal closing at 23:59 or later has no tradable bar left in the day.
  assert.equal(r.label[1437], 0);
  assert.equal(r.exitIndex[1437], 1438);
  assert.equal(r.label[1438], -1);
  assert.equal(r.label[1439], -1);
  // Tomorrow's own entries exist again.
  assert.ok(r.label[1440] >= 0);
});

test("label: missing minutes and the stock session edges are not entries", () => {
  const rows = flat(40);
  rows.splice(10, 1);
  const r = label(rows, { holdBars: Infinity });
  assert.equal(r.label[8], -1, "signal bar followed by a hole");
  assert.equal(r.label[9], -1);
  assert.equal(r.label[0], -1, "a hole inside the holding window makes the sample invalid, not optimistic");
});

test("features: the 1-minute and hourly columns equal the engine's ctFeature", () => {
  const bars = walk(5, DAY0, 6 * 1440, 100, 0.0008);
  const day = dayInfo(bars, "crypto");
  const table = moveFeatures(bars, day, "crypto", "BTCUSDT");
  assert.equal(table.names.length, 31);
  for (const t of [3000, 5000, 7777]) {
    MOVE_FEATURES.forEach((feature, f) => {
      const m1 = ctFeature({ feature, lookback: 30, offset: 0, timeframe: 1, op: "gte", value: 0 }, bars.slice(Math.max(0, t - 200), t + 1), bars[t].endMs);
      const col = table.cols[f][t];
      assert.ok((m1 === null) === Number.isNaN(col), `m1 ${feature} ${t}`);
      if (m1 !== null) assert.ok(Math.abs(m1 - col) <= 1e-3 * Math.max(1, Math.abs(m1)), `m1 ${feature}: ${m1} vs ${col}`);
      const h1 = ctFeature({ feature, lookback: 24, offset: 0, timeframe: 60, op: "gte", value: 0 }, bars, bars[t].endMs, { market: "crypto", symbol: "BTCUSDT" });
      const hc = table.cols[10 + f][t];
      assert.ok((h1 === null) === Number.isNaN(hc), `h1 ${feature} ${t}`);
      if (h1 !== null) assert.ok(Math.abs(h1 - hc) <= 1e-3 * Math.max(1, Math.abs(h1)), `h1 ${feature}: ${h1} vs ${hc}`);
    });
  }
});

function wfInput(bars, costPct = 0.31) {
  const day = dayInfo(bars, "crypto");
  const features = moveFeatures(bars, day, "crypto", "BTCUSDT");
  const labels = labelMoves(bars, day, { costPct, k: 3, m: 1, holdBars: Infinity });
  return { bars, day, labels, features, costPct, folds: 4, depth: 3, trainStride: 4 };
}

test("walk-forward: nothing after a fold's validation block can change what that fold learned or traded", () => {
  const a = walk(21, DAY0, 45 * 1440, 100, 0.0009);
  // Poison the last block (days 36+). Folds 0..2 validate on blocks 1..3 and may not notice.
  const cut = DAY0 + 38 * 86_400_000;
  const b = a.map((x) => (x.startMs >= cut ? { ...x, open: x.open * 1.5, high: x.high * 1.7, low: x.low * 0.6, close: x.close * 1.4 } : x));
  const ra = walkForward(wfInput(a)),
    rb = walkForward(wfInput(b));
  for (const f of [0, 1, 2]) assert.deepEqual(rb.folds[f], ra.folds[f], `fold ${f}`);
});

test("walk-forward: the training seam is purged and training never sees its own validation block", () => {
  const a = walk(33, DAY0, 45 * 1440, 100, 0.0009);
  const info = dayInfo(a, "crypto");
  const days = [...new Set(info.key)].sort((x, y) => x - y);
  // Fold 0 validates on block 1 (days 9..17 of 45). Poison only that block's prices.
  const from = DAY0 + 9 * 86_400_000,
    to = DAY0 + 18 * 86_400_000;
  const b = a.map((x) => (x.startMs >= from && x.startMs < to ? { ...x, high: x.high * 1.3, low: x.low * 0.8 } : x));
  const ra = walkForward(wfInput(a)),
    rb = walkForward(wfInput(b));
  assert.equal(days.length, 45);
  assert.equal(rb.folds[0].trainRows, ra.folds[0].trainRows);
  assert.equal(rb.folds[0].bestTrainLeafNetPct, ra.folds[0].bestTrainLeafNetPct);
  assert.deepEqual(rb.folds[0].selectedLeaves, ra.folds[0].selectedLeaves);
  assert.ok(ra.folds.length >= 4, "at least four folds");
});

test("walk-forward: pure noise has no after-cost edge (daily mean not positive by construction of costs)", () => {
  const a = walk(44, DAY0, 45 * 1440, 100, 0.0009);
  const r = walkForward(wfInput(a));
  assert.ok(r.dailyMeanPct <= 0.02, `noise should not earn: ${r.dailyMeanPct}`);
  assert.ok(r.validationDays > 20);
});
