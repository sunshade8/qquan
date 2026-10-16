import test from "node:test";
import assert from "node:assert/strict";
import {
  bars,
  spec,
  contract,
  ctState,
  candidate,
  condition,
} from "./helpers/ct-fixture.mjs";
import {
  ctHash,
  executableCT,
  validateCTSpec,
  ctSpecSchema,
} from "../lib/ct-spec.ts";
import {
  ctCandidateSchema,
  ctSessionContext,
  validateCTCandidate,
} from "../lib/ct-research.ts";
import { assertCTTool } from "../lib/ct-tools.ts";
import {
  ctFeature,
  ctSwings,
  detectCT,
  replayCT,
  ctExit,
  ctQuantity,
  ctDate,
  ctGate,
  qualityCT,
} from "../lib/ct-engine.ts";
const run = (data = bars(), options = {}) =>
  replayCT(
    spec(),
    { "KRW-BTC": data },
    contract(),
    contract().fromMs,
    contract().trainingToMs,
    "frozen",
    options,
  );
test("CT rejects invented performance, executable code and unsupported conditions", () => {
  assert.throws(() =>
    ctCandidateSchema.parse({ ...candidate(), netReturnPct: 100 }),
  );
  assert.throws(() => ctSpecSchema.parse({ ...spec(), code: "eval()" }));
  const s = spec();
  s.stages[0].conditions[0].feature = "unimplemented_pullback";
  assert.throws(() => ctSpecSchema.parse(s));
});
test("CT author input cannot see final data/results, private tool output or raw source text", () => {
  const ct = ctState();
  ct.final = { secret: "FINAL_NEVER_AUTHOR" };
  ct.finalStress = { secret: "FINAL_NEVER_AUTHOR" };
  ct.tools = [{ output: "FINAL_NEVER_AUTHOR" }];
  const context = JSON.stringify(ctSessionContext(ct, "test", { conclusion: "hurdle" }, { index: 0, kind: "design" }));
  assert.ok(!context.includes("FINAL_NEVER_AUTHOR"));
  // Principles and ids only: the full source text stays out of the designer's input.
  assert.ok(!context.includes(ct.sources[0].text));
  assert.ok(context.includes(ct.sources[0].id));
});
test("CT binds scope and verified sources on server", () => {
  const s = spec();
  s.symbols = ["KRW-FAKE"];
  assert.throws(() => validateCTSpec(s, contract(), ["verified"]));
  assert.throws(() => validateCTSpec(spec(), contract(), []));
});
test("CT every source claim maps to the identical executable feature", () => {
  const c = candidate();
  c.mapping[0].feature = "volume_ratio";
  assert.throws(() => validateCTCandidate(c, ctState()), /추적/);
  c.mapping = [];
  assert.throws(() => validateCTCandidate(c, ctState()));
});
test("CT revisions require actual parent, observed failure, changes and expected effect", () => {
  const ct = ctState();
  ct.trials = [{ id: "parent" }];
  assert.throws(() => validateCTCandidate(candidate(), ct));
  const c = candidate();
  c.parentId = "imaginary";
  assert.throws(() => validateCTCandidate(c, ct));
});
test("CT execution hashes ignore renamed prose but change with numeric rules", async () => {
  const a = spec(),
    b = spec();
  b.name = "new name";
  b.stages[0].label = "new prose";
  b.assumptions = ["different text"];
  assert.equal(await ctHash(executableCT(a)), await ctHash(executableCT(b)));
  b.exit.stopPct = 2;
  assert.notEqual(await ctHash(executableCT(a)), await ctHash(executableCT(b)));
});
test("CT future prices cannot alter a historical signal", () => {
  const data = bars(20),
    now = data[10].endMs;
  const signal = detectCT(spec(), "KRW-BTC", data, now);
  data[18].high = 999999;
  data[18].close = 999998;
  assert.deepEqual(detectCT(spec(), "KRW-BTC", data, now), signal);
});
test("CT swing is unavailable before two right bars confirm it", () => {
  const b = bars(7);
  b[3].high = 200;
  assert.ok(!ctSwings(b, b[4].endMs).some((s) => s.at === b[3].startMs));
  const found = ctSwings(b, b[5].endMs).find((s) => s.at === b[3].startMs);
  assert.equal(found.confirmedAt, b[5].endMs);
});
test("CT incomplete higher timeframe candles cannot influence features", () => {
  const b = bars(15),
    c = { ...condition, feature: "return_pct", timeframe: 3, lookback: 2 };
  const now = b[10].endMs,
    first = ctFeature(c, b, now);
  b[10].close = 99999;
  b[10].high = 99999;
  assert.equal(ctFeature(c, b, now), first);
});
test("CT gap and malformed prices fail closed instead of zero-filled history", () => {
  const b = bars(8);
  b.splice(5, 1);
  assert.equal(detectCT(spec(), "KRW-BTC", b, b.at(-1).endMs), null);
  const bad = bars();
  bad[5].high = 1;
  assert.equal(run(bad).status, "data_error");
  assert.equal(run([...bars(), bars()[0]]).status, "data_error");
});
test("CT entry is after signal confirmation and split history is purged", () => {
  const result = run();
  assert.ok(result.trades.length > 0);
  for (const t of result.trades) assert.ok(t.entryAt >= t.signal.decidedAt);
  const c = contract(),
    b = bars(80, c.trainingToMs - 10 * 300000);
  const result2 = replayCT(
    spec(),
    { "KRW-BTC": b },
    c,
    c.trainingToMs,
    c.developmentToMs,
    "frozen",
  );
  for (const t of result2.trades)
    assert.ok(t.signal.patternFrom >= c.trainingToMs);
});
test("CT ambiguous same bar is stop-first and adverse gaps fill at the open", () => {
  const s = spec(),
    signal = detectCT(s, "KRW-BTC", bars(8), bars(8).at(-1).endMs);
  assert.equal(
    ctExit(s, signal, 100, 0, { ...bars()[0], open: 100, high: 103, low: 98 })
      .reason,
    "stop",
  );
  assert.equal(
    ctExit(s, signal, 100, 0, { ...bars()[0], open: 95, high: 103, low: 94 })
      .price,
    95,
  );
});
test("CT fees, spread, slippage and doubled cost stress reduce measured equity", () => {
  const base = run(),
    stress = run(bars(), { costMultiplier: 2 });
  assert.ok(base.costs > 0);
  assert.ok(stress.netReturnPct < base.netReturnPct);
  assert.equal(base.trades[0].specHash, "frozen");
});
test("CT volume participation, minimum order and whole versus decimal quantity", () => {
  const crypto = ctQuantity(
    spec(),
    contract(),
    1000000,
    1000000,
    50000000,
    0.000001,
  );
  assert.equal(crypto, 0);
  const stock = ctQuantity(
    spec("stock"),
    contract("stock"),
    1000,
    1000,
    333,
    100000,
  );
  assert.equal(stock, 0);
  const quantity = ctQuantity(
    spec(),
    contract(),
    1000000,
    1000000,
    12345,
    100000,
  );
  assert.ok(quantity > 0 && !Number.isInteger(quantity));
});
test("CT KST continuous-market day is independent from US session date", () => {
  assert.equal(ctDate(Date.UTC(2025, 0, 1, 16), "crypto"), "2025-01-02");
  assert.equal(ctDate(Date.UTC(2025, 0, 1, 16), "stock"), "2025-01-01");
});
test("CT no-trades is a measured normal outcome and cannot pass numerical gates", () => {
  const s = spec();
  s.stages[0].conditions[0].value = 999;
  const r = replayCT(
    s,
    { "KRW-BTC": bars() },
    contract(),
    contract().fromMs,
    contract().trainingToMs,
    "frozen",
  );
  assert.equal(r.status, "no_trades");
  assert.ok(ctGate(r, contract()).length);
});
test("CT tools enforce phase, market, bounds and final access regardless of model text", () => {
  const ct = ctState();
  assert.throws(() => assertCTTool("place_order", {}, ct));
  assert.throws(() =>
    assertCTTool(
      "backtest",
      {
        hash: "a",
        kind: "final",
        from: ct.contract.developmentToMs,
        to: ct.contract.toMs,
        dataHash: "a",
        options: {},
      },
      ct,
    ),
  );
  ct.phase = "experiment";
  assert.throws(() =>
    assertCTTool(
      "backtest",
      {
        hash: "a",
        kind: "training",
        from: ct.contract.fromMs,
        to: ct.contract.toMs,
        dataHash: "a",
        options: {},
      },
      ct,
    ),
  );
  ct.phase = "data";
  assert.throws(() =>
    assertCTTool(
      "collect_market_data",
      {
        market: "stock",
        symbol: "SPY",
        from: ct.contract.fromMs,
        to: ct.contract.toMs,
        before: ct.contract.toMs,
      },
      ct,
    ),
  );
});
test("CT data inventory reports missing intervals without pretending full coverage", () => {
  const b = bars(5);
  b.splice(2, 1);
  assert.equal(qualityCT(b, 5).gaps, 1);
});

