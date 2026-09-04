import assert from "node:assert/strict";
import test from "node:test";
import { buildGapPortfolio, GAP_DEFAULTS, scanGapSession, summarizeGapSetup } from "../lib/gap-strategy.ts";

/** 5-minute regular-session bars from 09:30 ET, one per [open, high, low, close]. */
function session(rows, date = "2026-08-05") {
  return rows.map((row, index) => ({
    date, minute: 9 * 60 + 30 + index * 5,
    open: row[0], high: row[1], low: row[2], close: row[3], volume: 1000,
  }));
}

const free = { ...GAP_DEFAULTS, costRoundTripPct: 0 };

test("a gap down inside the window targets the prior close and stops symmetrically", () => {
  // Prior close 100, opens at 99 (-1% gap), first bar closes at 99.
  // Target = 100, so risk = 1 at 1:1 and the stop is 98.
  const bars = session([[99, 99.2, 98.8, 99], [99, 99.5, 98.9, 99.4], [99.4, 100.2, 99.3, 100.1]]);
  const { trade, skip } = scanGapSession("TEST", "2026-08-05", bars, 100, free);
  assert.equal(skip, null);
  assert.equal(trade.setup, "fade_gap_down");
  assert.equal(trade.entryPrice, 99);   // the first bar's close, not the 99.00 open print
  assert.equal(trade.targetPrice, 100);
  assert.equal(trade.stopPrice, 98);
  assert.equal(trade.exitReason, "target");
  assert.equal(trade.rMultiple, 1);
});

test("a bar covering both the stop and the target is scored as a stop", () => {
  const bars = session([[99, 99.2, 98.8, 99], [99, 100.5, 97.5, 99]]);
  const { trade } = scanGapSession("TEST", "2026-08-05", bars, 100, free);
  assert.equal(trade.exitReason, "stop");
  assert.equal(trade.rMultiple, -1);
});

test("the entry bar cannot also be the exit bar", () => {
  // The first bar's own low is below the stop, but the position does not exist
  // until that bar has closed, so it must not be scored as an instant loss.
  const bars = session([[99, 99.2, 97, 99], [99, 100.2, 98.9, 100.1]]);
  const { trade } = scanGapSession("TEST", "2026-08-05", bars, 100, free);
  assert.equal(trade.exitReason, "target");
});

test("a gap that the first bar already closed is skipped, not entered at a loss", () => {
  // Opens at 99 but the first bar runs to 100.4, past the prior close. There is
  // no fade left to trade and the target would sit below the entry.
  const bars = session([[99, 100.5, 98.9, 100.4], [100.4, 100.6, 100.2, 100.5]]);
  const { trade, skip } = scanGapSession("TEST", "2026-08-05", bars, 100, free);
  assert.equal(trade, null);
  assert.ok(skip.reason.includes("이미 갭을 메워"));
});

test("a missing previous close is a skip rather than a gap measured across a hole", () => {
  const bars = session([[99, 99.2, 98.8, 99], [99, 99.5, 98.9, 99.4]]);
  assert.equal(scanGapSession("TEST", "2026-08-05", bars, null, free).trade, null);
  assert.equal(scanGapSession("TEST", "2026-08-05", bars, null, free).skip.reason, "직전 종가 없음 — 갭 계산 불가");
});

test("the time stop exits at the last close before the cutoff", () => {
  const flat = Array.from({ length: 40 }, () => [99, 99.1, 98.9, 99]);
  const bars = session(flat);
  const { trade } = scanGapSession("TEST", "2026-08-05", bars, 100, { ...free, fadeTimeStopMinute: 10 * 60 });
  assert.equal(trade.exitReason, "time_stop");
  assert.ok(trade.exitTime < 10 * 60);
  assert.ok(Math.abs(trade.rMultiple) < 0.01); // flat price, no cost charged here
});

test("a gap outside both windows produces no trade", () => {
  const bars = session([[99.8, 100, 99.7, 99.9], [99.9, 100.1, 99.8, 100]]);
  const { trade, skip } = scanGapSession("TEST", "2026-08-05", bars, 100, free); // -0.2% gap
  assert.equal(trade, null);
  assert.ok(skip.reason.includes("어느 규칙에도 해당 없음"));
});

