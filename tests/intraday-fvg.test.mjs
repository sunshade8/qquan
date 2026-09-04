import assert from "node:assert/strict";
import test from "node:test";
import { runFvgBacktest, scanSession } from "../lib/intraday-fvg.ts";

const DATE = "2026-08-05";

/** Builds a 5m regular-session series from 09:30 ET, one entry per bar. */
function session(bars, date = DATE) {
  return bars.map((bar, index) => {
    const minute = 9 * 60 + 30 + index * 5;
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    return { timestamp: 1_700_000_000 + index * 300, date, time, open: bar[0], high: bar[1], low: bar[2], close: bar[3], volume: 1000 };
  });
}

const options = { intervalMinutes: 5, anchorMinutes: 15, windowMinutes: 90, rewardRisk: 2, costBps: 0, holdUntil: "session_close" };

// Reference candle = bars 0-2 (09:30-09:45), so referenceHigh = 101, referenceLow = 99.
// Bar 3 is the displacement: a bullish body closing at 102.4, above 101.
// Bar 4's low (103) never reaches bar 2's high (101) -> bullish FVG [101, 103].
// The stop is bar 2's low (100), so risk = 3 and the 2R target is 109.
const setupBars = [
  [100, 101, 99, 100], [100, 101, 99.5, 100.5], [100.5, 101, 100, 100.5],
  [100.6, 102.5, 100.4, 102.4],
  [103, 105, 103, 104.5],
];

test("enters on the pullback into a confirmed gap, with the stop under the pre-displacement bar", () => {
  const bars = session([
    ...setupBars,
    [104, 104.2, 102.9, 103],   // bar 5: first touch of the gap top (103)
    [103, 109.5, 102.9, 109.4], // bar 6: runs to the 2R target
  ]);
  const { trade, miss } = scanSession(bars, DATE, "fvg_pullback", options);
  assert.equal(miss, null);
  assert.equal(trade.breakoutTime, "09:45");
  assert.equal(trade.fvgBottom, 101); // high of bar 2, the candle before the displacement
  assert.equal(trade.fvgTop, 103);
  assert.equal(trade.entryTime, "09:55"); // bar 5 = index+2; the 09:50 confirmation bar is skipped
  assert.equal(trade.entryPrice, 103);
  assert.equal(trade.stopPrice, 100); // low of bar 2, the candle before the displacement
  assert.equal(trade.targetPrice, 109); // 103 + 2 * 3
  assert.equal(trade.exitReason, "target");
  assert.equal(trade.rMultiple, 2);
});

test("never fills before the gap is confirmed by the following bar", () => {
  // The confirmation bar's own low *is* the top of the gap, so "price touched the
  // zone" is trivially true there. An engine that starts scanning at index+1
  // therefore fills every single setup. Entries must start at index+2.
  const bars = session([
    ...setupBars.slice(0, 4),
    [103, 105, 103, 104.5],
    [104.5, 104.6, 104.4, 104.5],
    [104.5, 104.6, 104.4, 104.5],
  ]);
  const { trade, miss } = scanSession(bars, DATE, "fvg_pullback", options);
  assert.equal(trade, null);
  assert.equal(miss.reason, "FVG 확정 후 되돌림이 오지 않음");
});

test("a bar covering both the stop and the target is scored as a stop", () => {
  const bars = session([
    ...setupBars,
    [104, 104.2, 102.9, 103],
    [103, 109.5, 99.0, 104], // spans both the stop (100) and the target (109)
  ]);
  const { trade } = scanSession(bars, DATE, "fvg_pullback", options);
  assert.equal(trade.exitReason, "stop");
  assert.equal(trade.rMultiple, -1);
});

test("no breakout inside the window is a miss, not a trade", () => {
  const flat = session(Array.from({ length: 30 }, () => [100, 100.5, 99.5, 100]));
  const { trade, miss } = scanSession(flat, DATE, "fvg_pullback", options);
  assert.equal(trade, null);
  assert.equal(miss.reason, "매매 창 안에 기준선 몸통 돌파 없음");
});

test("a breakout after the window closes is out of scope", () => {
  const bars = session([
    ...Array.from({ length: 20 }, () => [100, 101, 99, 100]),
    [100.6, 102.5, 100.4, 102.4], // 11:10 ET, past the 90-minute window
    [103, 105, 103, 104.5],
    [104, 104.2, 102.9, 103],
  ]);
  const { trade, miss } = scanSession(bars, DATE, "fvg_pullback", options);
  assert.equal(trade, null);
  assert.equal(miss.reason, "매매 창 안에 기준선 몸통 돌파 없음");
});

test("the control variant takes the same breakout without requiring a gap", () => {
  // Bar 4 overlaps bar 2's high, so there is no FVG — the rule stands down and
  // the control still trades. That difference is the whole point of the control.
  const bars = session([
    ...setupBars.slice(0, 4),
    [102.4, 103, 100.2, 102.8], // low 100.2 < bar 2 high 101 -> no gap
    [102.8, 110, 102.7, 109.9],
  ]);
  assert.equal(scanSession(bars, DATE, "fvg_pullback", options).miss.reason, "돌파와 함께 FVG가 형성되지 않음");
  const control = scanSession(bars, DATE, "breakout_close", options).trade;
  assert.equal(control.entryTime, "09:50");
  assert.equal(control.entryPrice, 102.8);
  assert.equal(control.fvgTop, null);
  assert.equal(control.stopPrice, 100);
});

test("round-trip cost is charged against the R multiple", () => {
  const bars = session([...setupBars, [104, 104.2, 102.9, 103], [103, 109.5, 102.9, 109.4]]);
  const free = scanSession(bars, DATE, "fvg_pullback", options).trade;
  const charged = scanSession(bars, DATE, "fvg_pullback", { ...options, costBps: 10 }).trade;
  assert.equal(free.rMultiple, 2);
  assert.ok(charged.rMultiple < free.rMultiple);
  assert.ok(charged.returnPct < free.returnPct);
});

test("summaries report the breakeven win rate and outlier dependence", () => {
  const winner = session([...setupBars, [104, 104.2, 102.9, 103], [103, 109.5, 102.9, 109.4]], "2026-08-05");
  const loser = session([...setupBars, [104, 104.2, 102.9, 103], [103, 103.5, 99.0, 99.2]], "2026-08-06");
  const result = runFvgBacktest("TEST", "Test", [...winner, ...loser], options);
  const rule = result.summaries.find((item) => item.variant === "fvg_pullback");
  assert.equal(rule.sessions, 2);
  assert.equal(rule.trades, 2);
  assert.equal(rule.wins, 1);
  assert.equal(rule.winRatePct, 50);
  assert.equal(rule.breakevenWinRatePct, 33.3);
  assert.equal(rule.totalR, 1);
  assert.equal(rule.totalRExcludingBest, -1); // the whole result is the one winner
});
