import test from "node:test";
import assert from "node:assert/strict";
import {
  CT_ENGINE,
  CT_ENGINE_V1,
  CT_ENGINE_V2,
  ctSpecSchema,
  validateCTSpec,
  executableCT,
  ctHash,
  ctRuleText,
  ctFreedom,
  ctTestSignature,
} from "../lib/ct-spec.ts";
import { ctFeature, ctHigherSets, ctLevelSets, detectCT, ctEntryBlocked, ctInEntryWindow, replayCT, ctHistoryBars } from "../lib/ct-engine.ts";
import { ctRecordTest, ctTestLedger } from "../lib/ct-research.ts";
import { easternWallTimeToEpoch } from "../lib/market-clock.ts";
import { walk, contractFor } from "./helpers/ct-golden-cases.mjs";

const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR,
  DAY0 = Date.UTC(2026, 0, 5);
const cond = (over) => ({ feature: "vwap_distance_pct", lookback: 2, offset: 0, timeframe: 1, op: "lte", value: -0.5, ...over });
const spec = (engine = CT_ENGINE, over = {}) => ({
  version: 1,
  engine,
  name: "vocabulary fixture",
  market: "crypto",
  symbols: ["BTCUSDT"],
  minutes: 1,
  stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond()] }],
  entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2, ...(over.entry ?? {}) },
  exit: over.exit ?? { stopPct: 1, targetPct: 2, maxHoldBars: 120, invalidation: "stop" },
  sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 3, participationPct: 1 },
  sourceIds: ["g"],
  assumptions: ["vocabulary fixture"],
  ...(over.stages ? { stages: over.stages } : {}),
  ...(over.market ? { market: over.market, symbols: over.symbols } : {}),
});
const managed = (over = {}) => ({ stop: { type: "pct", value: 1 }, target: { type: "r", value: 2 }, maxHoldBars: 120, ...over });
const ctx = (s, bars, symbol = "BTCUSDT") => ({ higher: ctHigherSets(s, bars, symbol), levels: ctLevelSets(s, bars), market: s.market, symbol });
/** A spec whose only job is to carry one condition, so ctx() builds the sets the condition needs. */
const carrier = (c, market = "crypto", symbol = "BTCUSDT") =>
  ctSpecSchema.parse(spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [c] }], ...(market === "stock" ? { market, symbols: [symbol] } : {}) }));

/* ------------------------------------------------------------------ schema */

test("schema: level/ATR features, units, entry windows and managed exits exist only for ct-pattern-3", () => {
  assert.doesNotThrow(() => ctSpecSchema.parse(spec(CT_ENGINE)));
  assert.throws(() => ctSpecSchema.parse(spec(CT_ENGINE_V2)), /ct-pattern-3/, "level feature on ct-pattern-2");
  assert.throws(() => ctSpecSchema.parse(spec(CT_ENGINE_V1)), /ct-pattern-3/);
  const classic = (engine, extra) => spec(engine, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "return_pct", lookback: 5, ...extra })] }] });
  assert.doesNotThrow(() => ctSpecSchema.parse(classic(CT_ENGINE_V2, {})));
  assert.throws(() => ctSpecSchema.parse(classic(CT_ENGINE_V2, { unit: "atr" })), /ct-pattern-3/);
  assert.throws(() => ctSpecSchema.parse(spec(CT_ENGINE_V2, { stages: classic(CT_ENGINE_V2, {}).stages, entry: { entryWindows: [{ fromMinute: 0, toMinute: 30 }] } })), /entryWindows/);
  assert.throws(() => ctSpecSchema.parse(spec(CT_ENGINE_V2, { stages: classic(CT_ENGINE_V2, {}).stages, exit: managed() })), /ct-pattern-3/);
  assert.doesNotThrow(() => ctSpecSchema.parse(spec(CT_ENGINE, { stages: classic(CT_ENGINE, { unit: "atr" }).stages, exit: managed() })));
});

test("schema: a level feature cannot carry a parameter that does nothing", () => {
  const parse = (c) => ctSpecSchema.parse(spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [c] }] }));
  assert.throws(() => parse(cond({ lookback: 10 })), /고정/);
  assert.throws(() => parse(cond({ offset: 3 })), /고정/);
  assert.throws(() => parse(cond({ timeframe: 60 })), /고정/);
  assert.throws(() => parse(cond({ feature: "prev_day_high_distance_pct", lookback: 5 })), /고정/);
  assert.doesNotThrow(() => parse(cond({ feature: "opening_range_position", lookback: 30, op: "gte", value: 1 })));
  assert.throws(() => parse(cond({ feature: "opening_range_position", lookback: 4 })), /5분/);
  assert.throws(() => parse(cond({ feature: "opening_range_position", lookback: 30, timeframe: 60 })), /timeframe 1/);
  // unit atr only on percent distances/returns; atr params only where they mean something
  assert.throws(() => parse(cond({ feature: "volume_ratio", lookback: 5, unit: "atr" })), /atr 단위/);
  assert.throws(() => parse(cond({ feature: "range_position", lookback: 5, unit: "atr" })), /atr 단위/);
  assert.throws(() => parse(cond({ feature: "atr_pct", lookback: 14, unit: "atr" })), /atr 단위/);
  assert.throws(() => parse(cond({ atrLookback: 20 })), /atrLookback/);
  assert.throws(() => parse(cond({ atrTimeframe: 60 })), /atrTimeframe/);
  assert.doesNotThrow(() => parse(cond({ unit: "atr", atrLookback: 20, atrTimeframe: 60 })));
  assert.doesNotThrow(() => parse(cond({ feature: "atr_percentile", lookback: 30, atrLookback: 10, op: "gte", value: 0.8 })));
});

