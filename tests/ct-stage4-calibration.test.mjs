// Stage 4: calibration records (the designer's eye) — power table, verdicts, migration of what stage 3 filed as rejected ideas,
// the leak rule, and the cumulative test count that does not double-count a rerun.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { ctState } from "./helpers/ct-fixture.mjs";
import { plantedContract, DAY } from "./helpers/ct-trader-fixture.mjs";
import { ctBlindNeededHits, ctBlindPower, ctCalibrationVerdict, ctGradeBlind, ctBinomialUpperP, ctCalibrationFacts } from "../lib/ct-trader-tools.ts";
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
globalThis.__strategyTestEnv = { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x", DB: { prepare: (s) => new Statement(s), batch: async (ss) => Promise.all(ss.map((s) => s.run())) } };
const research = await import("../lib/ct-research-store.ts");
const store = await import("../lib/strategy-generation-store.ts");
const playbook = await import("../lib/ct-playbook.ts");
const calibration = await import("../lib/ct-calibration.ts");
await research.ensureCTSchema();
const contract = plantedContract();

test("the power table of the brief: set size → hits needed → chance to catch a real 70% / 75% eye", () => {
  // n, hits needed (p < 0.05), power at 70%, power at 75% — exact binomial values (the brief's 24-chart 70% figure 0.57 is 0.5647 exactly).
  for (const [n, need, p70, p75] of [[8, 7, 0.26, 0.37], [16, 12, 0.45, 0.63], [24, 17, 0.57, 0.77], [32, 22, 0.64, 0.85]]) {
    assert.equal(ctBlindNeededHits(n), need, `n=${n}`);
    assert.ok(Math.abs(ctBlindPower(n, 0.7) - p70) <= 0.0101, `n=${n}: ${ctBlindPower(n, 0.7)}`);
    assert.ok(Math.abs(ctBlindPower(n, 0.75) - p75) <= 0.0101, `n=${n}: ${ctBlindPower(n, 0.75)}`);
    assert.ok(ctBinomialUpperP(n, need, 0.5) < 0.05 && ctBinomialUpperP(n, need - 1, 0.5) >= 0.05, "the smallest significant hit count");
  }
  assert.ok(Math.abs(ctBinomialUpperP(8, 6, 0.5) - 0.1445) < 0.0005, "6 of 8 is p = 0.145");
  assert.ok(Math.abs(ctBinomialUpperP(8, 4, 0.5) - 0.637) < 0.001, "4 of 8 is p = 0.637");
});

test("verdicts: skill needs p < 0.05; 'no skill' needs a set big enough to catch a 70% eye (power ≥ 0.8); everything else is inconclusive", () => {
  assert.equal(ctCalibrationVerdict(8, 6), "inconclusive", "the run that started this: 6 of 8");
  assert.equal(ctCalibrationVerdict(8, 4), "inconclusive");
  assert.equal(ctCalibrationVerdict(8, 7), "skill");
  assert.equal(ctCalibrationVerdict(24, 17), "skill");
  assert.equal(ctCalibrationVerdict(24, 16), "inconclusive", "24 charts cannot reach 80% power for a 70% eye");
  assert.equal(ctCalibrationVerdict(32, 17), "inconclusive");
  assert.equal(ctCalibrationVerdict(48, 24), "no_skill");
  assert.equal(ctCalibrationVerdict(48, 31), "skill");
  let smallest = 8;
  while (ctBlindPower(smallest, 0.7) < 0.8) smallest++;
  assert.equal(ctCalibrationVerdict(smallest, Math.floor(smallest / 2)), "no_skill");
  assert.equal(ctCalibrationVerdict(smallest - 1, Math.floor((smallest - 1) / 2)), "inconclusive", "one chart fewer cannot say it");
  const facts = ctCalibrationFacts(16, 8);
  assert.deepEqual([facts.verdict, facts.neededHitsForSignificance, facts.powerIfEyeIs70Pct, facts.powerIfEyeIs75Pct], ["inconclusive", 12, 0.45, 0.63]);
  // The grade_blind result of a stage-4 contract carries them; the stage-3 result does not.
  const set = { blindId: "b", session: 0, order: Array.from({ length: 16 }, (_, k) => ({ chart: k + 1, group: k % 2 ? "positive" : "control" })) };
  const predictions = set.order.map((o, k) => ({ chart: o.chart, call: k < 12 ? o.group : o.group === "positive" ? "control" : "positive" }));
  const v4 = ctGradeBlind(set, predictions, { calibration: true });
  assert.deepEqual([v4.correct, v4.total, v4.verdict, v4.neededHitsForSignificance], [12, 16, "skill", 12]);
  assert.match(v4.reading, /16장 중 12장 적중/);
  const v3 = ctGradeBlind(set, predictions);
  assert.ok(!("verdict" in v3) && !("neededHitsForSignificance" in v3));
});

async function plantRun(id, { blinds, rows = [], sigs = {}, symbols = ["BTCUSDT"], created = Date.now(), over = {} }) {
  const sessions = [{ index: 0, kind: "design", status: "submitted", startedAt: "", turns: 1, toolCalls: 1, screens: 0, messages: 2, submission: { candidates: 0, accepted: 0, duplicates: 0, noEdgeReason: "x", rejectedHypotheses: [] } }];
  const ct = { ...ctState(), phase: "done", endReason: "설계자 판단", contract: { ...contract, symbols }, dataHash: "d", blinds, tests: { signatures: sigs }, sessions, ...over };
  await store.createGenerationJob({ id, ownerId: "owner", slot: "open", status: "completed", stageIndex: 0, createdAt: new Date(created).toISOString(), updatedAt: new Date(created).toISOString(), from: "a", to: "b", capitalUsd: 1, budgetUsd: 8, costUsd: 0, brief: "", events: [], calls: [], universe: symbols, ct });
  sqlite.prepare("UPDATE strategy_generation_runs SET created_at=? WHERE id=?").run(created, id);
  for (const r of rows)
    sqlite.prepare("INSERT INTO ct_playbook (id,owner_id,run_id,market,symbols,timeframe,comparable,mechanism,structure,evidence_kind,evidence_ref,grade,reason,measured_from,measured_to,cost_profile,engine,source,detail,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(r.id, "owner", id, "crypto", JSON.stringify(symbols), "1m", 1, r.mechanism, "s", "queryId", r.evidence, "rejected_in_training", "r", contract.fromMs, contract.trainingToMs, "", "ct-pattern-3", "research", "{}", 1);
}

test("the 'eye' rows stage 3 filed as rejected trading ideas move to calibration records; the migration is idempotent and a backfill cannot revive them", async () => {
  sqlite.exec("DELETE FROM ct_playbook; DELETE FROM ct_playbook_runs; DELETE FROM ct_calibration; DELETE FROM strategy_generation_runs;");
  playbook.resetPlaybookBackfill();
  const bcf = "bcf289ab-41d9-4bc7-9598-824276520eb8";
  await plantRun(bcf, {
    blinds: { "1c7d8df3abca": { blindId: "1c7d8df3abca", session: 0, order: [], graded: { correct: 6, total: 8, accuracyPct: 75, pValue: 0.145 }, gradedKey: "k" } },
    rows: [
      { id: `${bcf}:rej:0:4`, mechanism: "차트 형태(위치·거래량)로 사건과 대조군을 눈으로 구분할 수 있다", evidence: "1c7d8df3abca" },
      { id: `${bcf}:rej:0:0`, mechanism: "고변동 사건 직전 특징으로 +5×비용 움직임을 고를 수 있다", evidence: "a922076fa3f7a094" },
    ],
    over: { sessions: [{ index: 0, kind: "design", status: "submitted", startedAt: "", turns: 3, toolCalls: 3, screens: 0, messages: 4, submission: { candidates: 0, accepted: 0, duplicates: 0, noEdgeReason: "x", rejectedHypotheses: [
      { hypothesis: "고변동", mechanism: "m", evidence: ["a922076fa3f7a094"], result: "대칭" },
      { hypothesis: "눈", mechanism: "m", evidence: ["1c7d8df3abca"], result: "6/8" },
    ] } }] },
  });
  const nvda = "f8aeaf03-e2a4-4b99-8779-1ae2bcff0569";
  await plantRun(nvda, {
    blinds: { "331f02a4e49b": { blindId: "331f02a4e49b", session: 0, order: [], graded: { correct: 4, total: 8, accuracyPct: 50, pValue: 0.637 }, gradedKey: "k" } },
    rows: [{ id: `${nvda}:rej:0:3`, mechanism: "이벤트 차트의 맥락을 눈으로 보고 양성을 고를 수 있다", evidence: "331f02a4e49b" }, { id: `${nvda}:rej:0:1`, mechanism: "갭 상승 뒤 전일 종가 지지", evidence: "daf94bcb870cef53" }],
    symbols: ["NVDA"],
    over: { contract: { ...contract, market: "stock", symbols: ["NVDA"] } },
  });
  // Mixed evidence (a blind set AND a measurement) is a trading hypothesis and stays.
  sqlite.prepare("INSERT INTO ct_playbook (id,owner_id,run_id,market,symbols,timeframe,comparable,mechanism,structure,evidence_kind,evidence_ref,grade,reason,measured_from,measured_to,cost_profile,engine,source,detail,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`${bcf}:rej:0:9`, "owner", bcf, "crypto", "[]", "1m", 1, "차트로 본 가설을 숫자로도 확인", "s", "queryId", "1c7d8df3abca,q9", "rejected_in_training", "r", contract.fromMs, contract.trainingToMs, "", "e", "research", "{}", 1);

  const first = await calibration.ctMigrateCalibration();
  assert.deepEqual(first, { records: 2, removed: 2 });
  const second = await calibration.ctMigrateCalibration();
  assert.deepEqual(second, { records: 2, removed: 0 }, "idempotent: nothing more to remove, records are replaced by themselves");
  const rows = sqlite.prepare("SELECT * FROM ct_calibration ORDER BY n").all();
  assert.equal(rows.length, 2);
  const b = rows.find((r) => r.run_id === bcf);
  assert.deepEqual([b.n, b.k, b.p_value, b.verdict, b.needed_hits, b.power70, b.source, b.blind_id], [8, 6, 0.145, "inconclusive", 7, 0.26, "migrated", "1c7d8df3abca"]);
  assert.deepEqual([rows.find((r) => r.run_id === nvda).k, rows.find((r) => r.run_id === nvda).p_value], [4, 0.637]);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM ct_playbook WHERE id LIKE '%:rej:0:4' OR id LIKE '%:rej:0:3'").get().n, 0, "the eye rows are gone");
  assert.equal(sqlite.prepare("SELECT count(*) n FROM ct_playbook WHERE id=?").get(`${bcf}:rej:0:0`).n, 1, "a trading hypothesis stays");
  assert.equal(sqlite.prepare("SELECT count(*) n FROM ct_playbook WHERE id=?").get(`${bcf}:rej:0:9`).n, 1, "mixed evidence stays");
  // Recording the run again (or a backfill) never files the eye as a rejected mechanism.
  const job = { id: bcf, ownerId: "owner", ct: JSON.parse(sqlite.prepare("SELECT payload FROM strategy_generation_runs WHERE id=?").get(bcf).payload).ct };
  await playbook.recordCTPlaybook(job, "backfill");
  const filed = sqlite.prepare("SELECT evidence_ref FROM ct_playbook WHERE run_id=?").all(bcf).map((r) => r.evidence_ref);
  assert.ok(!filed.includes("1c7d8df3abca"), JSON.stringify(filed));
  sqlite.exec("DELETE FROM ct_playbook_runs");
  playbook.resetPlaybookBackfill();
  await playbook.backfillPlaybook();
  assert.equal(sqlite.prepare("SELECT count(*) n FROM ct_playbook WHERE evidence_ref='1c7d8df3abca' OR evidence_ref='331f02a4e49b'").get().n, 0, "a re-run backfill does not bring them back");
  // The owner's lists: the playbook no longer carries the eye, the calibration list does.
  const list = await playbook.ctPlaybookList("owner", "crypto");
  assert.ok(list.entries.every((e) => !/눈으로/.test(e.mechanism)));
  const eye = await calibration.ctCalibrationList("owner", "crypto");
  assert.deepEqual(eye.map((e) => [e.n, e.hits, e.verdict]), [[8, 6, "inconclusive"]]);
  assert.match(eye[0].reading, /판별력 없음/);
});

test("the calibration section shown to a new run: verdict and size always, hits and p only where the window cannot leak, pooled over sets", async () => {
  sqlite.exec("DELETE FROM ct_calibration;");
  const mk = (id, run, k, n, over = {}, format = calibration.CT_CHART_FORMAT_BLIND) => calibration.ctRecordCalibration({ ...calibration.ctCalibrationRow({ id: run, ownerId: "owner" }, { contract: { ...contract, ...over } }, id, { correct: k, total: n }, "research", format), id: `${run}:blind:${id}` });
  await mk("b1", "older-1", 6, 8, {}, calibration.CT_CHART_FORMAT_BLIND);
  await mk("b2", "older-2", 18, 24);
  await mk("b0", "format-1", 7, 8, {}, calibration.CT_CHART_FORMAT);
  // A set measured on a window that reaches into the new run's development/final window.
  await mk("b3", "overlap-1", 30, 32, { fromMs: contract.trainingToMs - 2 * DAY, trainingToMs: contract.developmentToMs });
  const snap = await calibration.ctCalibrationSnapshot("owner", { ...contract, market: "crypto" }, "new-run");
  const byRun = Object.fromEntries(snap.records.map((r) => [r.run, r]));
  assert.deepEqual(Object.keys(byRun).sort(), ["format-1", "older-1", "older-2", "overlap-"], JSON.stringify(snap.records.map((r) => r.run)));
  assert.match(byRun["format-1"].chartFormat, /시각 표시/);
  assert.equal(byRun["format-1"].verdict, "skill", "listed with its verdict (7 of 8)");
  assert.equal(byRun["older-2"].chartFormat, "시각 숨김");
  assert.equal(byRun["older-1"].hits, 6);
  assert.equal(byRun["older-2"].verdict, "skill");
  assert.equal(byRun["overlap-"].hits, undefined, "hits are withheld");
  assert.equal(byRun["overlap-"].pValue, undefined);
  assert.equal(byRun["overlap-"].verdict, "skill", "the grade stays");
  assert.match(byRun["overlap-"].measured, /수치 비공개/);
  assert.equal(snap.pooled.sets, 2, "pooling uses only the time-hidden sets whose numbers may be shown (not the overlapping one, not the format with printed times)");
  assert.deepEqual([snap.pooled.n, snap.pooled.hits], [32, 24]);
  assert.equal(snap.pooled.verdict, "skill", "24 of 32 pooled: p < 0.05");
  // Another owner sees nothing; the run itself is excluded.
  assert.equal((await calibration.ctCalibrationSnapshot("someone-else", contract, "new-run")).records.length, 0);
  assert.equal((await calibration.ctCalibrationSnapshot("owner", contract, "older-1")).records.every((r) => r.run !== "older-1"), true);
});

test("cumulative tests across runs count each distinct ledger signature once (a rerun's repeated signatures are not new tests)", async () => {
  sqlite.exec("DELETE FROM ct_playbook; DELETE FROM ct_playbook_runs; DELETE FROM strategy_generation_runs; DELETE FROM ct_calibration;");
  playbook.resetPlaybookBackfill();
  const t = Date.now();
  await plantRun("r1", { blinds: undefined, sigs: { a: 1, b: 2, c: 1 }, created: t - 3000 });
  await plantRun("r2", { blinds: undefined, sigs: { a: 1, b: 1, d: 1 }, created: t - 2000 });
  // An older run from before the ledger carries only its recorded count.
  await plantRun("r0", { blinds: undefined, sigs: {}, created: t - 4000, over: { tests: undefined, queries: [{ queryId: "q", session: 0, at: "", from: 0, to: 1, stages: [], features: [], horizons: [5], events: 1, uniqueDays: 1, summary: "", signature: "z" }] } });
  await playbook.backfillPlaybook();
  const raw = sqlite.prepare("SELECT SUM(hypothesis_tests) n FROM ct_playbook_runs WHERE market='crypto'").get().n;
  assert.equal(raw, 3 + 3 + 1, "the stage-3 sum counts a, b, c, a, b, d and z");
  const stage3 = await playbook.ctPlaybookSnapshot("owner", contract, "new", {});
  assert.equal(stage3.cumulativeTests, 7, "stage-3 contracts keep the raw sum");
  const stage4 = await playbook.ctPlaybookSnapshot("owner", contract, "new", { distinctTests: true });
  assert.equal(stage4.cumulativeTests, 5, "a, b, c, d + the old run without a ledger (1)");
  const withOwn = await playbook.ctDistinctPriorTests("owner", "crypto", "new", ["a", "x", "y"]);
  assert.deepEqual([withOwn.distinctSignatures, withOwn.unsignedRuns, withOwn.total, withOwn.withOwn], [4, 1, 5, 7], "this run's own new signatures x, y add 2; its repeated 'a' adds nothing");
});
