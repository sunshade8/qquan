import assert from "node:assert/strict";
import test from "node:test";
import { runRelay } from "../lib/relay-engine.ts";
import { assertTradable, isExcludedInstrument, SLOTS, slotWindowKst, UNBACKTESTABLE_SESSION } from "../lib/trade-slots.ts";
import { costPerSidePct, halfSpreadPct, rangeToCostRatio } from "../lib/symbol-liquidity.ts";
import { slotTarget } from "../lib/relay-targets.ts";

/** 5-minute regular-hours bars from 09:30, flat at `price` unless overridden. */
function session(date, price, overrides = {}) {
  const bars = [];
  for (let index = 0; index < 78; index += 1) {
    const minute = 9 * 60 + 30 + index * 5;
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const bar = overrides[time] ?? {};
    const close = bar.close ?? price;
    bars.push({ date, time, open: bar.open ?? close, high: bar.high ?? Math.max(bar.open ?? close, close), low: bar.low ?? Math.min(bar.open ?? close, close), close, volume: 10_000 });
  }
  return bars;
}

const days = (count, build) => Array.from({ length: count }, (_, index) => {
  const date = `2026-03-${String(index + 2).padStart(2, "0")}`;
  return { date, bars: { RKLB: build(date, index) } };
});

/**
 * Signals once the bar starting at `signalAt` has closed, and rides to the slot's
 * edge. The fill is the engine's choice: the open of the next bar.
 */
function fixedStrategy(id, slot, signalAt, { stopPct = 5, targetPct = null } = {}) {
  return {
    id, name: id, slot, summary: "", universe: ["RKLB"], rules: [], evidence: "", cautions: [],
    warmupSessions: 0,
    scan: ({ asOf }) => asOf >= signalAt ? { symbol: "RKLB", stopPct, targetPct, reason: "test" } : null,
  };
}

test("a slot uses the whole balance, not a share of it", () => {
  // One slot, price rises 1% inside the window. The account must move ~1% minus cost,
  // not 1%/N — the dilution that made the old parallel book meaningless.
  const sessions = days(1, (date) => session(date, 100, { "09:35": { open: 100, close: 100 }, "09:55": { open: 101, close: 101, high: 101 } }));
  const result = runRelay([fixedStrategy("open-rule", "open", "09:30")], sessions, { capitalUsd: 10_000 });
  const day = result.days[0];
  const cost = costPerSidePct("RKLB") * 2;
  assert.ok(day.returnPct > 1 - cost - 0.05 && day.returnPct < 1, `expected ~${(1 - cost).toFixed(2)}%, got ${day.returnPct}%`);
  assert.equal(result.metrics.tradingDays, 1);
});

test("slots run in clock order against one balance and compound within the day", () => {
  // Two slots, each +1%. Sequential on one balance compounds to ~2%, and the
  // second slot must be sized off the balance the first one handed back.
  const sessions = days(1, (date) => session(date, 100, {
    "09:35": { open: 100, close: 100 }, "09:55": { open: 101, close: 101, high: 101 },
    "10:05": { open: 101, close: 101 }, "11:25": { open: 102.01, close: 102.01, high: 102.01 },
  }));
  const result = runRelay([fixedStrategy("a", "open", "09:30"), fixedStrategy("b", "trend", "10:00")], sessions, { capitalUsd: 10_000 });
  const [openSlot, trendSlot] = result.days[0].slots.filter((slot) => slot.traded);
  assert.equal(openSlot.slot, "open");
  assert.equal(trendSlot.slot, "trend");
  assert.ok(trendSlot.quantity * trendSlot.entryPrice > 9_000, "second slot must trade the full balance");
  assert.ok(result.days[0].returnPct > 1.4, `two 1% slots should compound past 1.4%, got ${result.days[0].returnPct}%`);
});

test("days when nothing fires are counted as zero, not dropped", () => {
  const quiet = { id: "never", name: "never", slot: "open", summary: "", universe: ["RKLB"], rules: [], evidence: "", cautions: [], warmupSessions: 0, scan: () => null };
  const sessions = days(5, (date) => session(date, 100));
  const result = runRelay([quiet], sessions, { capitalUsd: 10_000 });
  assert.equal(result.metrics.sessions, 5);
  assert.equal(result.metrics.tradingDays, 0);
  assert.equal(result.metrics.flatDays, 5, "a flat day is a 0% day and belongs in the denominator");
  assert.equal(result.metrics.meanDailyPct, 0);
  assert.equal(result.metrics.daysAbove1PctShare, 0);
});

