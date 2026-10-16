// Free bars (traderTools 4, 2026-10-16): the contract holds one-minute data; each candidate and each measurement
// chooses the bar it runs on, and the ledger counts the bar. One-minute behaviour must not move.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { buildHigherSeries } from "../lib/ct-timeframes.ts";
import { ctFeature, replayCT, ctDayClosing, ctCryptoDayClosing, ctSessionClosing, ctEntryBlocked, ctBarsAt } from "../lib/ct-engine.ts";
import { buildDayLevels } from "../lib/ct-levels.ts";
import { validateCTSpec, ctTestSignature, ctBarAllowed, CT_ENGINE, CT_ENGINE_V1 } from "../lib/ct-spec.ts";
import { ctParseSignature } from "../lib/ct-families.ts";
import { ctQueryReturns } from "../lib/ct-design-tools.ts";
import { ctRunLabels, ctLabelMovesSchemaBars } from "../lib/ct-trader-tools.ts";
import { ctChartData } from "../lib/ct-chart-image.ts";
import { walk, stockWalk, contractFor } from "./helpers/ct-golden-cases.mjs";

const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR,
  DAY0 = Date.UTC(2026, 0, 5);
const at = (day, h = 0, m = 0) => DAY0 + day * DAY + h * HOUR + m * MIN;

/** Epoch-grid N-minute bars from complete minutes only (what the local store serves for `minutes: N`). */
function agg(bars, n) {
  const size = n * MIN,
    groups = new Map();
  for (const b of bars) {
    const k = Math.floor(b.startMs / size) * size;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(b);
  }
  return [...groups]
    .filter(([k, g]) => g.length === n && g.every((b, i) => b.startMs === k + i * MIN))
    .map(([k, g]) => ({
      startMs: k,
      endMs: k + size,
      open: g[0].open,
      close: g.at(-1).close,
      high: Math.max(...g.map((b) => b.high)),
      low: Math.min(...g.map((b) => b.low)),
      volume: g.reduce((s, b) => s + b.volume, 0),
    }))
    .sort((a, b) => a.startMs - b.startMs);
}
const spec = (minutes, over = {}) => ({
  version: 1,
  engine: CT_ENGINE,
  name: "bar size fixture",
  market: "crypto",
  symbols: ["BTCUSDT"],
  minutes,
  stages: [{ label: "stage one", maxGapBars: 1, conditions: [{ feature: "prior_high_distance_pct", lookback: 3, offset: 0, timeframe: 1, op: "gte", value: -100 }] }],
  entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
  exit: { stopPct: 15, targetPct: 40, maxHoldBars: 1440, invalidation: "stop" },
  sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 1, participationPct: 1 },
  sourceIds: ["g"],
  assumptions: ["bar size fixture"],
  ...over,
});
/** A contract whose data is `minutes` bars. traderTools 4 = free bars; 3 = stage 5 (the spec must match the data). */
const contract = (minutes, market = "crypto", traderTools = 4) => {
  const c = contractFor(market, DAY0, 10);
  return { ...c, engine: CT_ENGINE, minutes, policy: { ...c.policy, traderTools } };
};

test("free bars: a candidate chooses its bar over one-minute data; stage-5 contracts and other sizes are refused", () => {
  const free = contract(1);
  for (const m of [1, 5, 15, 60]) assert.doesNotThrow(() => validateCTSpec(spec(m), free, ["g"]), `crypto ${m}`);
  assert.throws(() => validateCTSpec(spec(15), contract(1, "crypto", 3), ["g"]), /주기/);
  assert.throws(() => validateCTSpec({ ...spec(3) }, free, ["g"]));
  assert.equal(ctBarAllowed(free, 15), true);
  assert.equal(ctBarAllowed(contract(1, "stock"), 60), false);
  assert.equal(ctBarAllowed(contract(1, "stock"), 15), true);
  assert.equal(ctBarAllowed(contract(1, "crypto", 3), 15), false);
  // A contract frozen on 15-minute data (ct-pattern-1 packages) cannot rebuild other bars from it.
  assert.equal(ctBarAllowed(contract(15), 5), false);
});

