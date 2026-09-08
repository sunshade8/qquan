import assert from "node:assert/strict";
import test from "node:test";
import { h2Reversal, COST_PER_SIDE_PCT } from "../lib/trade-strategies.ts";
import { replayStrategy, sessionCalendar, sessionsHeldAtFill } from "../lib/trade-strategy-engine.ts";

const DAY_MS = 86_400_000;

/** Weekday-only dates, so a "session calendar" looks like a real one. */
function sessions(count, start = "2026-01-05") {
  const out = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) out.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return out;
}

/** A flat series at `price`, with optional per-index overrides. */
function series(dates, price, overrides = {}) {
  return dates.map((date, index) => {
    const close = overrides[index]?.close ?? price;
    return {
      date,
      open: overrides[index]?.open ?? close,
      high: overrides[index]?.high ?? close,
      low: overrides[index]?.low ?? close,
      close,
      volume: 1_000_000,
    };
  });
}

test("entry fires only on a three-session drop past the threshold", () => {
  const dates = sessions(10);
  // -7% over the last three sessions: 100 -> 93 by the final bar.
  const dropping = series(dates, 100, { 7: { close: 97 }, 8: { close: 95 }, 9: { close: 93 } });
  const flat = series(dates, 100);
  const plan = h2Reversal.plan({ asOf: dates.at(-1), bars: { AAA: dropping, BBB: flat }, positions: [], capitalUsd: 120_000 });
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.orders[0].symbol, "AAA");
  assert.equal(plan.orders[0].side, "buy");
  // Slot is capital / 12 = 10,000 at $93 -> 107 shares.
  assert.equal(plan.orders[0].quantity, 107);
  assert.equal(plan.orders[0].stopPrice, Number((93 * 0.94).toFixed(2)));
});

test("only the three deepest drops are taken, and the rest are reported as skipped", () => {
  const dates = sessions(10);
  const bars = {};
  // Five qualifying names at -7, -8, -9, -10 and -11 percent.
  for (const [index, drop] of [7, 8, 9, 10, 11].entries()) {
    bars[`S${index}`] = series(dates, 100, { 9: { close: 100 - drop } });
  }
  const plan = h2Reversal.plan({ asOf: dates.at(-1), bars, positions: [], capitalUsd: 120_000 });
  assert.equal(plan.orders.length, 3);
  assert.deepEqual(plan.orders.map((order) => order.symbol), ["S4", "S3", "S2"]);
  assert.equal(plan.skipped.length, 2);
  assert.match(plan.skipped[0].reason, /하루 3종목 상한/);
});

test("the time exit fires on the session that makes the holding period five, not six", () => {
  const dates = sessions(10);
  const bars = { AAA: series(dates, 100) };
  const position = { symbol: "AAA", quantity: 10, averagePrice: 100, entryDate: dates[3] };
  const early = h2Reversal.plan({ asOf: dates.at(-1), bars, positions: [{ ...position, sessionsAtFill: 4 }], capitalUsd: 120_000 });
  assert.equal(early.orders.length, 0, "four sessions at fill must not exit yet");
  const due = h2Reversal.plan({ asOf: dates.at(-1), bars, positions: [{ ...position, sessionsAtFill: 5 }], capitalUsd: 120_000 });
  assert.equal(due.orders.length, 1);
  assert.equal(due.orders[0].side, "sell");
  assert.equal(due.orders[0].rule, "time_exit");
});

test("a session that traded through the stop exits even before the timer", () => {
  const dates = sessions(10);
  // Last bar dips to 92 against a 100 average price: below the 94 stop.
  const bars = { AAA: series(dates, 100, { 9: { low: 92, close: 95 } }) };
  const plan = h2Reversal.plan({
    asOf: dates.at(-1), bars, capitalUsd: 120_000,
    positions: [{ symbol: "AAA", quantity: 10, averagePrice: 100, entryDate: dates[3], sessionsAtFill: 2 }],
  });
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.orders[0].rule, "stop");
});

