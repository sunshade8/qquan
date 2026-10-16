// Bar overview (traderTools 5, 2026-10-16): the cost hurdle and label base rate on every bar the designer may choose,
// in the cached stable block, free (never a ledger test). Older contracts keep their bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { ctState } from "./helpers/ct-fixture.mjs";
import { plantedMarket, plantedContract } from "./helpers/ct-trader-fixture.mjs";
import { stockWalk, contractFor } from "./helpers/ct-golden-cases.mjs";
import { ctHash, CT_ENGINE, CT_POLICY_V6 as CT_POLICY, ctSessionPolicy } from "../lib/ct-spec.ts";
import { ctDataAt } from "../lib/ct-engine.ts";
import { ctCostHurdle } from "../lib/ct-design-tools.ts";
import { ctRunLabels, ctLabelMovesReport } from "../lib/ct-trader-tools.ts";
import { ctBarOverview, ctOverviewHorizons, ctOverviewStride, CT_OVERVIEW_COLUMNS, CT_OVERVIEW_LABEL } from "../lib/ct-bar-overview.ts";
import { ctSessionContext, ctDesignerSystem, CT_DESIGNER_SYSTEM, CT_DESIGNER_SYSTEM_STAGE6 } from "../lib/ct-research.ts";
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
globalThis.__strategyTestEnv = {
  OPENAI_API_KEY: "test-openai", ANTHROPIC_API_KEY: "test-anthropic",
  DB: { prepare: (s) => new Statement(s), batch: async (ss) => Promise.all(ss.map((s) => s.run())) },
};
globalThis.__strategyTestHooks = { call: () => { throw new Error("unexpected structured call"); } };
const research = await import("../lib/ct-research-store.ts");
const store = await import("../lib/strategy-generation-store.ts");
const flow = await import("../lib/strategy-generation.ts");
await research.ensureCTSchema();

const sha = (x) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const { bars } = plantedMarket();
const contract = plantedContract();
const data = { BTCUSDT: bars };
const row = (columns, values) => Object.fromEntries(columns.map((c, i) => [c, values[i]]));

test("every bar's numbers are ctCostHurdle on that bar's data, and the label base rate is label_moves at its defaults", () => {
  assert.equal(ctSessionPolicy(contract).barOverview, true);
  const overview = ctBarOverview(data, contract);
  assert.deepEqual(overview.bars.map((b) => b.barMinutes), [1, 5, 15, 60]);
  assert.deepEqual(overview.columns, CT_OVERVIEW_COLUMNS);
  for (const b of overview.bars) {
    const bar = b.barMinutes,
      view = { ...contract, minutes: bar },
      at = ctDataAt(data, bar),
      horizons = ctOverviewHorizons(bar, "crypto");
    const hurdle = ctCostHurdle(at, view, { horizons, stride: ctOverviewStride(bar) });
    assert.equal(overview.roundTripCostPct, hurdle.roundTripCostPct);
    assert.equal(b.meanBarRangePct, hurdle.meanBarRangePct, `${bar}m mean range`);
    assert.equal(b.costToMeanBarRange, hurdle.costToMeanBarRange);
    assert.equal(b.sampledEntries, hurdle.sampledEntries);
    assert.deepEqual(b.volatilityCutoffsPct, [hurdle.volatilityCutoffsPct.prior60BarRangeP33, hurdle.volatilityCutoffsPct.prior60BarRangeP67]);
    assert.equal(b.horizons.length, hurdle.horizons.length);
    b.horizons.forEach((values, i) => {
      const r = row(CT_OVERVIEW_COLUMNS.horizons, values),
        h = hurdle.horizons[i];
      assert.equal(r.holdBars, h.bars);
      assert.equal(r.holdMinutes, h.bars * bar, "holding time in minutes and bars");
      assert.deepEqual([r.n, r.mfeP25, r.mfeP50, r.mfeP75, r.mfeP90, r.maeP50, r.retMean], [h.n, h.mfePct.p25, h.mfePct.p50, h.mfePct.p75, h.mfePct.p90, h.maePct.p50, h.retMeanPct], `${bar}m hold ${h.bars}`);
      assert.deepEqual([r.hit1x, r.hit2x, r.hit3x], [h.hit1xPct, h.hit2xPct, h.hit3xPct]);
    });
    const time = b.byTime.map((v) => row(CT_OVERVIEW_COLUMNS.byTime, v));
    assert.equal(time.length, hurdle.byTime.length);
    time.forEach((r, i) => {
      const h = hurdle.byTime[i];
      assert.deepEqual([r.bucket, r.holdMinutes, r.n, r.mfeP50, r.hit1x, r.hit2x], [h.bucket, h.bars * bar, h.n, h.mfeP50, h.hit1xPct, h.hit2xPct]);
      assert.ok(r.hit3x <= r.hit2x && r.hit2x <= r.hit1x);
    });
    const vol = b.byVolatility.map((v) => row(CT_OVERVIEW_COLUMNS.byVolatility, v));
    vol.forEach((r, i) => {
      const h = hurdle.byVolatility[i];
      assert.deepEqual([r.regime, r.holdMinutes, r.n, r.mfeP50, r.hit1x, r.hit2x], [h.regime, h.bars * bar, h.n, h.mfeP50, h.hit1xPct, h.hit2xPct]);
      assert.ok(r.hit3x <= r.hit2x);
    });
    const params = { ...CT_OVERVIEW_LABEL, barMinutes: bar };
    const report = ctLabelMovesReport(params, ctRunLabels(params, data, contract), contract, "overview-check");
    assert.deepEqual([b.labels.validMoments, b.labels.positivePct, b.labels.events, b.labels.eventsPerDay], [report.validMoments, report.baseRatePct, report.events, report.eventsPerDay], `${bar}m labels`);
  }
  // Holding times are shared minutes: a bar shows the ones that are whole multiples of it.
  assert.deepEqual(ctOverviewHorizons(1, "crypto"), [5, 15, 60, 240, 720, 0]);
  assert.deepEqual(ctOverviewHorizons(15, "crypto"), [1, 4, 16, 48, 0]);
  assert.deepEqual(ctOverviewHorizons(60, "crypto"), [1, 4, 12, 0]);
  // The one-minute section is the cost_hurdle table itself at those horizons (same stride, same entries).
  const plain = ctCostHurdle(data, contract);
  for (const values of overview.bars[0].horizons) {
    const r = row(CT_OVERVIEW_COLUMNS.horizons, values),
      h = plain.horizons.find((x) => x.bars === r.holdBars);
    assert.deepEqual([r.n, r.mfeP50, r.hit1x, r.hit2x, r.hit3x], [h.n, h.mfePct.p50, h.hit1xPct, h.hit2xPct, h.hit3xPct]);
  }
});