test("the daily-return share is measured against every session, including losses", () => {
  // Three sessions: +2%, flat, -2%. The goal is stated per day, so the metric has
  // to be the share of *sessions* clearing it, not the share of trades.
  const sessions = [
    { date: "2026-03-02", bars: { RKLB: session("2026-03-02", 100, { "09:35": { open: 100, close: 100 }, "09:55": { open: 103, close: 103, high: 103 } }) } },
    { date: "2026-03-03", bars: { RKLB: session("2026-03-03", 100) } },
    { date: "2026-03-04", bars: { RKLB: session("2026-03-04", 100, { "09:35": { open: 100, close: 100 }, "09:55": { open: 97.5, close: 97.5, low: 97.5 } }) } },
  ];
  const result = runRelay([fixedStrategy("open-rule", "open", "09:30", { stopPct: 20 })], sessions, { capitalUsd: 10_000 });
  assert.equal(result.metrics.sessions, 3);
  assert.equal(result.metrics.daysAbove1PctShare, 33.33);
  assert.equal(result.metrics.positiveDayPct, 33.33);
  assert.ok(result.metrics.worstDayPct < -2, `worst day should carry the loss, got ${result.metrics.worstDayPct}`);
});

test("a bar covering both the stop and the target is scored as the stop", () => {
  const sessions = days(1, (date) => session(date, 100, {
    "09:35": { open: 100, close: 100 },
    "09:40": { open: 100, high: 103, low: 97, close: 100 },
  }));
  const result = runRelay([fixedStrategy("open-rule", "open", "09:30", { stopPct: 2, targetPct: 2 })], sessions, { capitalUsd: 10_000 });
  assert.equal(result.days[0].slots.find((slot) => slot.traded).exit, "stop");
});

test("an open position is closed at the slot's edge, never carried into the next slot", () => {
  const sessions = days(1, (date) => session(date, 100, { "09:35": { open: 100, close: 100 } }));
  const result = runRelay([fixedStrategy("open-rule", "open", "09:30")], sessions, { capitalUsd: 10_000 });
  const traded = result.days[0].slots.find((slot) => slot.traded);
  assert.equal(traded.exit, "slot_end");
  assert.ok(traded.exitTime < "10:00", `must exit inside the 09:30-10:00 window, got ${traded.exitTime}`);
});

test("a rule cannot see a bar before it has closed, and fills only after the decision", () => {
  // The old engine handed the rule the whole window and let it name an entry
  // time, so "09:55 closed higher → buy at 09:30" backtested as a sure win.
  const seen = [];
  const peeking = {
    id: "peek", name: "peek", slot: "open", summary: "", universe: ["RKLB"], rules: [], evidence: "", cautions: [], warmupSessions: 0,
    scan: ({ asOf, window }) => {
      const bars = window.RKLB;
      seen.push({ asOf, last: bars.at(-1)?.time });
      const late = bars.find((bar) => bar.time === "09:55");
      return late && late.close > bars[0].open ? { symbol: "RKLB", stopPct: 5, targetPct: null, reason: "saw 09:55" } : null;
    },
  };
  const sessions = days(1, (date) => session(date, 100, { "09:55": { open: 100, close: 110, high: 110 } }));
  const result = runRelay([peeking], sessions, { capitalUsd: 10_000 });
  assert.ok(seen.every((call) => call.last === call.asOf), "the newest visible bar is always the decision bar");
  const outcome = result.days[0].slots.find((slot) => slot.slot === "open");
  assert.equal(outcome.signal, true);
  assert.equal(outcome.signalTime, "09:55");
  assert.equal(outcome.traded, false, "the 09:55 decision has no later bar inside the slot to fill on");
  assert.match(outcome.violations[0], /신호 미체결/);
  assert.equal(result.days[0].returnPct, 0, "the +10% bar it peeked at must not reach the account");
});

test("the fill is the open of the bar after the signal bar", () => {
  const sessions = days(1, (date) => session(date, 100, { "09:40": { open: 104, close: 104, high: 104, low: 104 } }));
  const result = runRelay([fixedStrategy("open-rule", "open", "09:35")], sessions, { capitalUsd: 10_000 });
  const traded = result.days[0].slots.find((slot) => slot.traded);
  assert.equal(traded.signalTime, "09:35");
  assert.equal(traded.entryTime, "09:40");
  assert.equal(traded.entryPrice, 104);
});

