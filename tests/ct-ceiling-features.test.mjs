// Ceiling measurement (research only): derivative / exchange-gap features never read a value published after the decision time.
import test from "node:test";
import assert from "node:assert/strict";
import { derivColumns, DERIV_NAMES, gapColumns, GAP_NAMES, fillMinuteGrid, roundTripFromSamples, permuteDayBlocks, rollingZ, toGrid } from "../lib/ct-ceiling-features.ts";
import { ctRng } from "../lib/ct-trader-tools.ts";

const MIN = 60_000, DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);

function world(days = 12, seed = 3) {
  const rng = ctRng(seed);
  const n = days * 1440;
  const premium = { endMs: [], close: [] };
  for (let i = 1; i <= n; i++) { premium.endMs.push(START + i * MIN); premium.close.push((rng() - 0.5) * 0.002); }
  const funding = { calcMs: [], rate: [] };
  for (let t = START - DAY; t < START + days * DAY; t += 8 * 3600_000) { funding.calcMs.push(t); funding.rate.push((rng() - 0.5) * 0.0004); }
  const metrics = { startMs: [], openInterestValue: [], takerVolRatio: [] };
  for (let t = START - DAY; t < START + days * DAY; t += 5 * MIN) { metrics.startMs.push(t); metrics.openInterestValue.push(1e9 * (1 + 0.1 * rng())); metrics.takerVolRatio.push(0.5 + rng()); }
  return { premium, funding, metrics };
}
const decisions = (from, to, step = 7 * MIN) => Float64Array.from({ length: Math.floor((to - from) / step) }, (_, k) => from + k * step);

test("derivative columns at time t are unchanged when every value published after t is replaced by garbage", () => {
  const w = world();
  const T0 = START + 9 * DAY + 3 * 3600_000 + 17 * MIN;
  const ds = decisions(START + 8 * DAY + 600 * MIN, T0 + MIN).filter((t) => t <= T0);
  const base = derivColumns(ds, w);
  const poison = JSON.parse(JSON.stringify(w));
  poison.premium.endMs.forEach((e, i) => { if (e > T0) poison.premium.close[i] = 99; });
  poison.funding.calcMs.forEach((c, i) => { if (c > T0) poison.funding.rate[i] = 99; });
  poison.metrics.startMs.forEach((s, i) => { if (s + 5 * MIN > T0) { poison.metrics.openInterestValue[i] = 1e15; poison.metrics.takerVolRatio[i] = 1e6; } });
  const dirty = derivColumns(ds, poison);
  assert.equal(base.length, DERIV_NAMES.length);
  base.forEach((col, f) => assert.deepEqual(Array.from(col), Array.from(dirty[f]), `${DERIV_NAMES[f]} read a future value`));
  assert.ok(base.every((col) => col.some((v) => Number.isFinite(v))), "every column has values to compare");
  // Poisoning only values the decision may legally see changes the columns (the test can fail).
  const alsoPast = JSON.parse(JSON.stringify(w));
  alsoPast.premium.close = alsoPast.premium.close.map((v) => v + 0.01);
  assert.notDeepEqual(Array.from(derivColumns(ds, alsoPast)[2]), Array.from(base[2]));
});

test("timing rules: a 5-minute row is usable 5 minutes after its create_time, a settlement from its calc time, a premium bar when it closes", () => {
  const T = START + 3 * DAY + 600 * MIN; // a metrics window start (multiple of 5 minutes)
  const metrics = { startMs: [], openInterestValue: [], takerVolRatio: [] };
  for (let t = START - 9 * DAY; t < START + 5 * DAY; t += 5 * MIN) { metrics.startMs.push(t); metrics.openInterestValue.push(t === T ? 2e9 : 1e9); metrics.takerVolRatio.push(t === T ? 3 : 1); }
  const premium = { endMs: [START + 3 * DAY + 600 * MIN, START + 3 * DAY + 601 * MIN], close: [0.001, 0.002] };
  const funding = { calcMs: [START + 3 * DAY + 480 * MIN, START + 3 * DAY + 600 * MIN], rate: [0.0001, 0.0005] };
  const col = (t, name) => derivColumns([t], { premium, funding, metrics })[DERIV_NAMES.indexOf(name)][0];
  // window [T, T+5m) describes minutes T..T+5m: not known at T+4m, known at T+5m
  assert.notEqual(col(T + 4 * MIN, "taker_ratio"), 3);
  assert.equal(col(T + 5 * MIN, "taker_ratio"), 3);
  assert.ok(col(T + 5 * MIN, "oi_chg60") > 90, "the jump in open interest shows from T+5m");
  assert.ok(!(col(T + 4 * MIN, "oi_chg60") > 90));
  // settlement: before 10:00 the old rate, at/after 10:00 the new one
  assert.ok(Math.abs(col(T - MIN, "funding_level") - 0.0001) < 1e-9);
  assert.ok(Math.abs(col(T, "funding_level") - 0.0005) < 1e-9);
  assert.ok(Math.abs(col(T, "funding_change") - 0.0004) < 1e-9);
  // a premium bar closing at T is known at T, the one closing at T+1m is not known at T
  assert.ok(Math.abs(col(T, "premium_pct") - 0.1) < 1e-6);
  assert.ok(Math.abs(col(T + MIN, "premium_pct") - 0.2) < 1e-6);
  assert.ok(!Number.isFinite(col(T - MIN, "premium_pct")), "nothing before the first closed bar");
  // a stale settlement (older than 9 hours) is not carried forward
  assert.ok(!Number.isFinite(derivColumns([T + 12 * 3600_000], { premium, funding, metrics })[0][0]));
});