test("ctBarsAt: complete minutes on the clock grid, a missing minute drops its bar, cached, one-minute input passes through", () => {
  const m1 = walk(5, at(0, 0, 3), 200, 100, 0.0006, (s) => s === at(0, 1, 7));
  const m15 = ctBarsAt(m1, 15);
  assert.deepEqual(m15, agg(m1, 15));
  assert.equal(m15[0].startMs, at(0, 0, 15), "the partial first quarter-hour is not a bar");
  assert.equal(m15.some((b) => b.startMs === at(0, 1)), false, "the quarter-hour with a missing minute is not a bar");
  assert.equal(ctBarsAt(m1, 15), m15, "same array object on a second call");
  assert.equal(ctBarsAt(m1, 1), m1);
  assert.equal(ctBarsAt(m15, 15), m15);
  assert.throws(() => ctBarsAt(m15, 5));
});

test("day end: the last tradable bar closes one bar before the day ends, whatever the bar size", () => {
  // Crypto 15-minute bars: the bar closing 23:45 is the last one; one-minute keeps 23:59.
  assert.equal(ctCryptoDayClosing(at(0, 23, 45), 15), true);
  assert.equal(ctCryptoDayClosing(at(0, 23, 30), 15), false);
  assert.equal(ctCryptoDayClosing(at(1, 0, 0), 15), false);
  assert.equal(ctDayClosing({ engine: CT_ENGINE, minutes: 15 }, "crypto", at(0, 23, 45)), true);
  assert.equal(ctDayClosing({ engine: CT_ENGINE, minutes: 1 }, "crypto", at(0, 23, 45)), false);
  assert.equal(ctDayClosing({ engine: CT_ENGINE }, "crypto", at(0, 23, 59)), true, "no minutes = the one-minute rule");
  assert.equal(ctDayClosing({ engine: CT_ENGINE, minutes: 60 }, "crypto", at(0, 23)), true);
  // Stocks (EST in January: close 16:00 = 21:00 UTC).
  const est = (h, m) => Date.parse(`2026-01-06T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-05:00`);
  assert.equal(ctSessionClosing(est(15, 45), 15), true);
  assert.equal(ctSessionClosing(est(15, 30), 15), false);
  assert.equal(ctDayClosing({ engine: CT_ENGINE, minutes: 15 }, "stock", est(15, 45)), true);
  // ct-pattern-1 stock packages on 15-minute bars keep the historical one-minute rule (the 16:00 bar).
  assert.equal(ctDayClosing({ engine: CT_ENGINE_V1, minutes: 15 }, "stock", est(15, 45)), false);
  assert.equal(ctDayClosing({ engine: CT_ENGINE_V1, minutes: 15 }, "stock", est(16, 0)), true);
  assert.equal(ctEntryBlocked({ engine: CT_ENGINE, minutes: 15, entry: {} }, "crypto", at(0, 23, 45)), true);
  assert.equal(ctEntryBlocked({ engine: CT_ENGINE, minutes: 15, entry: {} }, "crypto", at(0, 23, 30)), false);
});

test("higher timeframes from 15-minute bars equal the ones built from minutes (crypto and stock)", () => {
  const crypto1 = walk(11, at(0), 4 * 1440);
  for (const tf of [60, 240, 1440]) {
    const a = buildHigherSeries(crypto1, tf, "crypto"),
      b = buildHigherSeries(agg(crypto1, 15), tf, "crypto");
    assert.deepEqual(b.bars, a.bars, `crypto ${tf}`);
    assert.deepEqual([...b.brokenPrefix], [...a.brokenPrefix]);
  }
  const stock1 = stockWalk(12, DAY0, 6);
  for (const tf of [60, 1440]) {
    const a = buildHigherSeries(stock1, tf, "stock", "SPY"),
      b = buildHigherSeries(agg(stock1, 15), tf, "stock", "SPY");
    assert.ok(a.bars.length > 0);
    assert.deepEqual(b.bars, a.bars, `stock ${tf}`);
  }
  // A missing minute still breaks the hour it falls in, through the coarser bar.
  const gap = walk(11, at(0), 1440, 100, 0.0006, (s) => s === at(0, 5, 7));
  const hours = buildHigherSeries(agg(gap, 15), 60, "crypto").bars;
  assert.equal(hours.some((b) => b.startMs === at(0, 5)), false);
  assert.equal(hours.length, 23);
});