test("CT published NYSE sessions include holidays and early closes, unknown years fail closed", async () => {
  const { ctStockSession } = await import("../lib/ct-sessions.ts");
  const { ctSessionClosing } = await import("../lib/ct-engine.ts");
  assert.equal(ctStockSession("2021-12-24"), null);
  assert.equal(ctStockSession("2021-11-26").close, "13:00");
  assert.equal(ctStockSession("2024-06-10").open, "09:30");
  assert.equal(ctStockSession("2026-07-03"), null);
  assert.equal(ctStockSession("2025-01-09"), null);
  assert.equal(ctStockSession("2026-07-02").close, "16:00");
  assert.equal(ctStockSession("2026-11-27").close, "13:00");
  assert.equal(ctSessionClosing(Date.parse("2026-11-27T17:59:00Z")), true);
  assert.equal(ctSessionClosing(Date.parse("2026-11-27T17:58:00Z")), false);
  assert.throws(() => ctStockSession("2036-01-02"), /범위/);
});
test("CT a missing held bar is data_error rather than an invented profitable fill", () => {
  const b = bars();
  b.splice(5, 1);
  assert.equal(run(b).status, "data_error");
});
test("CT compact checkpoints preserve measured total and numerical gates", async () => {
  const { ctCheckpointResult, ctSummary } = await import("../lib/ct-engine.ts");
  const full = run(),
    compact = ctCheckpointResult(full);
  assert.equal(compact.tradeCount, full.trades.length);
  assert.ok(compact.trades.length <= 8);
  assert.equal(ctSummary(compact).tradeCount, full.trades.length);
  assert.deepEqual(ctGate(compact, contract()), ctGate(full, contract()));
});
test("CT higher timeframe features aggregate consecutive base bars", () => {
  const b = bars(15),
    c = { ...condition, feature: "return_pct", timeframe: 3, lookback: 2 };
  // Fixture bars start on a 15-minute boundary, so groups are [0..2], [3..5], [6..8] by bar 9.
  const value = ctFeature(c, b, b[8].endMs);
  assert.notEqual(value, null);
  assert.ok(Math.abs(value - (b[8].close / b[2].close - 1) * 100) < 1e-9);
});
test("CT gate requires a positive mean daily net return, also for results saved without it", async () => {
  const { ctNetPositive, ctMeanDaily } = await import("../lib/ct-engine.ts");
  const result = {
    status: "measured",
    trades: Array.from({ length: 20 }, () => ({})),
    netReturnPct: 1,
    maxDrawdownPct: 1,
    compliancePct: 100,
    concentrationPct: 0,
    maxMonthConcentrationPct: 0,
    daily: [{ returnPct: 3 }, { returnPct: -2 }, { returnPct: -2 }],
  };
  assert.ok(Math.abs(ctMeanDaily(result) + 1 / 3) < 1e-9);
  assert.ok(ctGate(result, contract()).includes("일평균 비용 후 수익 기준 미달"));
  assert.equal(ctNetPositive(result), false);
  result.daily = [{ returnPct: 0.5 }, { returnPct: 0 }, { returnPct: -0.1 }];
  assert.deepEqual(ctGate(result, contract()), []);
  assert.equal(ctNetPositive(result), true);
  const r = run();
  const days = r.daily.map((d) => d.returnPct);
  assert.ok(Math.abs(r.meanDailyReturnPct - days.reduce((s, n) => s + n, 0) / days.length) < 1e-9);
});
test("CT detector cache returns the same signals as uncached detection", () => {
  const s = spec();
  s.stages = [
    { label: "pullback", maxGapBars: 5, conditions: [{ ...condition, feature: "return_pct", lookback: 2, value: -5, op: "gte" }] },
    { label: "breakout", maxGapBars: 3, conditions: [{ ...condition }] },
  ];
  const b = bars(60),
    cache = new Map();
  let signals = 0;
  for (let i = 10; i < b.length; i++) {
    const rows = b.slice(0, i + 1),
      cached = detectCT(s, "KRW-BTC", rows, b[i].endMs, cache);
    assert.deepEqual(cached, detectCT(s, "KRW-BTC", rows, b[i].endMs));
    if (cached) signals++;
  }
  assert.ok(signals > 0);
});
test("CT research data is one-minute bars (the bar a rule trades on is the designer's, not the request's) and accepts Binance USDT crypto symbols", async () => {
  const { ctRequestSchema } = await import("../lib/ct-research.ts");
  const base = { requestId: "00000000-0000-4000-8000-000000000000" };
  assert.doesNotThrow(() => ctRequestSchema.parse({ ...base, minutes: 1 }));
  assert.throws(() => ctRequestSchema.parse({ ...base, minutes: 15 }));
  const c = { ...contract(), symbols: ["BTCUSDT"], minutes: 1, currency: "USDT" };
  const s = { ...spec(), symbols: ["BTCUSDT"], minutes: 1 };
  s.exit.maxHoldBars = 390;
  assert.doesNotThrow(() => validateCTSpec(s, c, ["verified"]));
  assert.throws(() => validateCTSpec({ ...s, symbols: ["NVDA"] }, { ...c, symbols: ["NVDA"] }, ["verified"]));
});
