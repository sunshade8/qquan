import test from "node:test";
import assert from "node:assert/strict";
import { createSurgeResearchSummary, summarizeSurgeResearch } from "../lib/surge-research.ts";

const date = "2026-09-16";
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
function session({ observedAt = "10:02", firstPrice = 11, laterPrice = 12, symbol = "AAA" } = {}) {
  const start = Number(observedAt.slice(0, 2)) * 60 + Number(observedAt.slice(3));
  const bars = [];
  for (let minute = start; minute < 955; minute++) {
    const price = minute < start + 15 ? firstPrice : laterPrice;
    bars.push({ date, time: clock(minute), open: price, high: price, low: price, close: price, volume: 10000 });
  }
  return { date, candidates: [{ symbol, rankedOn: date, observedAt, observedPrice: 10, changePct: 20, prevClose: 8.3333, dollarVolume: 2e6, volume: 200000, rank: 1 }], bars: { [symbol]: bars } };
}

test("same-day paths start at the exact observed minute, including off-five-minute events", () => {
  const result = summarizeSurgeResearch([session()], 1000);
  assert.equal(result.analysisBarInterval, "1m");
  assert.equal(result.afterObservation.forwardReturnPct["+5m"].median, 10);
  assert.equal(result.afterObservation.forwardReturnPct["+30m"].median, 20);
  assert.equal(result.afterObservation.toFlatAt1555Pct.median, 20);
});

test("first-15m setup groups use only the observable prefix and rebase later outcomes", () => {
  const winning = summarizeSurgeResearch([session()], 1000);
  const losing = summarizeSurgeResearch([session({ laterPrice: 8 })], 1000);
  const group = result => result.afterSimilarFirst15m.groups.find(g => g.shape === "first15m_up");
  assert.equal(group(winning).events, 1);
  assert.equal(group(losing).events, 1, "future losses must not relabel an upward first 15m");
  assert.equal(group(winning).forwardReturnPct["+15m"].median, 9.091, "12 / 11, not 12 / 10");
  assert.equal(group(losing).forwardReturnPct["+15m"].median, -27.273);
  assert.equal(winning.afterSimilarFirst15m.decisionAvailableAfterMinutes, 15);
});

test("missing exact horizon, incomplete first 15m and an incomplete hour stay missing", () => {
  const data = session();
  data.bars.AAA = data.bars.AAA.filter(bar => bar.time !== "10:06");
  const result = summarizeSurgeResearch([data], 1000);
  assert.equal(result.afterObservation.forwardReturnPct["+5m"].samples, 0);
  assert.equal(result.afterObservation.forwardReturnPct["+15m"].samples, 1);
  assert.ok(result.afterSimilarFirst15m.groups.every(group => group.events === 0));
  assert.equal(result.afterObservation.maxFavourable60mPct.samples, 0);
  assert.equal(result.afterObservation.firstTouchWithin60m["±3%"].missing, 1);
});

test("neither the next session nor a previous-day event enters today's path statistics", () => {
  const data = session({ observedAt: "15:51" });
  data.bars.AAA.push({ date: "2026-09-17", time: "15:55", open: 1000, high: 1000, low: 1000, close: 1000, volume: 10000 });
  data.candidates.push({ ...data.candidates[0], symbol: "OLD", rankedOn: "2026-09-15" });
  const result = summarizeSurgeResearch([data], 1000);
  assert.equal(result.events, 1);
  assert.equal(result.afterObservation.forwardReturnPct["+5m"].samples, 0);
  assert.equal(result.afterObservation.toFlatAt1555Pct.median, 10);
  assert.equal(result.afterObservation.firstTouchWithin60m["±3%"].missing, 1);
});

test("streaming daily summaries match a whole-block summary and distinguish events from sessions", () => {
  const first = session(), second = session({ symbol: "BBB" });
  const data = { date, candidates: [...first.candidates, ...second.candidates], bars: { ...first.bars, ...second.bars } };
  const accumulator = createSurgeResearchSummary(1000);
  accumulator.add(data);
  assert.deepEqual(accumulator.result(), summarizeSurgeResearch([data], 1000));
  const group = accumulator.result().afterSimilarFirst15m.groups.find(g => g.shape === "first15m_up");
  assert.equal(group.events, 2);
  assert.equal(group.sessions, 1);
  assert.equal(group.symbols, 2);
});