test("gap and lead–lag: formula, same-minute closes, and no look-ahead", () => {
  const n = 3 * 1440;
  const mk = (f) => ({ endMs: Array.from({ length: n }, (_, i) => START + (i + 1) * MIN), close: Array.from({ length: n }, (_, i) => f(i)) });
  const binance = mk((i) => 100 * (1 + 0.0001 * i)), usdt = mk(() => 1400), upbit = mk((i) => 100 * 1400 * (1 + 0.0001 * i) * 1.01);
  const ds = [START + 2 * DAY + 400 * MIN];
  const cols = gapColumns(ds, binance, upbit, usdt);
  assert.equal(cols.length, GAP_NAMES.length);
  assert.ok(Math.abs(cols[0][0] - 1) < 1e-6, "Upbit is 1% above Binance × KRW-USDT");
  assert.ok(Math.abs(cols[1][0]) < 1e-9 && Math.abs(cols[2][0]) < 1e-9, "a constant premium has no change");
  assert.ok(Math.abs(cols[4][0]) < 1e-9, "same returns on both exchanges: no lead");
  // Binance moved up in the last 3 minutes and Upbit did not: positive lead.
  const lead = { ...upbit, close: upbit.close.map((v, i) => (i >= 2 * 1440 + 398 ? upbit.close[2 * 1440 + 397] : v)) };
  const led = gapColumns([START + 2 * DAY + 401 * MIN], binance, lead, usdt);
  assert.ok(led[5][0] > 0.0, `lead3 ${led[5][0]}`);
  // Future closes never enter.
  const T0 = ds[0];
  const dirty = (s) => ({ endMs: s.endMs, close: s.close.map((v, i) => (s.endMs[i] > T0 ? v * 7 : v)) });
  const clean = gapColumns(ds, binance, upbit, usdt),
    poisoned = gapColumns(ds, dirty(binance), dirty(upbit), dirty(usdt));
  clean.forEach((c, f) => assert.equal(c[0], poisoned[f][0], GAP_NAMES[f]));
  // a missing minute in one series makes the gap NaN (never carried over)
  const hole = { endMs: upbit.endMs.filter((e) => e !== T0), close: upbit.close.filter((_, i) => upbit.endMs[i] !== T0) };
  assert.ok(!Number.isFinite(gapColumns(ds, binance, hole, usdt)[0][0]));
});

test("Upbit empty minutes become flat zero-volume bars at the previous close; nothing is invented before the first candle", () => {
  const row = (m, p) => ({ startMs: START + m * MIN, open: p, high: p + 1, low: p - 1, close: p + 0.5, volume: 2 });
  const { bars, filled } = fillMinuteGrid([row(2, 100), row(3, 110), row(7, 120)], START, START + 10 * MIN);
  assert.equal(bars.length, 8, "minutes 0 and 1 precede the first candle");
  assert.equal(bars[0].startMs, START + 2 * MIN);
  assert.equal(filled, 5, "minutes 4–6 between candles and 8–9 after the last one");
  const flat = bars[2];
  assert.deepEqual([flat.startMs, flat.open, flat.high, flat.low, flat.close, flat.volume], [START + 4 * MIN, 110.5, 110.5, 110.5, 110.5, 0]);
  assert.ok(bars.every((b, i) => i === 0 || b.startMs === bars[i - 1].endMs), "gapless");
  assert.equal(fillMinuteGrid([], START, START + 5 * MIN).bars.length, 0);
});