test("stocks: 1/5/15-minute bars only, session-third buckets, no 12-hour hold", () => {
  const from = Date.UTC(2026, 0, 5);
  const c = { ...contractFor("stock", from, 8), engine: CT_ENGINE, policy: CT_POLICY };
  const overview = ctBarOverview({ NVDA: stockWalk(23, from, 8, 100, 0.0006) }, c);
  assert.deepEqual(overview.bars.map((b) => b.barMinutes), [1, 5, 15]);
  assert.ok(overview.bars.every((b) => b.horizons.every((h) => h[0] !== 720)));
  assert.deepEqual([...new Set(overview.bars[2].byTime.map((r) => r[0]))], ["개장 60분", "장 중반", "마감 60분"]);
  assert.ok(overview.bars.every((b) => b.sampledEntries > 0));
});

test("without a bar choice only the contract's own bar is measured (5-minute data, or a contract before free bars)", () => {
  assert.deepEqual(ctBarOverview(ctDataAt(data, 5), { ...contract, minutes: 5 }).bars.map((b) => b.barMinutes), [5]);
  assert.deepEqual(ctBarOverview(data, { ...contract, policy: { ...CT_POLICY, traderTools: 3 } }).bars.map((b) => b.barMinutes), [1]);
});

/* ------------------------------------------------------------------ frozen bytes */

const fixture = (policy) => {
  const ct = ctState();
  ct.contract = { ...ct.contract, minutes: 1, policy };
  ct.playbook = { entries: [], cumulativeTests: 12, priorRuns: 2, omitted: 3 };
  ct.lessons = { note: "n", entries: [], deadFamilies: [], coverage: { note: "c" } };
  return ct;
};
const session = { index: 0, kind: "design", status: "open", startedAt: "", turns: 0, toolCalls: 0, screens: 0, messages: 0 };