test("opening range on 15-minute bars covers the same minutes as on one-minute bars", () => {
  const m1 = walk(21, at(0), 3 * 1440),
    m15 = agg(m1, 15);
  const c = { feature: "opening_range_position", lookback: 30, offset: 0, timeframe: 1, op: "gte", value: 0 };
  for (const t of [at(1, 1), at(1, 6, 30), at(2, 12)]) {
    const a = ctFeature(c, m1, t, { market: "crypto", levels: buildDayLevels(m1, "crypto") }),
      b = ctFeature(c, m15, t, { market: "crypto", levels: buildDayLevels(m15, "crypto") });
    assert.ok(a !== null);
    assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  }
  // Before the range is complete there is no value.
  assert.equal(ctFeature(c, m15, at(1, 0, 15), { market: "crypto", levels: buildDayLevels(m15, "crypto") }), null);
  // The spec refuses a range that is not whole bars, and 60-minute stock bars.
  const bad = spec(15, { stages: [{ label: "stage one", maxGapBars: 1, conditions: [{ ...c, lookback: 20 }] }] });
  assert.throws(() => validateCTSpec(bad, contract(15), ["g"]), /배수/);
  assert.doesNotThrow(() => validateCTSpec(spec(15, { stages: [{ label: "stage one", maxGapBars: 1, conditions: [c] }] }), contract(15), ["g"]));
  const stock = { ...spec(60), market: "stock", symbols: ["NVDA"], exit: { stopPct: 15, targetPct: 40, maxHoldBars: 6, invalidation: "stop" } };
  assert.throws(() => validateCTSpec(stock, contract(60, "stock"), ["g"]), /1\/5\/15/);
});

test("backtest on 15-minute bars: next-bar entries, counts in bars, never across the UTC day", () => {
  const m1 = walk(31, at(0), 5 * 1440),
    m15 = agg(m1, 15);
  const r = replayCT(spec(15), { BTCUSDT: m15 }, contract(15), at(0), at(5), "h");
  // The same rule over the contract's one-minute data builds the same bars itself: the same result.
  assert.deepEqual(replayCT(spec(15), { BTCUSDT: m1 }, contract(1), at(0), at(5), "h"), r);
  assert.ok(r.trades.length >= 3);
  for (const t of r.trades) {
    assert.equal((t.entryAt - DAY0) % (15 * MIN), 0, "entries on the 15-minute grid");
    assert.equal(Math.floor(t.entryAt / DAY), Math.floor((t.exitAt - 1) / DAY), "no trade spans midnight");
    assert.equal(t.reason, "day_end");
    assert.equal(t.exitAt % DAY, DAY - 15 * MIN, "closed on the bar closing 23:45 UTC");
  }
  // maxHoldBars counts 15-minute bars: 4 bars = one hour.
  const short = replayCT(spec(15, { exit: { stopPct: 15, targetPct: 40, maxHoldBars: 4, invalidation: "stop" } }), { BTCUSDT: m15 }, contract(15), at(0), at(5), "h");
  assert.ok(short.trades.some((t) => t.reason === "time"));
  for (const t of short.trades.filter((x) => x.reason === "time")) assert.equal(t.exitAt - t.entryAt, 4 * 15 * MIN);
});

test("measurements on a chosen bar equal the same measurement on data of that bar", () => {
  const m1 = walk(51, at(0), 6 * 1440),
    m15 = agg(m1, 15);
  const c1 = contract(1),
    c15 = contract(15);
  const query = { stages: [{ maxGapBars: 1, conditions: [{ feature: "return_pct", lookback: 4, offset: 0, timeframe: 1, op: "lte", value: -0.05 }] }], horizons: [4, 16], grid: { stopPcts: [0.5], targetPcts: [1] }, cooldownBars: 4 };
  const onBar = ctQueryReturns({ ...query, barMinutes: 15 }, { BTCUSDT: m1 }, c1),
    onData = ctQueryReturns(query, { BTCUSDT: m15 }, c15);
  assert.ok(onBar.events > 0);
  assert.deepEqual(onBar, onData);
  assert.notDeepEqual(ctQueryReturns(query, { BTCUSDT: m1 }, c1).events, onBar.events, "one-minute is a different measurement");
  const params = ctLabelMovesSchemaBars.parse({ barMinutes: 15 });
  const a = ctRunLabels(params, { BTCUSDT: m1 }, c1),
    b = ctRunLabels({ ...params, barMinutes: undefined }, { BTCUSDT: m15 }, c15);
  assert.ok(a[0].events.length > 0);
  assert.deepEqual(a[0].events, b[0].events);
  assert.deepEqual(a[0].rows, b[0].rows);
});

