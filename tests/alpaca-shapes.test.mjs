import test from "node:test";
import assert from "node:assert/strict";
import { ALPACA_TIMEFRAMES, isRegularSession, parseAlpacaBars } from "../lib/alpaca-shapes.ts";

test("the Python SDK interval names map to Alpaca REST timeframes", () => {
  assert.deepEqual(ALPACA_TIMEFRAMES, { "1m": "1Min", "5m": "5Min", "15m": "15Min", "60m": "1Hour" });
});

test("UTC Alpaca bars are grouped by the New York trading date across DST", () => {
  const points = parseAlpacaBars([
    { t: "2026-01-05T14:30:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 10 },
    { t: "2026-07-06T13:30:00Z", o: 200, h: 201, l: 199, c: 200.5, v: 20 },
  ], "2026-01-01", "2026-12-31");
  assert.deepEqual(points.map((point) => [point.date, point.time]), [["2026-01-05", "09:30"], ["2026-07-06", "09:30"]]);
});

test("regular-session parsing removes extended hours and malformed OHLC", () => {
  const points = parseAlpacaBars([
    { t: "2026-07-06T12:00:00Z", o: 99, h: 100, l: 98, c: 99.5, v: 5 },
    { t: "2026-07-06T13:30:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 10 },
    { t: "2026-07-06T13:35:00Z", o: 100.5, h: undefined, l: 100, c: 101, v: 11 },
    { t: "2026-07-06T20:00:00Z", o: 101, h: 102, l: 100, c: 101.5, v: 12 },
  ], "2026-07-06", "2026-07-06", "regular");
  assert.equal(points.length, 1);
  assert.equal(points[0].time, "09:30");
  assert.equal(points[0].volume, 10);
  assert.equal(isRegularSession("15:59"), true);
  assert.equal(isRegularSession("16:00"), false);
});