test("traderTools 4 keeps its brief, tools and stable block byte for byte; 5 adds barOverview after costHurdle and says it is free", () => {
  const v4 = { policy: { ...CT_POLICY, traderTools: 4 } };
  // Pinned from the code before this change (HEAD e87ae79), where tool version 4 was the newest.
  assert.equal(sha(CT_DESIGNER_SYSTEM_STAGE6), "f3102e453b4677fdeb3192ead49c9b218f5cef280acbf709d7ad6a81b6e1e440");
  assert.equal(ctDesignerSystem(v4), CT_DESIGNER_SYSTEM_STAGE6);
  assert.equal(sha(research.ctSessionTools(v4)), "a9c1ed2be37725b7070388389e31cc9d6117a1820f1227e116a90007604b3685");
  assert.equal(research.ctSessionTools({ policy: { ...CT_POLICY, traderTools: 5 } }), research.ctSessionTools(v4), "the bar overview needs no new tool definition");
  const overview = ctBarOverview(data, contract);
  for (const given of [undefined, overview]) {
    const old = ctSessionContext(fixture(v4.policy), "연구 방향", { note: "h", rows: [] }, session, given);
    assert.equal(sha(old.stable), "7e660c96789aebb6a82c485fab8a5029e990054d864702e41d3bda9a31710cea");
    assert.equal(sha(old.history), "ba68511221cddf1f8a257e2c29b8bbb31234f992c7453c056879eb21d563080b");
    assert.equal(sha(old.task), "747cda8ca99a6ff9dea2d4f63cd42b990b472f2f17a454c50a568e898eb02ed0");
    assert.doesNotMatch(old.stable, /barOverview/);
  }
  const now = ctSessionContext(fixture(CT_POLICY), "연구 방향", { note: "h", rows: [] }, session, overview);
  const keys = Object.keys(JSON.parse(now.stable));
  assert.equal(keys.indexOf("barOverview"), keys.indexOf("costHurdle") + 1);
  assert.deepEqual(JSON.parse(now.stable).barOverview, overview);
  assert.match(now.task, /barOverview\(봉별 개요 · 무료, 검정 아님\)/);
  assert.equal(ctDesignerSystem({ policy: CT_POLICY }), CT_DESIGNER_SYSTEM);
  assert.match(CT_DESIGNER_SYSTEM, /The bar overview is free/);
  assert.match(CT_DESIGNER_SYSTEM, /not a hypothesis test and nothing in it is added to the ledger/);
  assert.match(CT_DESIGNER_SYSTEM, /barOverview covers every bar/);
  assert.match(CT_DESIGNER_SYSTEM, /never sweep them/, "the free-bar warning about sweeping stays");
  assert.doesNotMatch(CT_DESIGNER_SYSTEM_STAGE6, /barOverview/);
});

/* ------------------------------------------------------------------ the session start */

let sequence = 0;
async function opened(policy) {
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled' WHERE status='running'");
  const ct = ctState();
  ct.phase = "design";
  ct.contract = { ...contract, policy };
  ct.dataHash = await ctHash(data);
  const now = new Date().toISOString();
  const j = { id: `overview-${++sequence}`, ownerId: "owner", slot: "open", status: "running", stageIndex: 0, createdAt: now, updatedAt: now, from: "2025-01-01", to: "2025-01-12", capitalUsd: 1e6, budgetUsd: 8, costUsd: 0, brief: "", events: [], calls: [], universe: ["BTCUSDT"], ct };
  await store.createGenerationJob(j);
  sqlite.prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)").run(j.id, "BTCUSDT", ct.contract.toMs, JSON.stringify(bars));
  // The first step opens the research session (cost hurdle, bar overview, context); no model call yet.
  const out = await flow.advanceGeneration(j.id);
  assert.equal(out.ct.sessions.length, 1);
  const first = JSON.parse(sqlite.prepare("SELECT payload FROM ct_session_messages WHERE run_id=? AND session=0 ORDER BY seq").get(j.id).payload);
  return { job: out, stable: first.content[0].text };
}

test("the session start puts the overview in the cached block as a server tool, and the ledger stays empty", async () => {
  const { job, stable } = await opened(CT_POLICY);
  const names = job.ct.tools.map((t) => t.name);
  assert.ok(names.indexOf("bar_overview") > names.indexOf("cost_hurdle"), names.join(" > "));
  assert.equal(job.ct.tools.find((t) => t.name === "bar_overview").status, "completed");
  assert.deepEqual(Object.keys(job.ct.tests?.signatures ?? {}), [], "the overview is not a hypothesis test");
  const block = JSON.parse(stable.replace(/^<context>\n/, "").replace(/\n<\/context>$/, ""));
  assert.deepEqual(block.barOverview, ctBarOverview(data, job.ct.contract));
  // A tool version 4 contract opens exactly as before: no overview, no extra tool.
  const before = await opened({ ...CT_POLICY, traderTools: 4 });
  assert.equal(before.job.ct.tools.some((t) => t.name === "bar_overview"), false);
  assert.doesNotMatch(before.stable, /barOverview/);
});
