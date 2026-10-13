import test from "node:test";
import assert from "node:assert/strict";
import { buildHigherSeries, higherWindow } from "../lib/ct-timeframes.ts";
import { ctFeature, replayCT, detectCT } from "../lib/ct-engine.ts";
import { ctSpecSchema, validateCTSpec, CT_ENGINE, CT_ENGINE_V1 } from "../lib/ct-spec.ts";
import { easternWallTimeToEpoch } from "../lib/market-clock.ts";
import { walk, contractFor } from "./helpers/ct-golden-cases.mjs";

const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY0 = Date.UTC(2026, 0, 5);
const cond = (over) => ({ feature: "return_pct", lookback: 3, offset: 0, timeframe: 60, op: "gte", value: -100, ...over });
const crypto = { market: "crypto", symbol: "BTCUSDT" };

test("an hourly bar that is still forming, or any later bar, cannot change a feature", () => {
  const bars = walk(3, DAY0, 600, 100, 0.001);
  const at = (h, m = 0) => DAY0 + h * HOUR + m * MIN;
  const now = at(5, 30); // 05:30 — the 05:00 hour is incomplete
  const base = ctFeature(cond(), bars, now, crypto);
  assert.notEqual(base, null);
  // Poison the forming hour (05:00–05:30) and everything after now.
  const poisoned = bars.map((b) => (b.startMs >= at(5) ? { ...b, high: b.high * 3, close: b.close * 2, low: b.low * 0.5, open: b.open * 1.5 } : b));
  assert.equal(ctFeature(cond(), poisoned, now, crypto), base);
  // Once the hour closes it is used.
  assert.notEqual(ctFeature(cond(), poisoned, at(6), crypto), ctFeature(cond(), bars, at(6), crypto));
  // The completed-bar series itself ends at the last completed hour.
  const series = buildHigherSeries(bars.filter((b) => b.endMs <= now), 60, "crypto");
  assert.equal(series.bars.at(-1).endMs, at(5));
});

test("an hour with a missing minute is not a bar, and a window across it is unusable", () => {
  const bars = walk(4, DAY0, 600, 100, 0.001).filter((b) => b.startMs !== DAY0 + 3 * HOUR + 20 * MIN);
  const series = buildHigherSeries(bars, 60, "crypto");
  assert.ok(!series.bars.some((b) => b.startMs === DAY0 + 3 * HOUR));
  // Hours 0,1,2 chain; 4,5,... chain; nothing spans the hole.
  assert.notEqual(higherWindow(series, DAY0 + 3 * HOUR, 2, 0), null);
  assert.equal(higherWindow(series, DAY0 + 6 * HOUR, 3, 0), null, "window 2..5 contains the missing hour 3");
  assert.notEqual(higherWindow(series, DAY0 + 9 * HOUR, 3, 0), null);
});

test("the daily bar is the UTC day and needs all 1,440 minutes", () => {
  const bars = walk(6, DAY0, 3 * 1440, 100, 0.001).filter((b) => b.startMs !== DAY0 + 1440 * MIN + 5 * MIN);
  const day = buildHigherSeries(bars, 1440, "crypto");
  assert.deepEqual(day.bars.map((b) => b.startMs), [DAY0, DAY0 + 2 * 1440 * MIN]);
  assert.equal(day.bars[0].endMs, DAY0 + 1440 * MIN);
});

/** Regular-session minutes for one NY date. */
function session(date, price = 100, close = "16:00") {
  const open = easternWallTimeToEpoch(date, "09:30"),
    end = easternWallTimeToEpoch(date, close),
    n = (end - open) / MIN;
  return Array.from({ length: n }, (_, i) => ({
    startMs: open + i * MIN,
    endMs: open + (i + 1) * MIN,
    open: price + i * 0.001,
    high: price + i * 0.001 + 0.02,
    low: price + i * 0.001 - 0.02,
    close: price + (i + 1) * 0.001,
    volume: 5 + (i % 7),
  }));
}