test("round-trip cost per venue and symbol from order-book samples: fee per side plus twice the p90 one-way impact", () => {
  const rows = (bps) => bps.map((b) => ({ buy_bp: b, sell_bp: b }));
  const btc = roundTripFromSamples(rows(Array.from({ length: 100 }, (_, i) => i / 100)), 0.1);
  assert.equal(btc.samples, 100);
  assert.ok(Math.abs(btc.costPct - (0.2 + (2 * 0.9) / 100)) < 0.002, `${btc.costPct}`);
  const sol = roundTripFromSamples(rows(Array.from({ length: 100 }, (_, i) => 2 + i / 10)), 0.1);
  assert.ok(sol.costPct > btc.costPct, "a thinner book costs more");
  assert.equal(roundTripFromSamples(rows([1, 2]), 0.05).costPct > 0.1, true, "Upbit fee 0.05% per side");
  assert.deepEqual(roundTripFromSamples([], 0.05), { costPct: 0.1, p90bp: null, samples: 0 });
  assert.equal(roundTripFromSamples([{ buy_bp: null, sell_bp: null }], 0.1).p90bp, null);
});

test("the day-block permutation is seeded, keeps each day's rows together and leaves labels alone", () => {
  const days = 6, n = days * 1440;
  const dayKey = new Int32Array(n), startMs = new Float64Array(n), dayStart = new Float64Array(n);
  for (let i = 0; i < n; i++) { dayKey[i] = Math.floor(i / 1440); startMs[i] = START + i * MIN; dayStart[i] = START + dayKey[i] * DAY; }
  const col = Float32Array.from({ length: n }, (_, i) => dayKey[i] * 10000 + (i % 1440));
  const a = permuteDayBlocks([col], dayKey, startMs, dayStart, 11)[0], b = permuteDayBlocks([col], dayKey, startMs, dayStart, 11)[0], c = permuteDayBlocks([col], dayKey, startMs, dayStart, 12)[0];
  assert.deepEqual(Array.from(a), Array.from(b), "same seed, same permutation");
  assert.notDeepEqual(Array.from(a), Array.from(c));
  for (let d = 0; d < days; d++) {
    const srcDay = Math.floor(a[d * 1440] / 10000);
    for (let m = 0; m < 1440; m += 97) assert.equal(a[d * 1440 + m], srcDay * 10000 + m, "one source day per day, same minute position");
  }
  assert.equal(new Set(Array.from({ length: days }, (_, d) => Math.floor(a[d * 1440] / 10000))).size, days, "a permutation of days");
  // A source day with a missing minute leaves NaN, not a neighbour's value.
  const holes = Float64Array.from(startMs); holes[1440 + 5] = holes[1440 + 4];
  const dk2 = Int32Array.from(dayKey);
  const out = permuteDayBlocks([col], dk2, holes, dayStart, 11)[0];
  assert.ok(out.some((v) => Number.isNaN(v)));
});

test("rolling z-score uses only the window up to the slot and ignores gaps", () => {
  const g = toGrid(Array.from({ length: 50 }, (_, i) => START + i * MIN), Array.from({ length: 50 }, (_, i) => (i === 20 ? NaN : i % 7)), START, START + 49 * MIN, MIN);
  const z = rollingZ(g, 30, 20);
  assert.ok(Number.isNaN(z[10]) && Number.isNaN(z[20]), "too few values / missing slot");
  const future = toGrid(Array.from({ length: 50 }, (_, i) => START + i * MIN), Array.from({ length: 50 }, (_, i) => (i > 40 ? 1e6 : i === 20 ? NaN : i % 7)), START, START + 49 * MIN, MIN);
  assert.equal(rollingZ(future, 30, 20)[35], z[35], "later slots do not change an earlier z");
});

test("a decision series that does not start on a 5-minute boundary still reads the 5-minute metrics", () => {
  const w = world(10);
  const first = START + 5 * DAY + 3 * MIN + 17 * MIN; // not a multiple of 5 minutes
  const ds = decisions(first, first + 600 * MIN, MIN);
  const cols = derivColumns(ds, w);
  for (const name of ["oi_chg60", "oi_chg240", "oi_z7d", "taker_ratio", "taker_ratio_1h"]) assert.ok(cols[DERIV_NAMES.indexOf(name)].every((v) => Number.isFinite(v)), name);
  const anchored = derivColumns(decisions(START + 5 * DAY, first + 600 * MIN, MIN), w);
  const skip = Math.round((first - (START + 5 * DAY)) / MIN);
  cols.forEach((c, f) => assert.deepEqual(Array.from(c), Array.from(anchored[f].slice(skip, skip + c.length)), `${DERIV_NAMES[f]} depends on where the series starts`));
});