test("a stop inside the entry bar itself is taken", () => {
  // Filled at the 09:35 open of 100; the same bar trades down to 90. A 1% stop
  // must fire at 99 on that bar, not be skipped because the loop started one bar later.
  const sessions = days(1, (date) => session(date, 100, {
    "09:35": { open: 100, high: 100, low: 90, close: 99.5 },
    "09:55": { open: 100, close: 100 },
  }));
  const result = runRelay([fixedStrategy("open-rule", "open", "09:30", { stopPct: 1 })], sessions, { capitalUsd: 10_000 });
  const traded = result.days[0].slots.find((slot) => slot.traded);
  assert.equal(traded.exit, "stop");
  assert.equal(traded.exitTime, "09:35");
  assert.equal(traded.exitPrice, 99);
  assert.ok(result.days[0].returnPct < -1 && result.days[0].returnPct > -1.3, `a 1% stop plus cost, got ${result.days[0].returnPct}%`);
  assert.equal(traded.ruleCompliant, true, "a stop filled at its own price is the rule working");
});

test("the entry bar can reach the target when it never touches the stop", () => {
  const sessions = days(1, (date) => session(date, 100, { "09:35": { open: 100, high: 102.5, low: 99.5, close: 101 } }));
  const result = runRelay([fixedStrategy("open-rule", "open", "09:30", { stopPct: 1, targetPct: 2 })], sessions, { capitalUsd: 10_000 });
  const traded = result.days[0].slots.find((slot) => slot.traded);
  assert.equal(traded.exit, "target");
  assert.equal(traded.exitPrice, 102);
});

test("drawdown includes the intraday low even when the day recovers", () => {
  // In at 100, marked down to 94.8 at 09:40 (−5.2%), back to 101 by the slot's end.
  // End-of-day equity never fell, which is exactly what the old metric reported.
  const sessions = days(1, (date) => session(date, 100, {
    "09:35": { open: 100, close: 100 },
    "09:40": { open: 99, high: 99, low: 94.8, close: 95 },
    "09:45": { open: 95, close: 98 },
    "09:55": { open: 100, high: 101, close: 101 },
  }));
  const result = runRelay([fixedStrategy("open-rule", "open", "09:30", { stopPct: 10 })], sessions, { capitalUsd: 10_000 });
  const day = result.days[0];
  assert.ok(day.returnPct > 0, `the day still ends up, got ${day.returnPct}%`);
  assert.ok(day.intradayLowPct <= -5.2, `the day's low must show, got ${day.intradayLowPct}%`);
  assert.ok(result.metrics.maxDrawdownPct >= 5.2, `MDD must carry the morning, got ${result.metrics.maxDrawdownPct}%`);
  assert.equal(result.metrics.endOfDayMaxDrawdownPct, 0, "the close-only measure is kept for comparison and still reads 0");
});

test("a gap through the stop is recorded as a deviation from the rule", () => {
  const sessions = days(1, (date) => session(date, 100, {
    "09:35": { open: 100, close: 100 },
    "09:40": { open: 95, high: 95, low: 94, close: 94.5 },
  }));
  const result = runRelay([fixedStrategy("open-rule", "open", "09:30", { stopPct: 2 })], sessions, { capitalUsd: 10_000 });
  const traded = result.days[0].slots.find((slot) => slot.traded);
  assert.equal(traded.exit, "stop");
  assert.equal(traded.exitPrice, 95, "a gap fills at the open, not at the stop price it jumped over");
  assert.equal(traded.ruleCompliant, false);
  assert.match(traded.violations[0], /손절 초과/);
  assert.equal(result.metrics.adherencePct, 0);
});

test("an order outside the rule's universe is refused and counted", () => {
  const rogue = { ...fixedStrategy("rogue", "open", "09:30"), scan: () => ({ symbol: "NVDA", stopPct: 1, targetPct: null, reason: "rogue" }) };
  const result = runRelay([rogue], days(1, (date) => session(date, 100)), { capitalUsd: 10_000 });
  const outcome = result.days[0].slots.find((slot) => slot.slot === "open");
  assert.equal(outcome.traded, false);
  assert.match(outcome.violations[0], /유니버스 밖/);
  assert.equal(result.metrics.missedSignals, 1);
});

