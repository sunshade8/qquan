import assert from "node:assert/strict";
import test from "node:test";
import { deterministicTestSummary } from "../lib/news-summary.ts";

const tests = [
  { id: "a", periodStart: "2026-01-05", periodEnd: "2026-01-13", overallScore: 40, techScore: 50, valueScore: 10, nasdaq: { returnPct: 1.2 }, nyse: { returnPct: 0.4 }, forecastEvents: [{ indicator: "미국 소비자물가지수 (CPI)", scheduledReleaseDate: "2026-01-13" }] },
  { id: "b", periodStart: "2026-02-05", periodEnd: "2026-02-13", overallScore: -30, techScore: -40, valueScore: -10, nasdaq: { returnPct: -0.8 }, nyse: { returnPct: -0.2 }, forecastEvents: [{ indicator: "미국 소비자물가지수 (CPI)", scheduledReleaseDate: "2026-02-13" }] },
  { id: "c", periodStart: "2026-03-04", periodEnd: "2026-03-11", overallScore: 20, techScore: 10, valueScore: 25, nasdaq: { returnPct: -0.5 }, nyse: { returnPct: 0.1 }, forecastEvents: [{ indicator: "미국 고용보고서 (NFP)", scheduledReleaseDate: "2026-03-06" }] },
  { id: "d", periodStart: "2026-04-01", periodEnd: "2026-04-10", overallScore: 10, techScore: 0, valueScore: 0, nasdaq: { unavailable: "no data" }, nyse: null, forecastEvents: [] },
];

test("summarises usable tests with alignment, correlation and per-event groups", () => {
  const summary = deterministicTestSummary(tests);
  assert.equal(summary.totalTests, 4);
  assert.equal(summary.usableTests, 3);
  assert.equal(summary.signAlignmentSampleSize, 3);
  assert.equal(Math.round(summary.signAlignmentRatePct), 67);
  assert.ok(summary.sentimentReturnCorrelation > 0.5);
  assert.deepEqual(summary.byEvent.map((group) => group.event).sort(), ["CPI", "NFP"]);
  assert.equal(summary.rows[0].eventRoot, "CPI");
});