test("stock: hourly/daily bars follow the session grid, early closes end in a short last bar", () => {
  const early = session("2025-11-28", 100, "13:00");
  const hourly = buildHigherSeries(early, 60, "stock", "AAPL");
  assert.deepEqual(hourly.bars.map((b) => (b.endMs - b.startMs) / MIN), [60, 60, 60, 30]);
  assert.equal(hourly.bars[0].startMs, easternWallTimeToEpoch("2025-11-28", "09:30"));
  const four = buildHigherSeries(early, 240, "stock", "AAPL");
  assert.deepEqual(four.bars.map((b) => (b.endMs - b.startMs) / MIN), [210], "09:30–13:00 is one truncated 4-hour bar");
  const daily = buildHigherSeries(early, 1440, "stock", "AAPL");
  assert.equal(daily.bars.length, 1);
  assert.equal(daily.bars[0].endMs, easternWallTimeToEpoch("2025-11-28", "13:00"));
});

test("stock: daily windows bridge the overnight and the weekend, but not a missing session or a split", () => {
  // Wed 2025-01-08, Thu 01-09 (market closed: national day of mourning), Fri 01-10, Mon 01-13.
  const wed = session("2025-01-08"), fri = session("2025-01-10"), mon = session("2025-01-13"), tue = session("2025-01-14");
  const all = [...wed, ...fri, ...mon, ...tue];
  const series = buildHigherSeries(all, 1440, "stock", "AAPL");
  assert.equal(series.bars.length, 4);
  // 01-09 is a closed session in the calendar, so Fri follows Wed directly; Fri→Mon bridges the weekend.
  assert.notEqual(higherWindow(series, tue.at(-1).endMs, 3, 0), null);
  // A session that traded but whose data is missing breaks the chain.
  const holey = buildHigherSeries([...wed, ...session("2025-01-10").slice(0, 100), ...mon, ...tue], 1440, "stock", "AAPL");
  assert.equal(higherWindow(holey, tue.at(-1).endMs, 2, 0), null, "the Friday daily bar is incomplete");
  assert.notEqual(higherWindow(holey, tue.at(-1).endMs, 1, 0), null, "Mon→Tue still chain");
  // NVDA split: Fri 2024-06-07 and Mon 2024-06-10 are consecutive sessions but not comparable prices.
  const pre = session("2024-06-07", 1200), post = session("2024-06-10", 120);
  const nvda = buildHigherSeries([...pre, ...post], 1440, "stock", "NVDA");
  assert.equal(higherWindow(nvda, post.at(-1).endMs, 1, 0), null, "a window may not span the split");
  const other = buildHigherSeries([...pre, ...post], 1440, "stock", "AAPL");
  assert.notEqual(higherWindow(other, post.at(-1).endMs, 1, 0), null);
});

test("stock: 1/3/12-minute features still reset at each session, higher ones do not", () => {
  const a = session("2025-01-08"), b = session("2025-01-10");
  const bars = [...a, ...b];
  const open2 = b[0].endMs;
  const m1 = ctFeature({ ...cond({ timeframe: 1, lookback: 5 }) }, bars, open2 + 2 * MIN, { market: "stock", symbol: "AAPL" });
  assert.equal(m1, null, "five prior minutes would reach into yesterday");
  const d1 = ctFeature(cond({ timeframe: 1440, lookback: 1 }), bars, b.at(-1).endMs, { market: "stock", symbol: "AAPL" });
  assert.notEqual(d1, null);
  const h1 = ctFeature(cond({ timeframe: 60, lookback: 6 }), bars, open2 + 2 * MIN, { market: "stock", symbol: "AAPL" });
  assert.notEqual(h1, null, "6 hourly bars of the previous session are completed and usable");
});