test("two strategies cannot share a slot", () => {
  assert.throws(
    () => runRelay([fixedStrategy("a", "open", "09:30"), fixedStrategy("b", "open", "09:35")], days(1, (date) => session(date, 100)), { capitalUsd: 10_000 }),
    /슬롯 open에 전략이 둘 이상/,
  );
});

test("leveraged and inverse products are refused at registration", () => {
  assert.ok(isExcludedInstrument("TQQQ"));
  assert.ok(isExcludedInstrument("sqqq"), "the check is case-insensitive");
  assert.ok(isExcludedInstrument("SOXL"));
  assert.ok(!isExcludedInstrument("RKLB"));
  assert.throws(() => assertTradable(["RKLB", "TQQQ"], "테스트 전략"), /레버리지·인버스 상품은 거래하지 않습니다 — TQQQ/);
  const leveraged = { ...fixedStrategy("bad", "open", "09:30"), universe: ["SOXL"] };
  assert.throws(() => runRelay([leveraged], days(1, (date) => session(date, 100)), { capitalUsd: 10_000 }), /레버리지/);
});

test("cost is per symbol, so a wide spread is not hidden behind a large-cap default", () => {
  // The 0.1% commission floors both sides, so compare the part that actually differs.
  assert.ok(halfSpreadPct("LUNR") > halfSpreadPct("RKLB") * 10, "LUNR's spread is an order of magnitude wider");
  assert.ok(costPerSidePct("LUNR") > costPerSidePct("RKLB") * 3.5, "and it still dominates once commission is added");
  assert.equal(halfSpreadPct("NOT_MEASURED"), 0.015, "an unmeasured symbol falls back to the large-cap assumption, never to zero");
  // Range alone would rank ASTX first; range-to-cost is what actually ranks them.
  assert.ok(rangeToCostRatio("RKLB") > rangeToCostRatio("LUNR"));
  assert.ok(rangeToCostRatio("RKLB") > rangeToCostRatio("ASTS"));
});

test("slot windows are contiguous and span exactly the hours minute bars cover", () => {
  // 04:00-19:55 ET is Massive's extended-hours window. A slot outside it could be
  // traded at Toss but never measured, so the relay does not offer one.
  assert.equal(SLOTS[0].from, "04:00");
  assert.equal(SLOTS.at(-1).to, "19:55");
  for (let index = 1; index < SLOTS.length; index += 1) {
    assert.equal(SLOTS[index].from, SLOTS[index - 1].to, "a gap or overlap between slots would let capital be double-committed");
  }
  assert.deepEqual([...new Set(SLOTS.map((slot) => slot.session))], ["premarket", "regular", "aftermarket"]);
});

test("the overnight session is documented as tradable but excluded for lack of data", () => {
  assert.ok(!SLOTS.some((slot) => slot.from < "04:00"), "20:00-04:00 ET must not be a slot");
  assert.match(UNBACKTESTABLE_SESSION.reason, /Massive/);
  assert.equal(UNBACKTESTABLE_SESSION.et, "20:00–04:00");
});

test("slot windows resolve to Seoul time across the daylight-saving boundary", () => {
  const open = SLOTS.find((slot) => slot.id === "open");
  assert.equal(slotWindowKst(open, "2026-07-01").from, "22:30");
  assert.equal(slotWindowKst(open, "2026-01-05").from, "23:30", "US winter time pushes the Korean open an hour later");
  // The pre-market slot starts before the Korean evening; it must still resolve.
  assert.equal(slotWindowKst(SLOTS[0], "2026-07-01").from, "17:00");
});

test("slot targets compound rather than divide, and the difference is visible", () => {
  const three = slotTarget({ dailyTargetPct: 2, slots: 3, fireRate: 1, symbol: "RKLB", rewardRisk: 2 }, 1);
  // 2%/3 would be 0.667%; compounding needs slightly less because the slots stack.
  assert.ok(three.perSessionNetPct < 2 / 3, `compounded target must be under the naive split, got ${three.perSessionNetPct}`);
  assert.ok(three.perSessionNetPct > 0.66);
  assert.equal(Number(((1 + three.perSessionNetPct / 100) ** 3 - 1).toFixed(4)), 0.02);
});