test("a name being sold today is not bought back the same day", () => {
  const dates = sessions(10);
  // AAA is both a due exit and, on paper, the deepest qualifying drop.
  const bars = { AAA: series(dates, 100, { 7: { close: 97 }, 8: { close: 95 }, 9: { close: 90 } }) };
  const plan = h2Reversal.plan({
    asOf: dates.at(-1), bars, capitalUsd: 120_000,
    positions: [{ symbol: "AAA", quantity: 10, averagePrice: 100, entryDate: dates[3], sessionsAtFill: 5 }],
  });
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.orders[0].side, "sell");
  assert.ok(!plan.orders.some((order) => order.side === "buy"), "must not re-enter the name it is exiting");
});

test("positions are capped at twelve and the cap blocks further entries", () => {
  const dates = sessions(10);
  const bars = {};
  const positions = [];
  for (let index = 0; index < 12; index += 1) {
    const symbol = `H${index}`;
    bars[symbol] = series(dates, 100);
    positions.push({ symbol, quantity: 1, averagePrice: 100, entryDate: dates[8], sessionsAtFill: 1 });
  }
  bars.NEW = series(dates, 100, { 9: { close: 90 } });
  const plan = h2Reversal.plan({ asOf: dates.at(-1), bars, positions, capitalUsd: 120_000 });
  assert.equal(plan.orders.length, 0);
  assert.match(plan.notes.join(" "), /동시 보유 상한/);
});

test("sessionsHeldAtFill resolves every calendar case a ledger can produce", () => {
  const calendar = ["2026-01-05", "2026-01-06", "2026-01-07"];
  const fillIndex = calendar.length;
  // A fill stamped after the last known session has not been held at all — the
  // case that used to read as "infinitely old" and sold everything just bought.
  assert.equal(sessionsHeldAtFill(calendar, "2026-01-10", fillIndex), 0);
  assert.equal(sessionsHeldAtFill(calendar, "2026-01-07", fillIndex), 1);
  assert.equal(sessionsHeldAtFill(calendar, "2026-01-05", fillIndex), 3);
  assert.equal(sessionsHeldAtFill(calendar, "2020-01-01", fillIndex), Number.MAX_SAFE_INTEGER);
  assert.equal(sessionsHeldAtFill([], "2026-01-05", 0), 0);
});

test("the replay fills on the session after the signal, never on the signal bar", () => {
  const dates = sessions(30);
  // One qualifying drop at index 20, then a jump on 21 the rule must not see.
  const bars = { AAA: series(dates, 100, { 18: { close: 97 }, 19: { close: 95 }, 20: { close: 92 }, 21: { close: 130, high: 130 } }) };
  const result = replayStrategy(h2Reversal, bars, { from: dates[0], to: dates.at(-1), capitalUsd: 120_000, benchmark: null });
  const buy = result.fills.find((fill) => fill.side === "buy");
  assert.ok(buy, "expected an entry");
  assert.equal(buy.date, dates[21], "entry fills on the session after the signal");
  assert.equal(buy.price, 130, "and at that session's close, not the signal close");
});

test("cost is charged on both sides and shows up in net return", () => {
  const dates = sessions(30);
  const bars = { AAA: series(dates, 100, { 18: { close: 97 }, 19: { close: 95 }, 20: { close: 92 } }) };
  const result = replayStrategy(h2Reversal, bars, { from: dates[0], to: dates.at(-1), capitalUsd: 120_000, benchmark: null });
  const trade = result.trades[0];
  assert.ok(trade, "expected a closed trade");
  // Flat price in and out, so the whole move is the round trip.
  assert.equal(trade.grossPct, 0);
  assert.ok(Math.abs(trade.netPct + COST_PER_SIDE_PCT * 2) < 1e-6, `net should be -${COST_PER_SIDE_PCT * 2}, got ${trade.netPct}`);
  assert.ok(result.metrics.costPaidUsd > 0);
});

test("sessionCalendar unions every symbol's dates in order", () => {
  const calendar = sessionCalendar({
    AAA: [{ date: "2026-01-06" }, { date: "2026-01-08" }],
    BBB: [{ date: "2026-01-05" }, { date: "2026-01-08" }],
  });
  assert.deepEqual(calendar, ["2026-01-05", "2026-01-06", "2026-01-08"]);
});