test("a large gap up is followed with the stop under the first bar", () => {
  const bars = session([[105, 106, 104.5, 105.5], [105.5, 106, 105.2, 105.8], [105.8, 108, 105.6, 107.9]]);
  const { trade } = scanGapSession("TEST", "2026-08-05", bars, 100, free); // +5% gap
  assert.equal(trade.setup, "follow_gap_up");
  assert.equal(trade.stopPrice, 104.5);
  assert.equal(trade.targetPrice, 107.5); // 105.5 + 2 x 1.0
  assert.equal(trade.exitReason, "target");
  assert.equal(trade.rMultiple, 2);
});

test("round-trip cost is charged and pushes the breakeven win rate up", () => {
  const bars = session([[99, 99.2, 98.8, 99], [99, 100.2, 98.9, 100.1]]);
  const clean = scanGapSession("TEST", "2026-08-05", bars, 100, free).trade;
  const charged = scanGapSession("TEST", "2026-08-05", bars, 100, { ...free, costRoundTripPct: 0.2308 }).trade;
  assert.equal(clean.rMultiple, 1);
  assert.ok(charged.rMultiple < 1);
  const summary = summarizeGapSetup("fade_gap_down", [charged], 1, 0.2308);
  assert.ok(summary.breakevenWinRatePct > 50); // 1:1 is 50% only when trading is free
});

test("adverse excursion is recorded even on a winning trade", () => {
  const bars = session([[99, 99.2, 98.8, 99], [99, 99.1, 98.3, 98.5], [98.5, 100.2, 98.4, 100.1]]);
  const { trade } = scanGapSession("TEST", "2026-08-05", bars, 100, free);
  assert.equal(trade.exitReason, "target");
  // It dipped to 98.3 first: "the gap filled" and "you survived to see it" differ.
  assert.ok(trade.maxAdversePct < -0.7);
});

test("same-day trades are sized off the same starting equity", () => {
  const trade = (symbol, date, rMultiple) => ({
    symbol, date, setup: "fade_gap_down", gapPct: -1, previousClose: 100,
    entryTime: 570, entryPrice: 99, stopPrice: 98, targetPrice: 100, riskPct: 1,
    exitTime: 600, exitPrice: 100, exitReason: "target", rMultiple,
    grossReturnPct: 1, netReturnPct: 1, maxAdversePct: 0, maxFavorablePct: 1, barsHeld: 1,
  });
  // Two +1R trades on one day at 1% risk is +2% that day, not 1.01 x 1.01.
  const book = buildGapPortfolio([trade("A", "2026-08-05", 1), trade("B", "2026-08-05", 1)], 1, 4);
  assert.equal(book.tradingDays, 1);
  assert.equal(book.equityCurve[0].dailyReturnPct, 2);
  assert.equal(book.totalReturnPct, 2);
  // The per-day cap drops the surplus rather than silently taking every setup.
  const capped = buildGapPortfolio([trade("A", "2026-08-05", 1), trade("B", "2026-08-05", 1)], 1, 1);
  assert.equal(capped.equityCurve[0].trades, 1);
  assert.equal(capped.totalReturnPct, 1);
});

test("losing days and drawdown are tracked across dates", () => {
  const make = (date, rMultiple) => ({
    symbol: "A", date, setup: "fade_gap_down", gapPct: -1, previousClose: 100,
    entryTime: 570, entryPrice: 99, stopPrice: 98, targetPrice: 100, riskPct: 1,
    exitTime: 600, exitPrice: 100, exitReason: "stop", rMultiple,
    grossReturnPct: 0, netReturnPct: 0, maxAdversePct: 0, maxFavorablePct: 0, barsHeld: 1,
  });
  const book = buildGapPortfolio([make("2026-08-05", 1), make("2026-08-06", -1), make("2026-08-07", -1)], 1, 4);
  assert.equal(book.winningDays, 1);
  assert.equal(book.losingDays, 2);
  assert.ok(book.maxDrawdownPct > 1.9 && book.maxDrawdownPct < 2.1);
  assert.ok(book.totalReturnPct < 0);
});