test("the ledger counts the bar: another bar is another test, one-minute keys are unchanged, features still parse", async () => {
  register("./helpers/slot-test-loader.mjs", import.meta.url);
  const { ctLabelKey } = await import("../lib/ct-measured.ts");
  const stages = spec(15).stages;
  const one = ctTestSignature(stages, false),
    fifteen = ctTestSignature(stages, false, 15);
  assert.equal(ctTestSignature(stages, false, 1), one);
  assert.equal(fifteen, `b15:${one}`);
  assert.deepEqual(ctParseSignature(fifteen), ctParseSignature(one));
  assert.equal(ctParseSignature(`diagnose|${fifteen}|hour|09`).uses.length, 1);
  const label = { k: 3, m: 1, horizon: "day_end", costMultiplier: 1 };
  assert.equal(ctLabelKey(label), "k3|m1|hday_end|c1");
  assert.equal(ctLabelKey({ ...label, barMinutes: 1 }), "k3|m1|hday_end|c1");
  assert.equal(ctLabelKey({ ...label, barMinutes: 15 }), "k3|m1|hday_end|c1|b15");
});

test("designer brief and tools: free bars get their own; stage 5 stays as it was", async () => {
  register("./helpers/slot-test-loader.mjs", import.meta.url);
  const research = await import("../lib/ct-research.ts");
  const store = await import("../lib/ct-research-store.ts");
  const free = { policy: contract(1).policy },
    five = { policy: contract(1, "crypto", 3).policy };
  assert.equal(research.ctDesignerSystem(five), research.CT_DESIGNER_SYSTEM_STAGE5);
  assert.equal(research.ctDesignerSystem(free), research.CT_DESIGNER_SYSTEM);
  assert.match(research.CT_DESIGNER_SYSTEM, /nobody told you which chart that trader reads/);
  assert.match(research.CT_DESIGNER_SYSTEM, /never sweep them/);
  assert.equal(research.CT_DESIGNER_SYSTEM.startsWith(research.CT_DESIGNER_SYSTEM_STAGE5.slice(0, 2000)), true);
  assert.equal(store.ctSessionTools(five), store.CT_SESSION_TOOLS_STAGE5);
  assert.equal(store.ctSessionTools(free), store.CT_SESSION_TOOLS);
  const tool = (set, name) => set.find((t) => t.name === name);
  for (const name of ["label_moves", "query_conditional_returns", "read_bars"]) {
    assert.ok(tool(store.CT_SESSION_TOOLS, name).input_schema.properties.barMinutes, name);
    assert.equal(tool(store.CT_SESSION_TOOLS_STAGE5, name).input_schema.properties.barMinutes, undefined, name);
  }
  assert.equal(tool(store.CT_SESSION_TOOLS, "view_charts"), tool(store.CT_SESSION_TOOLS_STAGE5, "view_charts"), "charts are the minute-data picture");
  assert.deepEqual(store.CT_SESSION_TOOLS.map((t) => t.name), store.CT_SESSION_TOOLS_STAGE5.map((t) => t.name));
});

test("charts on 15-minute bars draw every panel; one-minute chart data is unchanged", () => {
  const m1 = walk(41, at(0), 6 * 1440),
    m15 = agg(m1, 15),
    c = contract(15),
    t = at(4, 14);
  const d15 = ctChartData(m15, t, c, "BTCUSDT"),
    d1 = ctChartData(m1, t, contract(1), "BTCUSDT");
  assert.equal(d15.barMinutes, 15);
  assert.equal("barMinutes" in d1, false);
  assert.equal(d15.m5.length, 14 * 4, "today's 15-minute bars up to 14:00");
  assert.ok(d15.m5.every((b) => b.endMs - b.startMs === 15 * MIN));
  assert.equal(d15.m1.length, 90);
  assert.deepEqual(d15.h1, d1.h1, "the hourly panel is the same market");
  assert.deepEqual(d15.openingRange, d1.openingRange);
  assert.deepEqual(d15.prevDay, d1.prevDay);
});

test("playbook files a run under its bar size", async () => {
  // The playbook module reaches D1 through cloudflare:workers; the test loader stubs it.
  register("./helpers/slot-test-loader.mjs", import.meta.url);
  const { ctPlaybookTimeframe } = await import("../lib/ct-playbook.ts");
  assert.equal(ctPlaybookTimeframe({ minutes: 1 }), "1m");
  assert.equal(ctPlaybookTimeframe({ minutes: 15 }), "15m");
});
