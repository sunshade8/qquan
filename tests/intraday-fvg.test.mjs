import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionContexts, runFvgBacktest, scanSession } from "../lib/intraday-fvg.ts";

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

// --- session filters: gap and relative opening volume -----------------------

/** Same builder as above but with per-bar volume, for relative-volume tests. */
function volumeSession(bars, date, volume) {
  return session(bars, date).map((bar) => ({ ...bar, volume }));
}

const quietDay = [
  [100, 101, 99, 100], [100, 101, 99.5, 100.5], [100.5, 101, 100, 100.5],
  [100.6, 102.5, 100.4, 102.4], [103, 105, 103, 104.5],
  [104, 104.2, 102.9, 103], [103, 109.5, 102.9, 109.4],
];

test("gap and relative volume are computed from prior sessions only", () => {
  // Six sessions of 1000-volume bars, then one that opens 2% above the prior
  // close on 4x the volume. The baseline median can only exist by session 6.
  const days = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-10"]
    .map((date) => volumeSession(quietDay, date, 1000));
  // The quiet day closes at 109.4, so shifting the template by 11.6 opens the
  // next session at 111.6 — a 2.01% gap over that close.
  const gapUp = quietDay.map(([open, high, low, close]) => [open + 11.6, high + 11.6, low + 11.6, close + 11.6]);
  const points = [...days.flat(), ...volumeSession(gapUp, "2026-08-11", 4000)];

  const contexts = buildSessionContexts(points, options);
  assert.equal(contexts.length, 7);
  assert.equal(contexts[0].gapPct, null);            // nothing before it
  assert.equal(contexts[0].relativeVolume, null);    // no baseline yet
  assert.equal(contexts[4].relativeVolume, null);    // still short of 5 prior sessions
  assert.equal(contexts[5].relativeVolume, 1);       // baseline established, volume unchanged
  const last = contexts.at(-1);
  assert.ok(last.gapPct > 1.9 && last.gapPct < 2.2);  // 109.4 close -> 111.6 open
  assert.equal(last.relativeVolume, 4);
});

test("a filter blocks sessions before the baseline exists rather than admitting them", () => {
  const points = ["2026-08-03", "2026-08-04", "2026-08-05"].flatMap((date) => volumeSession(quietDay, date, 1000));
  const contexts = buildSessionContexts(points, { ...options, minRelativeVolume: 1.5 });
  assert.ok(contexts.every((context) => !context.passes));
  assert.ok(contexts.at(-1).blockedBy.includes("기준선 미확립"));
});

test("a gap across a data hole is not treated as a gap", () => {
  const points = [
    ...volumeSession(quietDay, "2026-08-03", 1000),
    ...volumeSession(quietDay, "2026-08-20", 1000), // 17 calendar days later
  ];
  const contexts = buildSessionContexts(points, options);
  assert.equal(contexts[1].gapPct, null);
  assert.equal(contexts[1].previousClose, null);
});

test("filtering scores only the passing sessions and still reports the unfiltered run", () => {
  const winner = session([...setupBars, [104, 104.2, 102.9, 103], [103, 109.5, 102.9, 109.4]], "2026-08-05");
  const loser = session([...setupBars, [104, 104.2, 102.9, 103], [103, 103.5, 99.0, 99.2]], "2026-08-06");
  const all = runFvgBacktest("TEST", "Test", [...winner, ...loser], options);
  assert.equal(all.unfilteredSummaries, null);
  assert.equal(all.filter.active, false);

  // A 50% gap threshold nothing can clear: the filtered run must be empty while
  // the unfiltered one is unchanged, which is what makes the two comparable.
  const filtered = runFvgBacktest("TEST", "Test", [...winner, ...loser], { ...options, minAbsGapPct: 50 });
  const rule = filtered.summaries.find((item) => item.variant === "fvg_pullback");
  assert.equal(filtered.filter.active, true);
  assert.equal(filtered.filter.sessionsPassed, 0);
  assert.equal(rule.trades, 0);
  assert.equal(rule.scope, "필터 적용");
  const unfiltered = filtered.unfilteredSummaries.find((item) => item.variant === "fvg_pullback");
  assert.equal(unfiltered.trades, 2);
  assert.equal(unfiltered.totalR, 1);
});

test("the day target is measured on excursion, and the stop bar's high does not count", () => {
  // The winner runs to 109.4 from an entry at 103, so its excursion is ~6.2%.
  const winner = session([...setupBars, [104, 104.2, 102.9, 103], [103, 109.5, 102.9, 109.4]], "2026-08-05");
  const won = runFvgBacktest("TEST", "Test", winner, { ...options, dayTargetPct: 2 })
    .trades.find((trade) => trade.variant === "fvg_pullback");
  assert.ok(won.maxFavorablePct > 6 && won.maxFavorablePct < 7);
  assert.equal(won.hitDayTarget, true);

  // This bar's high clears +2% from the entry but its low takes out the stop.
  // Crediting the high would invent an excursion the trade never got to take.
  const stopped = session([...setupBars, [104, 104.2, 102.9, 103], [103, 106, 99.0, 99.2]], "2026-08-06");
  const lost = runFvgBacktest("TEST", "Test", stopped, { ...options, dayTargetPct: 2 })
    .trades.find((trade) => trade.variant === "fvg_pullback");
  assert.equal(lost.exitReason, "stop");
  assert.equal(lost.hitDayTarget, false);
  assert.ok(lost.maxFavorablePct < 2);

  const summary = runFvgBacktest("TEST", "Test", [...winner, ...stopped], { ...options, dayTargetPct: 2 })
    .summaries.find((item) => item.variant === "fvg_pullback");
  assert.equal(summary.dayTargetHitRatePct, 50);
});