test("schema: managed exits are validated as a whole (stop distance, time stop, unused ATR settings)", () => {
  const parse = (exit, over = {}) => ctSpecSchema.parse(spec(CT_ENGINE, { exit, ...over }));
  assert.doesNotThrow(() => parse(managed({ breakeven: { triggerR: 1, offsetPct: 0.2 }, trail: { type: "pct", value: 0.5, activateR: 1.5 }, timeStop: { bars: 30, minR: 0.3 } })));
  assert.throws(() => parse(managed({ stop: { type: "pct", value: 0.1 } })), /0\.2–15/);
  assert.throws(() => parse(managed({ stop: { type: "pct", value: 16 } })));
  assert.throws(() => parse(managed({ stop: { type: "atr", value: 0.2 } })), /0\.5 ATR/);
  assert.throws(() => parse(managed({ timeStop: { bars: 120, minR: 0 } })), /maxHoldBars/);
  assert.throws(() => parse(managed({ atr: { timeframe: 60, lookback: 14 } })), /exit\.atr/, "ATR settings with no atr type");
  assert.doesNotThrow(() => parse(managed({ stop: { type: "atr", value: 2 }, atr: { timeframe: 60, lookback: 14 } })));
  assert.throws(() => parse(managed({ stop: { type: "swing_low", value: 9 } })), /여유폭/);
  // classic and managed are different shapes: a mix is not a rule
  assert.throws(() => parse({ ...managed(), stopPct: 1 }));
});

test("validateCTSpec: engine, stock windows, ATR windows and the 30-day observation cap hold", () => {
  const c = { ...contractFor("crypto", DAY0, 400), engine: CT_ENGINE };
  assert.doesNotThrow(() => validateCTSpec(spec(CT_ENGINE), c, ["g"]));
  assert.throws(() => validateCTSpec(spec(CT_ENGINE), { ...c, engine: CT_ENGINE_V2 }, ["g"]), /엔진/);
  const stock = { ...contractFor("stock", DAY0, 400), engine: CT_ENGINE };
  const stockSpec = (windows) => spec(CT_ENGINE, { market: "stock", symbols: ["NVDA"], exit: { stopPct: 1, targetPct: 2, maxHoldBars: 120, invalidation: "stop" }, entry: { entryWindows: windows } });
  assert.doesNotThrow(() => validateCTSpec(stockSpec([{ fromMinute: 0, toMinute: 389 }]), stock, ["g"]));
  assert.throws(() => validateCTSpec(stockSpec([{ fromMinute: 0, toMinute: 390 }]), stock, ["g"]), /0–389/);
  // ATR normaliser on daily bars: 30 days of bars is the cap, like any higher-timeframe window
  const atr = (lookback) => spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "return_pct", lookback: 5, unit: "atr", atrTimeframe: 1440, atrLookback: lookback })] }] });
  assert.doesNotThrow(() => validateCTSpec(atr(29), c, ["g"]));
  assert.throws(() => validateCTSpec(atr(30), c, ["g"]), /ATR/);
  const percentile = (lookback, atrLookback) => spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "atr_percentile", timeframe: 1440, lookback, atrLookback, op: "gte", value: 0.5 })] }] });
  assert.doesNotThrow(() => validateCTSpec(percentile(10, 14), c, ["g"]));
  assert.throws(() => validateCTSpec(percentile(20, 14), c, ["g"]), /30일/, "lookback + atrLookback daily bars = 34 days");
});

test("hash: spelled-out defaults are the same rule; classic rules hash exactly as before", async () => {
  const withUnit = (extra) => spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "return_pct", lookback: 5, unit: "atr", ...extra })] }] });
  assert.equal(await ctHash(executableCT(withUnit({}))), await ctHash(executableCT(withUnit({ atrLookback: 14 }))), "atrLookback 14 is the default");
  assert.equal(await ctHash(executableCT(withUnit({}))), await ctHash(executableCT(withUnit({ atrTimeframe: 1 }))), "atrTimeframe = own timeframe is the default");
  assert.notEqual(await ctHash(executableCT(withUnit({}))), await ctHash(executableCT(withUnit({ atrLookback: 20 }))));
  const base = spec(CT_ENGINE);
  assert.equal(await ctHash(executableCT(base)), await ctHash(executableCT({ ...base, entry: { ...base.entry, entryWindows: [] } })), "no windows = empty list");
  const a = { ...base, entry: { ...base.entry, entryWindows: [{ fromMinute: 60, toMinute: 90 }, { fromMinute: 0, toMinute: 30 }] } };
  const b = { ...base, entry: { ...base.entry, entryWindows: [{ fromMinute: 0, toMinute: 30 }, { fromMinute: 60, toMinute: 90 }] } };
  assert.equal(await ctHash(executableCT(a)), await ctHash(executableCT(b)), "window order is not a different rule");
  // a classic rule's executable form gained no keys
  const classic = executableCT(spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "return_pct", lookback: 5 })] }] }));
  assert.deepEqual(Object.keys(classic.stages[0].conditions[0]), ["feature", "lookback", "offset", "timeframe", "op", "value"]);
  assert.deepEqual(Object.keys(classic.entry), ["order", "validBars", "maxSpreadPct", "maxDeviationPct"]);
});