test("schema: timeframes 60/240/1440 and day-end options need ct-pattern-2; observation is capped at 30 days", () => {
  const base = (engine, over = {}) => ({
    version: 1,
    engine,
    name: "tf spec",
    market: "crypto",
    symbols: ["BTCUSDT"],
    minutes: 1,
    stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ timeframe: 1440, lookback: 5 })] }],
    entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
    exit: { stopPct: 0.5, targetPct: 1, maxHoldBars: 600, invalidation: "stop" },
    sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 3, participationPct: 1 },
    sourceIds: ["query"],
    assumptions: ["tf schema fixture"],
    ...over,
  });
  assert.doesNotThrow(() => ctSpecSchema.parse(base(CT_ENGINE)));
  assert.throws(() => ctSpecSchema.parse(base(CT_ENGINE_V1)), /ct-pattern-2/);
  assert.throws(() => ctSpecSchema.parse(base(CT_ENGINE_V1, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ timeframe: 3 })] }], exit: { stopPct: 0.5, targetPct: 1, maxHoldBars: 600, invalidation: "stop" } })), /390/);
  const c = { ...contractFor("crypto", DAY0, 400), engine: CT_ENGINE };
  assert.doesNotThrow(() => validateCTSpec(base(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ timeframe: 1440, lookback: 29 })] }] }), c, ["query"]));
  assert.throws(() => validateCTSpec(base(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ timeframe: 1440, lookback: 30 })] }] }), c, ["query"]), /30일/);
  assert.throws(() => validateCTSpec(base(CT_ENGINE, { stages: [{ label: "stage one", maxGapBars: 3, conditions: [cond({ timeframe: 240, lookback: 120, offset: 120 })] }] }), c, ["query"]), /30일/);
  // Stocks: at most one session per held position.
  const s = { ...contractFor("stock", DAY0, 400), engine: CT_ENGINE };
  assert.throws(() => validateCTSpec(base(CT_ENGINE, { market: "stock", symbols: ["NVDA"] }), s, ["query"]), /390/);
  // A contract and its specs agree on the engine.
  assert.throws(() => validateCTSpec(base(CT_ENGINE), { ...c, engine: CT_ENGINE_V1 }, ["query"]), /엔진/);
});

test("replay: a daily condition has no history on day one and signals from the fourth day, never from a partial day", () => {
  const data = walk(8, DAY0, 6 * 1440, 100, 0.0005);
  const spec = {
    version: 1,
    engine: CT_ENGINE,
    name: "daily context",
    market: "crypto",
    symbols: ["BTCUSDT"],
    minutes: 1,
    stages: [{ label: "stage one", maxGapBars: 1, conditions: [cond({ timeframe: 1440, lookback: 2 })] }],
    entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
    exit: { stopPct: 0.3, targetPct: 0.4, maxHoldBars: 120, invalidation: "stop" },
    sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 1, participationPct: 1 },
    sourceIds: ["g"],
    assumptions: ["daily context fixture"],
  };
  const c = { ...contractFor("crypto", DAY0, 6), engine: CT_ENGINE };
  const r = replayCT(spec, { BTCUSDT: data }, c, c.fromMs, c.toMs, "h");
  assert.ok(r.trades.length > 0);
  assert.ok(r.trades.every((t) => t.signal.decidedAt >= DAY0 + 3 * 86_400_000), "day 0-2 closes complete the third daily bar only at the start of day 3");
  // Poisoning tomorrow cannot change a signal today.
  const cut = DAY0 + 4 * 86_400_000;
  const poisoned = data.map((b) => (b.startMs >= cut ? { ...b, close: b.close * 2, high: b.high * 2.1 } : b));
  const r2 = replayCT(spec, { BTCUSDT: poisoned }, c, c.fromMs, cut, "h");
  const r3 = replayCT(spec, { BTCUSDT: data }, c, c.fromMs, cut, "h");
  assert.deepEqual(r2.trades.map((t) => t.signal.decidedAt), r3.trades.map((t) => t.signal.decidedAt));
  // detectCT builds the series itself when none is supplied (live path) and agrees with the replay.
  const t = r.trades[0];
  const live = detectCT(spec, "BTCUSDT", data.filter((b) => b.endMs <= t.signal.decidedAt), t.signal.decidedAt);
  assert.equal(live?.decidedAt, t.signal.decidedAt);
});
