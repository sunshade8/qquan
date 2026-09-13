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

/** Enters at a fixed time in its slot and rides to the slot's edge. */
function fixedStrategy(id, slot, entryTime, { stopPct = 5, targetPct = null } = {}) {
  return {
    id, name: id, slot, summary: "", universe: ["RKLB"], rules: [], evidence: "", cautions: [],
    warmupSessions: 0,
    scan: () => ({ symbol: "RKLB", entryTime, stopPct, targetPct, reason: "test" }),
  };
}

test("a slot uses the whole balance, not a share of it", () => {
  // One slot, price rises 1% inside the window. The account must move ~1% minus cost,
  // not 1%/N — the dilution that made the old parallel book meaningless.
  const sessions = days(1, (date) => session(date, 100, { "09:35": { open: 100, close: 100 }, "09:55": { open: 101, close: 101, high: 101 } }));
  const result = runRelay([fixedStrategy("open-rule", "open", "09:35")], sessions, { capitalUsd: 10_000 });
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
  const result = runRelay([fixedStrategy("a", "open", "09:35"), fixedStrategy("b", "trend", "10:05")], sessions, { capitalUsd: 10_000 });
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
  const result = runRelay([fixedStrategy("open-rule", "open", "09:35", { stopPct: 20 })], sessions, { capitalUsd: 10_000 });
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
  const result = runRelay([fixedStrategy("open-rule", "open", "09:35", { stopPct: 2, targetPct: 2 })], sessions, { capitalUsd: 10_000 });
  assert.equal(result.days[0].slots.find((slot) => slot.traded).exit, "stop");
});

test("an open position is closed at the slot's edge, never carried into the next slot", () => {
  const sessions = days(1, (date) => session(date, 100, { "09:35": { open: 100, close: 100 } }));
  const result = runRelay([fixedStrategy("open-rule", "open", "09:35")], sessions, { capitalUsd: 10_000 });
  const traded = result.days[0].slots.find((slot) => slot.traded);
  assert.equal(traded.exit, "slot_end");
  assert.ok(traded.exitTime < "10:00", `must exit inside the 09:30-10:00 window, got ${traded.exitTime}`);
});

test("two strategies cannot share a slot", () => {
  assert.throws(
    () => runRelay([fixedStrategy("a", "open", "09:35"), fixedStrategy("b", "open", "09:40")], days(1, (date) => session(date, 100)), { capitalUsd: 10_000 }),
    /슬롯 open에 전략이 둘 이상/,
  );
});

test("leveraged and inverse products are refused at registration", () => {
  assert.ok(isExcludedInstrument("TQQQ"));
  assert.ok(isExcludedInstrument("sqqq"), "the check is case-insensitive");
  assert.ok(isExcludedInstrument("SOXL"));
  assert.ok(!isExcludedInstrument("RKLB"));
  assert.throws(() => assertTradable(["RKLB", "TQQQ"], "테스트 전략"), /레버리지·인버스 상품은 거래하지 않습니다 — TQQQ/);
  const leveraged = { ...fixedStrategy("bad", "open", "09:35"), universe: ["SOXL"] };
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