test("rule text names the new vocabulary in Korean; classic rules read exactly as before", () => {
  const classic = ctRuleText(ctSpecSchema.parse(spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "return_pct", lookback: 5, value: -0.3 })] }] })));
  assert.equal(
    classic,
    "1. stage one: return_pct(5, 지연 0, 1배 완성봉) ≤ -0.3; 이전 단계 후 3봉 이내\n다음 봉 진입 · 손절 1% · 목표 2% · 120봉 시간 청산 · 무효화 stop · 당일 경계(UTC 00:00) 강제 청산",
  );
  const rich = ctRuleText(
    ctSpecSchema.parse(
      spec(CT_ENGINE, {
        stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ unit: "atr", atrTimeframe: 60, value: -1.5 }), cond({ feature: "opening_range_position", lookback: 30, op: "gte", value: 1 })] }],
        entry: { entryWindows: [{ fromMinute: 0, toMinute: 120 }] },
        exit: managed({ breakeven: { triggerR: 1 }, trail: { type: "atr", value: 3, activateR: 2 }, timeStop: { bars: 20, minR: 0.5 }, stop: { type: "atr", value: 2 }, atr: { timeframe: 60, lookback: 14 } }),
      }),
    ),
  );
  for (const part of ["VWAP 대비 거리%", "ATR배(60분 14봉)", "시가 범위(첫 30분)", "진입 시간 창", "0–120", "손절 2 ATR", "목표 2R", "본전", "트레일", "20봉 안에 0.5R 미만이면 정리", "ATR=60분 14봉"])
    assert.ok(rich.includes(part), `rule text has ${part}: ${rich}`);
});

test("freedom counts conditions plus every free number; the test signature ignores thresholds and exit numbers", () => {
  const one = ctSpecSchema.parse(spec(CT_ENGINE));
  assert.deepEqual(ctFreedom(one), { conditions: 1, exit: 3, other: 0, total: 4 });
  const rich = ctSpecSchema.parse(
    spec(CT_ENGINE, {
      stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ unit: "atr" }), cond({ feature: "day_range_position", op: "lte", value: 0.2 })] }],
      entry: { entryWindows: [{ fromMinute: 0, toMinute: 60 }], noEntryBeforeDayEndMinutes: 30 },
      exit: managed({ breakeven: { triggerR: 1, offsetPct: 0.1 }, trail: { type: "pct", value: 0.5, activateR: 2 }, timeStop: { bars: 20, minR: 0.5 } }),
    }),
  );
  const f = ctFreedom(rich);
  assert.equal(f.conditions, 2);
  assert.equal(f.exit, 1 + 1 + 2 + 2 + 2 + 1, "stop, target, breakeven+offset, trail, timeStop, maxHold");
  assert.equal(f.other, 2 + 1 + 1, "window ends, day-end guard, one atr unit");
  assert.equal(f.total, f.conditions + f.exit + f.other);

  const s = (c, windows = false) => ctTestSignature([{ conditions: c }], windows);
  const a = s([cond({ value: -0.5 })]);
  assert.equal(a, s([cond({ value: -2, lookback: 2 })]), "threshold variant = same test");
  assert.equal(s([cond({ feature: "return_pct", lookback: 5 }), cond()]), s([cond(), cond({ feature: "return_pct", lookback: 30, value: 9 })]), "order and lookback do not matter");
  assert.notEqual(a, s([cond({ feature: "day_open_distance_pct" })]), "another feature = another test");
  assert.notEqual(a, s([cond({ op: "gte" })]), "the opposite direction is another hypothesis");
  assert.notEqual(a, s([cond({ unit: "atr" })]), "ATR unit is another test");
  assert.notEqual(a, s([cond()], true), "a time window is another test");
  assert.notEqual(ctTestSignature([{ conditions: [cond()] }, { conditions: [cond({ feature: "return_pct", lookback: 5 })] }]), s([cond(), cond({ feature: "return_pct", lookback: 5 })]), "stages differ from one stage");
});

