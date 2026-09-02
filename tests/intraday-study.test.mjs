import assert from "node:assert/strict";
import test from "node:test";
import { calculateIntradayReaction, summarizeIntradayStudy } from "../lib/intraday-study.ts";

function point(time, close, index) {
  return { timestamp: 1_700_000_000 + index * 300, date: "2026-08-05", time, close };
}

test("uses the last completed bar at the event time and calculates exact 30-minute windows", () => {
  const points = [
    point("09:25", 99, 0), point("09:30", 100, 1), point("09:55", 102, 2),
    point("10:00", 103, 3), point("10:25", 106, 4), point("15:55", 108, 5),
  ];
  const reaction = calculateIntradayReaction(points, "2026-08-05", "10:00", 5, 30, 30);
  assert.ok(reaction);
  assert.equal(reaction.basePrice, 102);
  assert.equal(reaction.preReturnPct, 3.0303);
  assert.equal(reaction.postReturnPct, 3.9216);
  assert.equal(reaction.toRegularClosePct, 5.8824);
});

test("summarises each symbol overall and by surprise bucket", () => {
  const reaction = (postReturnPct) => ({ baseTime: "10:00", basePrice: 100, preTime: null, preReturnPct: null, postTime: "10:25+5m", postReturnPct, toRegularClosePct: postReturnPct, normalizedPath: [] });
  const summary = summarizeIntradayStudy([
    { symbol: "QQQ", surprise: "above", reaction: reaction(1) },
    { symbol: "QQQ", surprise: "above", reaction: reaction(-0.5) },
    { symbol: "IWD", surprise: "above", reaction: reaction(0.25) },
  ]);
  assert.deepEqual(summary.find((row) => row.symbol === "QQQ" && row.surprise === "all"), {
    symbol: "QQQ", surprise: "all", samples: 2, preAveragePct: null, preMedianPct: null,
    postAveragePct: 0.25, postMedianPct: 0.25, postPositiveRatePct: 50, toCloseAveragePct: 0.25,
  });
});
