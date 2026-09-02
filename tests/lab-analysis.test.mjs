import assert from "node:assert/strict";
import test from "node:test";
import { compareAlignedSeries, findLargestDrawdowns, resolveAsset } from "../lib/lab-analysis.ts";

test("does not fabricate a public price series for SpaceX", () => {
  const asset = resolveAsset("SpaceX");
  assert.equal(asset.public, false);
  assert.equal(asset.symbol, null);
  assert.match(asset.note, /비상장/);
});

test("aligns common trading dates and quantifies both return and path similarity", () => {
  const left = [
    { date: "2026-01-02", close: 10 }, { date: "2026-01-05", close: 11 },
    { date: "2026-01-06", close: 10.5 }, { date: "2026-01-07", close: 12 },
  ];
  const right = [
    { date: "2026-01-02", close: 20 }, { date: "2026-01-05", close: 22 },
    { date: "2026-01-06", close: 21 }, { date: "2026-01-07", close: 24 },
  ];
  const result = compareAlignedSeries(left, right);
  assert.equal(result.sessions, 4);
  assert.equal(result.returnCorrelation, 1);
  assert.equal(result.pathCorrelation, 1);
  assert.deepEqual(result.points.map((point) => point.left), [100, 110, 105, 120]);
});

test("finds the most negative close-to-close sessions in order", () => {
  const rows = [
    { date: "2026-01-01", close: 100 }, { date: "2026-01-02", close: 90 },
    { date: "2026-01-03", close: 94.5 }, { date: "2026-01-04", close: 75.6 },
  ];
  const events = findLargestDrawdowns(rows, 2);
  assert.deepEqual(events.map((event) => event.date), ["2026-01-04", "2026-01-02"]);
  assert.equal(Number(events[0].returnPct.toFixed(1)), -20);
  assert.equal(Number(events[1].returnPct.toFixed(1)), -10);
});