test("a slot that fires less often must earn more when it does", () => {
  const always = slotTarget({ dailyTargetPct: 1.5, slots: 7, fireRate: 1, symbol: "RKLB", rewardRisk: 2 }, 1);
  const sometimes = slotTarget({ dailyTargetPct: 1.5, slots: 7, fireRate: 0.5, symbol: "RKLB", rewardRisk: 2 }, 1);
  assert.equal(always.perSessionNetPct, sometimes.perSessionNetPct, "the daily requirement does not change");
  assert.ok(Math.abs(sometimes.perFireNetPct - always.perFireNetPct * 2) < 1e-9, "halving the fire rate doubles what a fire must earn");
});

test("cost is added on top of the net target, per symbol", () => {
  const cheap = slotTarget({ dailyTargetPct: 1, slots: 5, fireRate: 1, symbol: "RKLB", rewardRisk: 2 }, 1);
  const dear = slotTarget({ dailyTargetPct: 1, slots: 5, fireRate: 1, symbol: "LUNR", rewardRisk: 2 }, 1);
  assert.equal(cheap.perFireNetPct, dear.perFireNetPct, "the net requirement is the same");
  assert.ok(dear.perFireGrossPct > cheap.perFireGrossPct + 0.7, "LUNR's spread adds most of a percent to every trade");
  assert.ok(dear.requiredWinRatePct > cheap.requiredWinRatePct + 20);
});

test("more slots lower the required win rate — the reason to use extended hours", () => {
  const few = slotTarget({ dailyTargetPct: 2, slots: 3, fireRate: 0.6, symbol: "RKLB", rewardRisk: 2 }, 1);
  const many = slotTarget({ dailyTargetPct: 2, slots: 9, fireRate: 0.6, symbol: "RKLB", rewardRisk: 2 }, 1);
  assert.ok(few.requiredWinRatePct > 75, `three slots demand an implausible win rate, got ${few.requiredWinRatePct}`);
  assert.ok(many.requiredWinRatePct < 56, `nine slots bring it into range, got ${many.requiredWinRatePct}`);
});

test("required win rate follows expectancy at the stated reward:risk", () => {
  const target = slotTarget({ dailyTargetPct: 1, slots: 5, fireRate: 1, symbol: "RKLB", rewardRisk: 2 }, 1);
  // w = (E + 1) / (R + 1)
  const expected = ((target.requiredEdgeR + 1) / 3) * 100;
  assert.ok(Math.abs(target.requiredWinRatePct - expected) < 0.1);
  // A wider stop needs less edge per R for the same captured move.
  const wide = slotTarget({ dailyTargetPct: 1, slots: 5, fireRate: 1, symbol: "RKLB", rewardRisk: 2 }, 2);
  assert.ok(wide.requiredEdgeR < target.requiredEdgeR);
});

test("a rule is replayed on its own bar: one-minute bars fill a minute later and the edge checks use one minute", () => {
  const minutes = [];
  for (let minute = 9 * 60 + 30; minute < 10 * 60; minute += 1) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    minutes.push({ date: "2026-03-02", time, open: 100, high: 100, low: 100, close: 100, volume: 100_000 });
  }
  const rule = {
    ...fixedStrategy("minute", "open", "09:33"), barMinutes: 1, maxHoldMinutes: 10,
    execution: { participationPct: 5, reservePct: 1, maxDailyLossPct: 5, maxEntryDriftPct: 1, maxSpreadPct: 0.5 },
  };
  const session = { date: "2026-03-02", bars: {}, barsByStep: { 1: { RKLB: minutes } } };
  const trade = runRelay([rule], [session], { capitalUsd: 1_000 }).days[0].slots.find((slot) => slot.traded);
  assert.equal(trade.signalTime, "09:33");
  assert.equal(trade.entryTime, "09:34", "the next one-minute bar, not the next five-minute bar");
  assert.equal(trade.exit, "slot_end");
  assert.equal(trade.exitTime, "09:43", "ten one-minute bars held, then out");
  assert.deepEqual(trade.violations, [], "a one-minute path is complete, not 'missing bars' against a five-minute grid");
  assert.throws(() => runRelay([rule], [{ date: "2026-03-02", bars: { RKLB: minutes } }], { capitalUsd: 1_000 }), /1분봉/,
    "a one-minute rule is never silently fed five-minute bars");
});
