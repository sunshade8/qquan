import test from "node:test";
import assert from "node:assert/strict";
import { MASSIVE_AGGREGATE_INTERVALS, isRegularSession, parseMassiveAggregates } from "../lib/massive-shapes.ts";

test("app intervals map to Massive custom aggregate path parameters", () => {
  assert.deepEqual(MASSIVE_AGGREGATE_INTERVALS, {
    "1m": { multiplier: 1, timespan: "minute" },
    "5m": { multiplier: 5, timespan: "minute" },
    "15m": { multiplier: 15, timespan: "minute" },
    "60m": { multiplier: 60, timespan: "minute" },
  });
});

test("millisecond Massive aggregates are grouped by the New York trading date across DST", () => {
  const points = parseMassiveAggregates([
    { t: Date.parse("2026-01-05T14:30:00Z"), o: 100, h: 101, l: 99, c: 100.5, v: 10 },
    { t: Date.parse("2026-07-06T13:30:00Z"), o: 200, h: 201, l: 199, c: 200.5, v: 20 },
  ], "2026-01-01", "2026-12-31");
  assert.deepEqual(points.map((point) => [point.date, point.time]), [["2026-01-05", "09:30"], ["2026-07-06", "09:30"]]);
});

test("regular-session parsing removes extended hours and malformed OHLC", () => {
  const points = parseMassiveAggregates([
    { t: Date.parse("2026-07-06T12:00:00Z"), o: 99, h: 100, l: 98, c: 99.5, v: 5 },
    { t: Date.parse("2026-07-06T13:30:00Z"), o: 100, h: 101, l: 99, c: 100.5, v: 10 },
    { t: Date.parse("2026-07-06T13:35:00Z"), o: 100.5, h: undefined, l: 100, c: 101, v: 11 },
    { t: Date.parse("2026-07-06T20:00:00Z"), o: 101, h: 102, l: 100, c: 101.5, v: 12 },
  ], "2026-07-06", "2026-07-06", "regular");
  assert.equal(points.length, 1);
  assert.equal(points[0].time, "09:30");
  assert.equal(points[0].volume, 10);
  assert.equal(isRegularSession("15:59"), true);
  assert.equal(isRegularSession("16:00"), false);
});