test("the multiple-testing ledger counts distinct hypotheses and every call", () => {
  const ct = {};
  assert.deepEqual(ctTestLedger(ct).hypothesisTests, 0);
  const a = ctTestSignature([{ conditions: [cond()] }]),
    b = ctTestSignature([{ conditions: [cond({ feature: "day_open_distance_pct" })] }]);
  ctRecordTest(ct, a);
  ctRecordTest(ct, a);
  ctRecordTest(ct, b);
  assert.equal(ctTestLedger(ct).hypothesisTests, 2);
  assert.equal(ctTestLedger(ct).toolCalls, 3);
});

/* ---------------------------------------------------------------- features */

/** Typical price × volume VWAP over [from, to) of the bars, by hand. */
function vwapOf(bars) {
  let pv = 0,
    v = 0;
  for (const b of bars) {
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  return pv / v;
}
const crypto4 = walk(21, DAY0, 4 * 1440, 100, 0.001);
const at = (day, h = 0, m = 0) => DAY0 + day * DAY + h * HOUR + m * MIN;
const barsUpTo = (bars, ms) => bars.filter((b) => b.endMs <= ms);

test("VWAP, day open and the day's range restart at 00:00 UTC and use only that day's closed bars", () => {
  const now = at(1, 0, 5); // 5 minutes into day 2
  const dayBars = crypto4.filter((b) => b.startMs >= at(1) && b.endMs <= now);
  assert.equal(dayBars.length, 5);
  const close = dayBars.at(-1).close;
  const c = carrier(cond());
  const v = ctFeature(cond(), crypto4, now, ctx(c, crypto4));
  assert.ok(Math.abs(v - (close / vwapOf(dayBars) - 1) * 100) < 1e-9, "VWAP of day 2's five bars, nothing from day 1");
  const open = ctFeature(cond({ feature: "day_open_distance_pct" }), crypto4, now, ctx(carrier(cond({ feature: "day_open_distance_pct" })), crypto4));
  assert.ok(Math.abs(open - (close / dayBars[0].open - 1) * 100) < 1e-9);
  const pos = ctFeature(cond({ feature: "day_range_position" }), crypto4, now, ctx(carrier(cond({ feature: "day_range_position" })), crypto4));
  const hi = Math.max(...dayBars.map((b) => b.high)),
    lo = Math.min(...dayBars.map((b) => b.low));
  assert.ok(Math.abs(pos - (close - lo) / (hi - lo)) < 1e-9);
  // the very first bar of a day: VWAP is that bar alone
  const first = at(2, 0, 1);
  const f = ctFeature(cond(), crypto4, first, ctx(c, crypto4)),
    b = crypto4.find((x) => x.endMs === first);
  assert.ok(Math.abs(f - (b.close / ((b.high + b.low + b.close) / 3) - 1) * 100) < 1e-9);
});

test("a day with a missing minute has no VWAP, day open or day range from that point; the next day is fine", () => {
  const holey = crypto4.filter((b) => b.startMs !== at(1, 3, 0));
  const c = carrier(cond());
  assert.notEqual(ctFeature(cond(), holey, at(1, 2, 59), ctx(c, holey)), null, "before the hole");
  assert.equal(ctFeature(cond(), holey, at(1, 3, 1), ctx(c, holey)), null, "the day is broken after the hole");
  assert.equal(ctFeature(cond(), holey, at(1, 20), ctx(c, holey)), null);
  assert.notEqual(ctFeature(cond(), holey, at(2, 0, 30), ctx(c, holey)), null, "next day recovers");
  // a day that does not start at the day start cannot give a day open
  const late = crypto4.filter((b) => !(b.startMs >= at(1) && b.startMs < at(1, 0, 10)));
  assert.equal(ctFeature(cond({ feature: "day_open_distance_pct" }), late, at(1, 1), ctx(carrier(cond({ feature: "day_open_distance_pct" })), late)), null);
});

test("opening range: first N minutes of the day, null until complete, breakout reads outside 0..1", () => {
  const or = cond({ feature: "opening_range_position", lookback: 30, op: "gte", value: 0 });
  const c = carrier(or);
  const x = ctx(c, crypto4);
  assert.equal(ctFeature(or, crypto4, at(1, 0, 29), x), null, "29 minutes done: not complete");
  const day = crypto4.filter((b) => b.startMs >= at(1) && b.startMs < at(1, 0, 30));
  const hi = Math.max(...day.map((b) => b.high)),
    lo = Math.min(...day.map((b) => b.low));
  const later = crypto4.find((b) => b.endMs === at(1, 3));
  assert.ok(Math.abs(ctFeature(or, crypto4, at(1, 3), x) - (later.close - lo) / (hi - lo)) < 1e-9);
  // construct a breakout: a closing price above the opening range high reads > 1
  const up = crypto4.map((b) => (b.endMs === at(1, 2) ? { ...b, close: hi * 1.01, high: hi * 1.02 } : b));
  assert.ok(ctFeature(or, up, at(1, 2), ctx(c, up)) > 1);
  // the range of day 2 is not the range of day 3
  assert.equal(ctFeature(or, crypto4, at(2, 0, 29), x), null);
});

test("previous-day levels come from the last complete day only; day one, a holey day and a missing day have none", () => {
  const highs = { high: cond({ feature: "prev_day_high_distance_pct" }), low: cond({ feature: "prev_day_low_distance_pct" }), close: cond({ feature: "prev_day_close_distance_pct" }) };
  const day1 = crypto4.filter((b) => b.startMs >= at(0) && b.startMs < at(1));
  const price = crypto4.find((b) => b.endMs === at(1, 6)).close;
  for (const [key, c] of Object.entries(highs)) {
    const v = ctFeature(c, crypto4, at(1, 6), ctx(carrier(c), crypto4));
    const ref = key === "high" ? Math.max(...day1.map((b) => b.high)) : key === "low" ? Math.min(...day1.map((b) => b.low)) : day1.at(-1).close;
    assert.ok(Math.abs(v - (price / ref - 1) * 100) < 1e-9, `prev day ${key}`);
    assert.equal(ctFeature(c, crypto4, at(0, 6), ctx(carrier(c), crypto4)), null, "no previous day on day one");
  }
  const c = highs.high;
  const holey = crypto4.filter((b) => b.startMs !== at(0, 12, 0));
  assert.equal(ctFeature(c, holey, at(1, 6), ctx(carrier(c), holey)), null, "yesterday has a missing minute");
  assert.notEqual(ctFeature(c, holey, at(2, 6), ctx(carrier(c), holey)), null, "day 3 reads day 2");
  const noDay = crypto4.filter((b) => !(b.startMs >= at(1) && b.startMs < at(2)));
  assert.equal(ctFeature(c, noDay, at(2, 6), ctx(carrier(c), noDay)), null, "day 2 absent: day 1 is not 'the day before'");
  // today's own bars never change it
  const poisoned = crypto4.map((b) => (b.startMs >= at(1) ? { ...b, high: b.high * 5 } : b));
  assert.equal(ctFeature(c, poisoned, at(1, 6), ctx(carrier(c), poisoned)) !== null, true);
  const base = ctFeature(c, crypto4, at(1, 6), ctx(carrier(c), crypto4)),
    cmp = ctFeature(c, poisoned.map((b) => ({ ...b, close: crypto4.find((o) => o.startMs === b.startMs).close })), at(1, 6), ctx(carrier(c), poisoned));
  assert.equal(cmp, base, "yesterday's high is yesterday's, whatever today did");
});

/** Poison everything at or after `from` and the result at `now` must not move. */
function futureInvariant(label, c, bars, times, market = "crypto", symbol = "BTCUSDT") {
  const s = carrier(c, market, symbol);
  for (const now of times) {
    const known = barsUpTo(bars, now);
    const asOf = ctFeature(c, known, now, ctx(s, known, symbol)),
      full = ctFeature(c, bars, now, ctx(s, bars, symbol)),
      poisoned = bars.map((b) => (b.endMs > now ? { ...b, open: b.open * 3, high: b.high * 4, low: b.low * 0.2, close: b.close * 2, volume: b.volume * 9 } : b));
    const withBad = ctFeature(c, poisoned, now, ctx(s, poisoned, symbol));
    assert.equal(full, asOf, `${label}: later bars changed the value at ${new Date(now).toISOString()}`);
    assert.equal(withBad, asOf, `${label}: poisoned future changed the value at ${new Date(now).toISOString()}`);
  }
}

test("every new feature and the ATR unit are future-invariant (value at t is the same with or without later bars)", () => {
  const times = [at(1, 0, 40), at(1, 3, 7), at(1, 11, 33), at(2, 0, 1), at(2, 18, 5), at(2, 23, 59), at(3, 6)];
  const all = [
    cond({ feature: "vwap_distance_pct" }),
    cond({ feature: "day_open_distance_pct" }),
    cond({ feature: "day_range_position" }),
    cond({ feature: "opening_range_position", lookback: 45 }),
    cond({ feature: "prev_day_high_distance_pct" }),
    cond({ feature: "prev_day_low_distance_pct" }),
    cond({ feature: "prev_day_close_distance_pct" }),
    cond({ feature: "atr_pct", lookback: 14 }),
    cond({ feature: "atr_pct", lookback: 14, timeframe: 60 }),
    cond({ feature: "atr_pct", lookback: 5, timeframe: 1440 }),
    cond({ feature: "atr_percentile", lookback: 30, atrLookback: 14 }),
    cond({ feature: "atr_percentile", lookback: 6, atrLookback: 4, timeframe: 60 }),
    cond({ feature: "return_pct", lookback: 5, unit: "atr" }),
    cond({ feature: "return_pct", lookback: 5, unit: "atr", atrTimeframe: 60, atrLookback: 10 }),
    cond({ feature: "vwap_distance_pct", unit: "atr", atrTimeframe: 1440, atrLookback: 2 }),
    cond({ feature: "prior_high_distance_pct", lookback: 8, timeframe: 60, unit: "atr" }),
  ];
  for (const c of all) futureInvariant(`${c.feature}/${c.timeframe}${c.unit ? "/atr" : ""}`, c, crypto4, times);
});

test("level features are future-invariant for stocks too, across sessions, a weekend and an early close", () => {
  // Fri 2025-11-21, Mon 11-24, Tue 11-25, Wed 11-26, Fri 11-28 (early close 13:00)
  const dates = ["2025-11-21", "2025-11-24", "2025-11-25", "2025-11-26", "2025-11-28"];
  const bars = dates.flatMap((d, i) => {
    const close = d === "2025-11-28" ? "13:00" : "16:00";
    const open = easternWallTimeToEpoch(d, "09:30"),
      n = (easternWallTimeToEpoch(d, close) - open) / MIN;
    return walk(30 + i, open, n, 100 + i, 0.001);
  });
  const times = [
    easternWallTimeToEpoch("2025-11-24", "09:31"),
    easternWallTimeToEpoch("2025-11-24", "10:30"),
    easternWallTimeToEpoch("2025-11-26", "15:59"),
    easternWallTimeToEpoch("2025-11-28", "12:59"),
  ];
  for (const f of ["vwap_distance_pct", "day_open_distance_pct", "day_range_position", "prev_day_high_distance_pct", "prev_day_close_distance_pct"])
    futureInvariant(`stock ${f}`, cond({ feature: f }), bars, times, "stock", "SPY");
  futureInvariant("stock opening range", cond({ feature: "opening_range_position", lookback: 30 }), bars, times, "stock", "SPY");
  futureInvariant("stock atr daily", cond({ feature: "atr_pct", lookback: 2, timeframe: 1440 }), bars, times, "stock", "SPY");
});

test("stock levels: the session resets at the open, an early close ends the day early, Monday's previous day is Friday", () => {
  const day = (d) => {
    const close = d === "2025-11-28" ? "13:00" : "16:00";
    const open = easternWallTimeToEpoch(d, "09:30");
    return walk(Number(d.slice(8)), open, (easternWallTimeToEpoch(d, close) - open) / MIN, 100, 0.001);
  };
  const bars = ["2025-11-21", "2025-11-24", "2025-11-25", "2025-11-26", "2025-11-28"].flatMap(day);
  const s = (c) => carrier(c, "stock", "SPY");
  const vwap = cond({ feature: "vwap_distance_pct" });
  const monOpen = easternWallTimeToEpoch("2025-11-24", "09:30");
  const five = bars.filter((b) => b.startMs >= monOpen && b.endMs <= monOpen + 5 * MIN);
  const v = ctFeature(vwap, bars, monOpen + 5 * MIN, ctx(s(vwap), bars, "SPY"));
  assert.ok(Math.abs(v - (five.at(-1).close / vwapOf(five) - 1) * 100) < 1e-9, "Monday's VWAP starts at Monday's open");
  const prevHigh = cond({ feature: "prev_day_high_distance_pct" });
  const fri = bars.filter((b) => b.endMs <= monOpen);
  const friHigh = Math.max(...fri.filter((b) => b.startMs >= easternWallTimeToEpoch("2025-11-21", "09:30")).map((b) => b.high));
  const pv = ctFeature(prevHigh, bars, monOpen + 5 * MIN, ctx(s(prevHigh), bars, "SPY"));
  assert.ok(Math.abs(pv - (five.at(-1).close / friHigh - 1) * 100) < 1e-9, "the weekend is bridged: Monday's previous day is Friday");
  // Early close: the session's last closed bar is 12:59–13:00 and the day range is defined there
  const rangePos = cond({ feature: "day_range_position" });
  assert.notEqual(ctFeature(rangePos, bars, easternWallTimeToEpoch("2025-11-28", "13:00"), ctx(s(rangePos), bars, "SPY")), null);
  // A skipped session (not a holiday) is not bridged: Wednesday absent, Friday has no previous day
  const noWed = bars.filter((b) => !(b.startMs >= easternWallTimeToEpoch("2025-11-26", "09:30") && b.startMs < easternWallTimeToEpoch("2025-11-26", "16:00")));
  assert.equal(ctFeature(prevHigh, noWed, easternWallTimeToEpoch("2025-11-28", "10:00"), ctx(s(prevHigh), noWed, "SPY")), null);
});

test("stock previous-day levels never cross a split (NVDA 2024-06-10)", () => {
  const dates = ["2024-06-06", "2024-06-07", "2024-06-10", "2024-06-11"];
  const bars = dates.flatMap((d, i) => {
    const open = easternWallTimeToEpoch(d, "09:30");
    return walk(40 + i, open, 390, d < "2024-06-10" ? 1200 : 120, 0.001);
  });
  const c = cond({ feature: "prev_day_close_distance_pct" });
  const s = carrier(c, "stock", "NVDA");
  const at1 = (d, t) => easternWallTimeToEpoch(d, t);
  assert.notEqual(ctFeature(c, bars, at1("2024-06-07", "10:00"), ctx(s, bars, "NVDA")), null, "Friday reads Thursday (same side of the split)");
  assert.equal(ctFeature(c, bars, at1("2024-06-10", "10:00"), ctx(s, bars, "NVDA")), null, "the first session after the split has no comparable previous day");
  assert.notEqual(ctFeature(c, bars, at1("2024-06-11", "10:00"), ctx(s, bars, "NVDA")), null, "the next one reads the split day");
});

test("unit atr and the ATR features equal the hand-computed definition", () => {
  // hourly ATR(2) as percent of close at 05:00 = mean TR of hours 3 and 4 / close of hour 4
  const hours = [];
  const hourBars = (h) => crypto4.filter((b) => b.startMs >= DAY0 + h * HOUR && b.endMs <= DAY0 + (h + 1) * HOUR);
  for (let h = 0; h <= 5; h++) {
    const rows = hourBars(h);
    hours.push({ open: rows[0].open, close: rows.at(-1).close, high: Math.max(...rows.map((b) => b.high)), low: Math.min(...rows.map((b) => b.low)) });
  }
  const tr = (i) => Math.max(hours[i].high - hours[i].low, Math.abs(hours[i].high - hours[i - 1].close), Math.abs(hours[i].low - hours[i - 1].close));
  const now = DAY0 + 5 * HOUR;
  const atr2 = ((tr(4) + tr(3)) / 2 / hours[4].close) * 100;
  const c = cond({ feature: "atr_pct", lookback: 2, timeframe: 60 });
  assert.ok(Math.abs(ctFeature(c, crypto4, now, ctx(carrier(c), crypto4)) - atr2) < 1e-9, "atr_pct = mean TR / close × 100");
  // return over 4 hourly bars divided by that ATR
  const r = cond({ feature: "return_pct", lookback: 3, timeframe: 60, unit: "atr", atrLookback: 2 });
  const raw = (hours[4].close / hours[1].close - 1) * 100;
  assert.ok(Math.abs(ctFeature(r, crypto4, now, ctx(carrier(r), crypto4)) - raw / atr2) < 1e-9, "unit atr = percent / ATR percent, ATR of the same timeframe");
  // atrTimeframe 60 on a 1-minute condition: the same hourly ATR as the normaliser
  const m = cond({ feature: "return_pct", lookback: 5, unit: "atr", atrTimeframe: 60, atrLookback: 2 });
  const minuteRaw = ctFeature(cond({ feature: "return_pct", lookback: 5 }), crypto4, now, ctx(carrier(cond({ feature: "return_pct", lookback: 5 })), crypto4));
  assert.ok(Math.abs(ctFeature(m, crypto4, now, ctx(carrier(m), crypto4)) - minuteRaw / atr2) < 1e-9);
  // percentile: share of earlier ATR values at or below the current one
  const p = cond({ feature: "atr_percentile", lookback: 3, timeframe: 60, atrLookback: 2 });
  const atrAt = (e) => (tr(e) + tr(e - 1)) / 2 / hours[e].close;
  const cur = atrAt(4),
    before = [atrAt(2), atrAt(3)];
  assert.equal(ctFeature(p, crypto4, now, ctx(carrier(p), crypto4)), before.filter((a) => a <= cur).length / before.length);
});

test("entry windows: both ends included, judged at the signal bar's close, per day start (crypto UTC, stock open)", () => {
  const w = [{ fromMinute: 60, toMinute: 120 }];
  const rule = ctSpecSchema.parse(spec(CT_ENGINE, { entry: { entryWindows: w } }));
  const blocked = (ms) => ctEntryBlocked(rule, "crypto", ms);
  assert.equal(blocked(at(1, 0, 59)), true, "minute 59: before");
  assert.equal(blocked(at(1, 1, 0)), false, "minute 60: first minute inside");
  assert.equal(blocked(at(1, 2, 0)), false, "minute 120: last minute inside");
  assert.equal(blocked(at(1, 2, 1)), true, "minute 121: after");
  assert.equal(blocked(at(2, 1, 30)), false, "every UTC day has the same window");
  assert.equal(ctEntryBlocked(rule, "crypto", at(1, 0, 59), true), false, "ignoreWindows leaves the rest of the rule");
  // two windows
  const two = [{ fromMinute: 0, toMinute: 10 }, { fromMinute: 300, toMinute: 310 }];
  assert.equal(ctInEntryWindow(two, "crypto", at(1, 0, 1)), true);
  assert.equal(ctInEntryWindow(two, "crypto", at(1, 3)), false);
  assert.equal(ctInEntryWindow(two, "crypto", at(1, 5, 5)), true);
  // stock: minutes since the 09:30 open; the first thirty minutes = decisions closing at 09:31 … 10:00
  const open = ctSpecSchema.parse(spec(CT_ENGINE, { market: "stock", symbols: ["SPY"], entry: { entryWindows: [{ fromMinute: 0, toMinute: 30 }] } }));
  const t = (d, hhmm) => easternWallTimeToEpoch(d, hhmm);
  assert.equal(ctEntryBlocked(open, "stock", t("2025-11-24", "09:31")), false);
  assert.equal(ctEntryBlocked(open, "stock", t("2025-11-24", "10:00")), false, "minute 30 included");
  assert.equal(ctEntryBlocked(open, "stock", t("2025-11-24", "10:01")), true);
  // early-close day: the window is anchored at the open, the day just ends sooner
  assert.equal(ctEntryBlocked(open, "stock", t("2025-11-28", "09:45")), false);
  assert.equal(ctEntryBlocked(open, "stock", t("2025-11-28", "12:30")), true);
  // outside any session: nothing to enter
  assert.equal(ctInEntryWindow([{ fromMinute: 0, toMinute: 389 }], "stock", t("2025-11-27", "10:00")), false, "Thanksgiving");
});

test("replay: with an entry window no trade is opened outside it, and without one the same rule trades there", () => {
  const bars = walk(77, DAY0, 3 * 1440, 100, 0.0015);
  const contract = { ...contractFor("crypto", DAY0, 3), engine: CT_ENGINE };
  const base = (entry = {}) =>
    ctSpecSchema.parse(
      spec(CT_ENGINE, {
        stages: [{ label: "stage one", maxGapBars: 1, conditions: [cond({ feature: "return_pct", lookback: 5, op: "lte", value: -0.12 })] }],
        entry,
        exit: { stopPct: 0.5, targetPct: 0.6, maxHoldBars: 120, invalidation: "stop" },
      }),
    );
  const free = replayCT(base(), { BTCUSDT: bars }, contract, DAY0, DAY0 + 3 * DAY, "h");
  const windowed = replayCT(base({ entryWindows: [{ fromMinute: 360, toMinute: 600 }] }), { BTCUSDT: bars }, contract, DAY0, DAY0 + 3 * DAY, "h");
  assert.ok(free.trades.length > 10);
  assert.ok(windowed.trades.length > 0 && windowed.trades.length < free.trades.length);
  for (const t of windowed.trades) {
    const minute = (t.signal.decidedAt - Math.floor((t.signal.decidedAt - 1) / DAY) * DAY) / MIN;
    assert.ok(minute >= 360 && minute <= 600, `signal at minute ${minute} is inside the window`);
  }
  assert.ok(free.trades.some((t) => {
    const minute = (t.signal.decidedAt - Math.floor((t.signal.decidedAt - 1) / DAY) * DAY) / MIN;
    return minute < 360 || minute > 600;
  }), "the unwindowed rule does trade outside it");
});

test("history window covers the ATR and percentile windows of the spec", () => {
  const small = ctSpecSchema.parse(spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "return_pct", lookback: 5 })] }] }));
  const big = ctSpecSchema.parse(spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "atr_percentile", lookback: 100, atrLookback: 50, op: "gte", value: 0.9 })] }] }));
  assert.ok(ctHistoryBars(big) >= (100 + 50 - 1 + 3) * 1, "atr_percentile reads lookback + atrLookback bars");
  assert.equal(ctHistoryBars(small), 121, "classic windows: unchanged");
  const unit = ctSpecSchema.parse(spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "return_pct", lookback: 5, unit: "atr", atrTimeframe: 12, atrLookback: 100 })] }] }));
  assert.ok(ctHistoryBars(unit) >= (100 + 3) * 12);
  assert.ok(detectCT && true);
});

