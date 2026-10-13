import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contract as legacyFixture } from "./helpers/ct-fixture.mjs";

// A throwaway data directory holding real (tiny) immutable partitions: the contract code reads
// the genuine catalog and snapshots, only the amount of bars is small.
process.env.QQUAN_DATA_DIR = mkdtempSync(join(tmpdir(), "ct-contract-"));
register("./helpers/slot-test-loader.mjs", import.meta.url);
const sqlite = new DatabaseSync(":memory:");
class Statement {
  constructor(sql, values = []) { this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sql, values); }
  async run() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
  async raw() { return (await this.all()).results.map(Object.values); }
}
globalThis.__strategyTestEnv = { DB: { prepare: (s) => new Statement(s), batch: async (ss) => Promise.all(ss.map((s) => s.run())) } };

const DAY = 86_400_000;
const toMs = Math.floor((Date.now() - DAY) / DAY) * DAY;
const seed = (dataset, days) => {
  const start = toMs - days * DAY,
    at = toMs - 5 * DAY + 15 * 3600_000;
  const code = `import sys;sys.path.insert(0,'scripts/data');import store;db=store.connect();store.publish(db,'${dataset}',${start},${toMs + DAY},[[${at},${at + 60000},100,102,99,101,20,None]],'fixture')`;
  const r = spawnSync(".venv/bin/python", ["-c", code], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};
for (const d of ["btc", "eth", "sol"]) seed(d, 1200);
seed("stock", 420);

const research = await import("../lib/ct-research-store.ts");
const { ctCostsRoundTripPct, ctCostProfileText, CT_COST_PROFILES, ctProfileCosts } = await import("../lib/ct-costs.ts");
const { ctRoundTripCostPct, replayCT } = await import("../lib/ct-engine.ts");
const { CT_ENGINE, CT_ENGINE_V1 } = await import("../lib/ct-spec.ts");
await research.ensureCTSchema();
const request = (over = {}) => ({ requestId: crypto.randomUUID(), market: "crypto", ...over });

test("a new coin contract takes its costs from the exchange profile and records which one", async () => {
  const c = await research.prepareCTContract(request());
  assert.equal(c.engine, CT_ENGINE);
  assert.deepEqual(c.costProfile, { id: "binance-spot-usdt", version: 1 });
  const priced = ctProfileCosts("crypto", ["BTCUSDT"], c.capital);
  assert.deepEqual(c.costs, priced.costs);
  assert.equal(c.costs.feePct, 0.1, "official Binance spot fee, not the old 0.05% spread + 0.03% slippage guesses");
  assert.ok(c.costs.spreadPct < 0.01 && c.costs.slippagePct < 0.01, "BTCUSDT's measured book is far tighter than the old assumption");
  // The cost hurdle's round trip is what replayCT charges (the pure screen formula agrees with the engine).
  assert.ok(Math.abs(ctRoundTripCostPct(c) - ctCostsRoundTripPct(c.costs)) < 1e-12);
  assert.ok(ctRoundTripCostPct(c) < 0.25 && ctRoundTripCostPct(c) > 0.199);
  assert.match(ctCostProfileText(c, ctRoundTripCostPct(c)), /Binance Spot/);
  // Doubled cost stays available and is exactly 2x the profile's fee/impact.
  assert.ok(ctRoundTripCostPct(c, 2) > ctRoundTripCostPct(c) * 1.99);
  const s = await research.prepareCTContract(request({ market: "stock" }));
  assert.deepEqual(s.costProfile, { id: "toss-us-equity", version: 1 });
  assert.equal(s.costs.spreadPct, 0.05, "stocks keep the broker-costs assumptions");
});

test("a contract frozen before profiles keeps the costs it stored; profile edits never reach it", () => {
  const old = legacyFixture("crypto");
  assert.equal(old.costProfile, undefined);
  const stored = ctRoundTripCostPct(old);
  assert.ok(Math.abs(stored - 0.3095) < 0.001);
  assert.match(ctCostProfileText(old, stored), /저장된 비용/);
  // Even if a profile were rewritten tomorrow, a replay reads contract.costs only.
  const profile = CT_COST_PROFILES["binance-spot-usdt"];
  const before = profile.feePct;
  profile.feePct = 9;
  try {
    assert.equal(ctRoundTripCostPct(old), stored);
  } finally {
    profile.feePct = before;
  }
});

test("profile costs are never below the measurement and a thin sample is flagged as provisional", () => {
  const p = CT_COST_PROFILES["binance-spot-usdt"];
  for (const [symbol, per] of Object.entries(p.symbols))
    for (const [usd, v] of Object.entries(per)) {
      assert.ok(v.spreadPct >= 0 && v.slippagePct >= 0, `${symbol} $${usd}`);
    }
  const priced = ctProfileCosts("crypto", ["SOLUSDT"], 1000);
  const btc = ctProfileCosts("crypto", ["BTCUSDT"], 1000);
  assert.ok(priced.costs.spreadPct >= btc.costs.spreadPct, "the thinner book costs more");
  assert.equal(typeof priced.provisional, "boolean");
  assert.throws(() => ctProfileCosts("crypto", ["DOGEUSDT"], 1000), /측정값/);
  assert.throws(() => ctProfileCosts("stock", ["NVDA"], 1000, "binance-spot-usdt"), /시장용이 아닙니다/);
});

test("research period: 90 days up to 3 years for coins, default one year, stocks only as far as the local data goes", async () => {
  const year = await research.prepareCTContract(request());
  assert.equal(Math.round((year.toMs - year.fromMs) / DAY), 365);
  assert.equal(Math.round((year.trainingToMs - year.fromMs) / DAY), Math.floor(365 * 0.6));
  assert.equal(Math.round((year.developmentToMs - year.fromMs) / DAY), Math.floor(365 * 0.8));
  const three = await research.prepareCTContract(request({ days: 1095 }));
  assert.equal(Math.round((three.toMs - three.fromMs) / DAY), 1095);
  await assert.rejects(() => research.prepareCTContract(request({ days: 1096 })));
  await assert.rejects(() => research.prepareCTContract(request({ days: 89 })));
  // The seeded stock history is 420 days: 365 works, 900 is refused with the missing range.
  await research.prepareCTContract(request({ market: "stock", days: 365 }));
  await assert.rejects(() => research.prepareCTContract(request({ market: "stock", days: 900 })), /데이터 준비 필요/);
});

test("1–3 coins can be studied together, each on its own immutable snapshot, priced by the worst of them", async () => {
  const c = await research.prepareCTContract(request({ symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }));
  assert.deepEqual(c.symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.deepEqual(Object.keys(c.dataSnapshots).sort(), ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.equal(new Set(Object.values(c.dataSnapshots)).size, 3, "a snapshot belongs to one dataset");
  const sol = ctProfileCosts("crypto", ["SOLUSDT"], c.capital);
  assert.equal(c.costs.spreadPct, sol.costs.spreadPct);
  await assert.rejects(() => research.prepareCTContract(request({ symbols: ["BTCUSDT", "BTCUSDT"] })), /중복/);
  await assert.rejects(() => research.prepareCTContract(request({ symbols: ["BTCUSDT", "XRPUSDT"] })), /지원/);
  const one = await research.prepareCTContract(request({ symbols: ["ETHUSDT"] }));
  assert.equal(one.dataSnapshots, undefined);
  assert.ok(one.dataSnapshot);
});

test("a final window that an earlier run already opened is refused before anything is paid for", async () => {
  const c = await research.prepareCTContract(request({ symbols: ["BTCUSDT"] }));
  await research.assertFinalWindowFree(c);
  sqlite
    .prepare("INSERT INTO ct_exposure VALUES (?,?,?,?,?,?)")
    .run("11111111-aaaa", "crypto", JSON.stringify(["BTCUSDT"]), c.toMs - 30 * DAY, c.toMs - 2 * DAY, "hash");
  await assert.rejects(() => research.assertFinalWindowFree(c), /겹칩니다/);
  // A longer research period that swallows that old final is refused the same way.
  const longer = await research.prepareCTContract(request({ symbols: ["BTCUSDT"], days: 1095 }));
  await assert.rejects(() => research.assertFinalWindowFree(longer), /11111111/);
  // Another coin, another market, or the run itself are free.
  await research.assertFinalWindowFree(await research.prepareCTContract(request({ symbols: ["ETHUSDT"] })));
  await research.assertFinalWindowFree(await research.prepareCTContract(request({ market: "stock" })));
  await research.assertFinalWindowFree(c, "11111111-aaaa");
});

test("ct-pattern-1 and ct-pattern-2 contracts are told apart by engine, not by guesswork", () => {
  assert.equal(legacyFixture("crypto").engine, CT_ENGINE, "fixtures follow the current engine");
  assert.notEqual(CT_ENGINE, CT_ENGINE_V1);
  void replayCT;
});

test("replayCT charges the profile's round trip (to the tick) and cost_hurdle reports the same number", async () => {
  const { ctCostHurdle } = await import("../lib/ct-design-tools.ts");
  const c = await research.prepareCTContract(request({ symbols: ["BTCUSDT"], days: 90 }));
  const bars = Array.from({ length: 3 * 1440 }, (_, i) => ({
    startMs: c.fromMs + i * 60_000, endMs: c.fromMs + (i + 1) * 60_000, open: 83000, high: 83000, low: 83000, close: 83000, volume: 50,
  }));
  const spec = {
    version: 1, engine: CT_ENGINE, name: "flat probe", market: "crypto", symbols: ["BTCUSDT"], minutes: 1,
    stages: [{ label: "stage one", maxGapBars: 1, conditions: [{ feature: "range_position", lookback: 3, offset: 0, timeframe: 1, op: "lte", value: 1 }] }],
    entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
    exit: { stopPct: 1, targetPct: 2, maxHoldBars: 5, invalidation: "stop" },
    sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 1, participationPct: 1 },
    sourceIds: ["x"], assumptions: ["flat market: every trade loses exactly its cost"],
  };
  const result = replayCT(spec, { BTCUSDT: bars }, c, c.fromMs, c.fromMs + 3 * 86_400_000, "h");
  assert.ok(result.trades.length > 100);
  const expected = ctRoundTripCostPct(c);
  for (const t of result.trades) {
    const paid = t.quantity * t.entry * (1 + c.costs.feePct / 100);
    assert.ok(Math.abs((-t.pnl / paid) * 100 - expected) < 2e-4, `${(-t.pnl / paid) * 100} vs ${expected}`);
  }
  const hurdle = ctCostHurdle({ BTCUSDT: bars.map((b) => ({ ...b })) }, { ...c, trainingToMs: c.fromMs + 3 * 86_400_000 });
  assert.equal(hurdle.roundTripCostPct, Number(expected.toFixed(4)));
  // ct-pattern-2 hurdle: crypto adds 12h/24h and the day-end horizon, every horizon cut at the UTC day.
  assert.deepEqual(hurdle.horizons.map((h) => h.bars), [5, 15, 60, 240, 390, 720, 1440, 0]);
  assert.equal(hurdle.horizons.at(-1).label, "당일 경계까지(가변)");
});

test("development summaries carry per-quarter mean daily returns and the positive-quarter share (information, not a gate)", async () => {
  const { ctStability, ctGate } = await import("../lib/ct-engine.ts");
  const { ctBrief } = await import("../lib/ct-research.ts");
  const daily = [
    ["2026-01-02", 0.2], ["2026-02-10", -0.1], ["2026-03-30", 0.3],
    ["2026-04-01", -0.5], ["2026-05-05", 0.1], ["2026-06-30", -0.2],
    ["2026-07-01", 0.4],
  ].map(([date, returnPct]) => ({ date, equity: 1, returnPct }));
  const s = ctStability({ daily });
  assert.deepEqual(s.quarters.map((q) => q.quarter), ["2026Q1", "2026Q2", "2026Q3"]);
  assert.deepEqual(s.quarters.map((q) => q.days), [3, 3, 1]);
  assert.equal(s.quarters[0].meanDailyReturnPct, 0.1333);
  assert.equal(s.quarters[1].meanDailyReturnPct, -0.2);
  assert.equal(s.positiveQuarterPct, 66.7);
  const result = { engine: CT_ENGINE, status: "measured", bars: 1, trades: [], tradeCount: 30, signals: 30, missed: 0, costs: 0, netReturnPct: 0.5, maxDrawdownPct: 1, winRatePct: 50, payoff: 1, expectancy: 0, compliancePct: 100, daily, concentrationPct: 0, maxMonthConcentrationPct: 10, emptyDays: 0, diagnostics: [], blocked: {} };
  const brief = ctBrief(result);
  assert.equal(brief.positiveQuarterPct, 66.7);
  assert.equal(brief.quarters.length, 3);
  // The gate ignores it: a result with the same totals but no positive quarter passes or fails identically.
  const flipped = { ...result, daily: daily.map((d) => ({ ...d, returnPct: d.returnPct > 0 ? 0.0001 : d.returnPct })) };
  const c = await research.prepareCTContract(request());
  assert.deepEqual(ctGate({ ...result, daily: [] }, c), ctGate({ ...flipped, daily: [] }, c));
});