test("the progress screen names the new options and counts the run's hypothesis tests", async () => {
  const { queryFeatures, sessionProgress } = await import("../lib/ct-activity.ts");
  const q = { query: { stages: [{ conditions: [{ feature: "vwap_distance_pct", timeframe: 1 }, { feature: "return_pct", timeframe: 60, unit: "atr" }] }], entryWindows: [{ fromMinute: 0, toMinute: 30 }], exitCompare: {} } };
  assert.equal(queryFeatures(q), "vwap_distance_pct · return_pct(60분)[ATR] · 시간 창 · 청산 구조 비교");
  assert.equal(queryFeatures({ query: { stages: [{ conditions: [{ feature: "return_pct", timeframe: 3 }] }] } }), "return_pct(3분)", "old queries read as before");
  const ct = { contract: { policy: {} }, sessions: [{ index: 0, turns: 2, toolCalls: 3, screens: 1 }], queries: [], tests: { signatures: { a: 2, b: 1 } } };
  assert.match(sessionProgress(ct), /조회 0 · 사전 검사 1 · 가설 검정 2회$/);
  assert.doesNotMatch(sessionProgress({ ...ct, tests: undefined }), /가설 검정/);
});

test("live warm-up covers ATR windows on higher timeframes and keeps its old answer for old rules", async () => {
  const { ctWarmupDays } = await import("../lib/ct-warmup.ts");
  const classic = ctSpecSchema.parse(spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "return_pct", lookback: 5 })] }] }));
  assert.equal(ctWarmupDays([classic]), 7);
  const daily = ctSpecSchema.parse(spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "return_pct", lookback: 5, unit: "atr", atrTimeframe: 1440, atrLookback: 20 })] }] }));
  assert.ok(ctWarmupDays([daily]) > 20, `daily ATR(20) needs weeks of history, got ${ctWarmupDays([daily])}`);
  const hourlyCondition = ctSpecSchema.parse(spec(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ feature: "return_pct", lookback: 29, timeframe: 1440, offset: 0 })] }] }));
  assert.equal(ctWarmupDays([hourlyCondition]), Math.max(7, Math.ceil(((29 + 0 + 2) * 7) / 5) + 3), "higher-timeframe conditions: same formula as before");
});
