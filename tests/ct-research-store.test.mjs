import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { ctState, candidate, bars } from "./helpers/ct-fixture.mjs";
import { ctHash } from "../lib/ct-spec.ts";
register("./helpers/slot-test-loader.mjs", import.meta.url);
const sqlite = new DatabaseSync(":memory:");
class Statement {
  constructor(sql, values = []) {
    this.sql = sql;
    this.values = values;
  }
  bind(...values) {
    return new Statement(this.sql, values);
  }
  async run() {
    return {
      meta: {
        changes: Number(sqlite.prepare(this.sql).run(...this.values).changes),
      },
    };
  }
  async first() {
    return sqlite.prepare(this.sql).get(...this.values) ?? null;
  }
  async all() {
    return { results: sqlite.prepare(this.sql).all(...this.values) };
  }
  async raw() {
    return (await this.all()).results.map(Object.values);
  }
}
globalThis.__strategyTestEnv = {
  DB: {
    prepare: (s) => new Statement(s),
    batch: async (ss) => Promise.all(ss.map((s) => s.run())),
  },
};
const research = await import("../lib/ct-research-store.ts"),
  store = await import("../lib/strategy-generation-store.ts");
await research.ensureCTSchema();
let sequence = 0;
async function job(phase = "experiment") {
  sqlite.exec(
    "UPDATE strategy_generation_runs SET status='cancelled' WHERE status='running'",
  );
  const ct = ctState();
  ct.phase = phase;
  ct.pending = candidate();
  const data = bars(864);
  ct.dataHash = await ctHash({ "KRW-BTC": data });
  const now = new Date().toISOString(),
    j = {
      id: "ct-fixture-" + ++sequence,
      ownerId: "owner",
      slot: "open",
      status: "running",
      stageIndex: 0,
      createdAt: now,
      updatedAt: now,
      from: "2025-01-01",
      to: "2025-01-04",
      capitalUsd: 1e6,
      budgetUsd: 8,
      costUsd: 0,
      events: [],
      calls: [],
      universe: ["KRW-BTC"],
      ct,
    };
  await store.createGenerationJob(j);
  await store.claimGenerationJob(j.id, "fixture");
  sqlite
    .prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)")
    .run(j.id, "KRW-BTC", ct.contract.toMs, JSON.stringify(data));
  return j;
}
const noModel = async () => {
  throw new Error("unexpected model");
};
test("CT runs actual replay tools, records failure and resumes identical durable outputs without recomputation", async () => {
  const j = await job(),
    snapshot = structuredClone(j);
  await research.advanceCTResearch(j, "fixture", noModel);
  // The fixture fails the training gate: screened out with no development replay or model cost.
  assert.equal(j.ct.trials.length, 0);
  assert.equal(j.ct.screened.length, 1);
  assert.equal(j.ct.backtests, 1);
  assert.ok(j.ct.screened[0].reasons.length);
  assert.ok(j.ct.screened[0].training.trades.length);
  assert.equal(j.ct.submitted, 1);
  assert.equal(j.ct.phase, "reflect");
  const count = sqlite
    .prepare("SELECT count(*) n FROM ct_tools WHERE run_id=?")
    .get(j.id).n;
  await research.advanceCTResearch(snapshot, "fixture", noModel);
  assert.equal(
    sqlite.prepare("SELECT count(*) n FROM ct_tools WHERE run_id=?").get(j.id)
      .n,
    count,
  );
  assert.deepEqual(snapshot.ct.screened[0].training, j.ct.screened[0].training);
  assert.equal(snapshot.ct.backtests, 0, "completed computations reused");
});
test("CT canceled late work cannot write artifacts or register a strategy", async () => {
  const j = await job();
  await store.cancelGenerationJob(structuredClone(j));
  await assert.rejects(
    () => research.advanceCTResearch(j, "fixture", noModel),
    /취소|잠금/,
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) n FROM ct_tools WHERE run_id=?").get(j.id)
      .n,
    0,
  );
  await assert.rejects(() => research.registerCT(j), /완료/);
});
test("CT time/compute and duplicate limits finish normally with no strategy, never a fake pass", async () => {
  for (const limited of ["activeMs", "computeMs", "duplicateCount"]) {
    const j = await job("design");
    j.ct[limited] = limited === "duplicateCount" ? 3 : 1e9;
    await research.advanceCTResearch(j, "fixture", noModel);
    assert.equal(j.status, "completed");
    assert.equal(j.ct.passed, false);
    assert.equal(j.ct.finalConsumed, undefined);
  }
});
/** A legacy pending candidate that passes training and development on synthetic data. */
async function passingJob() {
  sqlite.exec("DELETE FROM ct_exposure");
  const j = await job();
  j.ct.pending.spec.stages[0].conditions.push({
    feature: "volume_ratio",
    lookback: 3,
    offset: 0,
    timeframe: 1,
    op: "gte",
    value: 0.5,
  });
  j.ct.pending.mapping.push({
    stage: 0,
    condition: 1,
    feature: "volume_ratio",
    sourceId: "verified",
    implementationAssumption: "Fixture completion-volume condition.",
  });
  const c = j.ct.contract;
  c.fromMs = Date.UTC(2025, 0, 1);
  c.trainingToMs = Date.UTC(2025, 3, 1);
  c.developmentToMs = Date.UTC(2025, 6, 1);
  c.toMs = Date.UTC(2025, 9, 1);
  const data = Array.from({ length: 273 }, (_, day) =>
    bars(18, c.fromMs + day * 86400000).map((b, i) => ({
      ...b,
      open: 1000 + i * 6,
      close: 1004 + i * 6,
      high: 1005 + i * 6,
      low: 999 + i * 6,
      volume: i < 9 ? 100000 : 100000 / 10 ** (i - 8),
    })),
  ).flat();
  j.ct.dataHash = await ctHash({ "KRW-BTC": data });
  sqlite.prepare("DELETE FROM ct_data_pages WHERE run_id=?").run(j.id);
  sqlite
    .prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)")
    .run(j.id, "KRW-BTC", c.toMs, JSON.stringify(data));
  return j;
}
test("CT independent rejection cannot open final data", async () => {
  const j = await passingJob();
  await research.advanceCTResearch(j, "fixture", noModel);
  j.ct.selectedId = j.ct.trials[0].id;
  j.ct.frozenHash = j.ct.trials[0].hash;
  j.ct.phase = "risk_review";
  await research.advanceCTResearch(j, "fixture", async () => ({
    approved: false,
    blockers: ["source mismatch"],
    findings: [],
    suggestions: [],
  }));
  assert.equal(j.status, "completed");
  assert.equal(j.ct.passed, false);
  assert.equal(j.ct.finalConsumed, undefined);
});
test("CT final overlap is durably consumed across runs and cannot be tuned/reopened", async () => {
  const j = await passingJob();
  await research.advanceCTResearch(j, "fixture", noModel);
  sqlite.exec("DELETE FROM ct_exposure");
  j.ct.selectedId = j.ct.trials[0].id;
  j.ct.frozenHash = j.ct.trials[0].hash;
  j.ct.phase = "final";
  sqlite
    .prepare("INSERT INTO ct_exposure VALUES (?,?,?,?,?,?)")
    .run(
      "prior",
      "crypto",
      JSON.stringify(["KRW-BTC"]),
      j.ct.contract.developmentToMs,
      j.ct.contract.toMs,
      "prior-hash",
    );
  await research.advanceCTResearch(j, "fixture", noModel);
  assert.equal(j.status, "completed");
  assert.equal(j.ct.passed, false);
  assert.match(j.ct.endReason, /소진/);
  assert.equal(j.ct.final, undefined);
});
test("CT reader rejects fabricated and private URLs before any network access", async () => {
  await assert.rejects(
    () => research.readCTSource("https://invented.example/a", []),
    /확인하지/,
  );
  for (const url of [
    "http://example.com",
    "https://127.0.0.1/a",
    "https://foo.local/a",
    "https://user:pass@example.com/a",
  ])
    await assert.rejects(() => research.readCTSource(url, [url]), /차단/);
});
test("CT measured passing fixture freezes, independently reviews, consumes final, registers same executable hash", async () => {
  const j = await passingJob();
  await research.advanceCTResearch(j, "fixture", noModel);
  assert.deepEqual(j.ct.trials[0].reasons, []);
  assert.equal(j.ct.phase, "risk_review");
  const hash = j.ct.frozenHash;
  const reviewed = [];
  const review = async (role, _schema, prompt) => {
    reviewed.push(role);
    if (role === "ctLessons") return { lessons: [] }; // stage 5: the end-of-run distillation (cheap model), nothing to learn here
    assert.ok(prompt.includes(hash) || role === "riskReviewer");
    // Both reviewers weigh the result against the number of tests and the candidate's free numbers.
    assert.match(prompt, /"multipleTesting":\{"hypothesisTests":\d+,"toolCalls":\d+,"note":"[^"]*","candidateFreedom":\{"conditions":\d+,"exit":\d+,"other":\d+,"total":\d+\}\}/);
    assert.match(prompt, /distinct condition combinations/);
    return { approved: true, blockers: [], findings: [], suggestions: [] };
  };
  await research.advanceCTResearch(j, "fixture", review);
  assert.equal(j.ct.phase, "final");
  await research.advanceCTResearch(j, "fixture", noModel);
  assert.equal(j.ct.finalConsumed, true);
  assert.equal(j.ct.phase, "evidence_review");
  await research.advanceCTResearch(j, "fixture", review);
  assert.equal(j.ct.passed, true);
  assert.deepEqual(reviewed, ["riskReviewer", "evidenceReviewer", "ctLessons"]);
  j.calls = [
    { role: "designer", status: "completed", provider: "OpenAI" },
    { role: "riskReviewer", status: "completed", provider: "Anthropic" },
    { role: "evidenceReviewer", status: "completed", provider: "Anthropic" },
  ];
  await store.saveGenerationJob(j, "fixture");
  await research.registerCT(j);
  const registered = (await research.ctPackages("crypto")).find(
    (p) => p.runId === j.id,
  );
  assert.equal(registered.hash, hash);
  assert.equal(registered.final.trades[0].specHash, hash);
});


test("legacy stock collection preserves original pages and requests local preparation without market calls", async () => {
 const j=await job('data');const c=j.ct.contract;c.market='stock';c.symbols=['SPY'];
 sqlite.prepare('INSERT INTO ct_data_pages VALUES (?,?,?,?)').run(j.id,'SPY',c.toMs,JSON.stringify([{legacy:true}]));
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('No network');};
 try {await assert.rejects(()=>research.advanceCTResearch(j,'fixture',noModel),/데이터 준비/);assert.equal(calls,0);assert.equal(JSON.parse(sqlite.prepare('SELECT payload FROM ct_data_pages WHERE run_id=? AND symbol=?').get(j.id,'SPY').payload)[0].legacy,true);}
 finally {globalThis.fetch=original;}
});

test("same board: the orchestrator, not the owner, picks a new direction; 'stop' and repeated answers end the run without asking anyone", async () => {
  const { ctBoardSignature } = await import("../lib/ct-board.ts");
  // An earlier run on this board ended without a passing strategy.
  const prior = await job("done");
  prior.ct.contract.boardSignature = await ctBoardSignature(prior.ct.contract, "");
  sqlite.prepare("UPDATE strategy_generation_runs SET status='completed', payload=? WHERE id=?").run(JSON.stringify({ ...prior, brief: "", status: "completed", ct: { ...prior.ct, passed: false, endReason: "설계 세션 한도 · 통과 전략 없음" } }), prior.id);
  const fresh = async () => {
    const j = await job("data");
    j.brief = "";
    j.ct.contract.boardSignature = prior.ct.contract.boardSignature;
    j.ct.boardRepeat = { previous: [{ id: prior.id, at: prior.createdAt, status: "completed", endReason: "설계 세션 한도 · 통과 전략 없음", phase: "done" }], ownerBrief: "", attempts: [] };
    return j;
  };
  const ended = [];
  const done = (reason) => ended.push(reason);
  // 1) A new direction: becomes the brief, the board changes, and the run goes on (returns false).
  let j = await fresh(), prompts = [];
  const direction = "거래량이 평소의 3배 이상 터진 뒤 첫 눌림에서 직전 고점 돌파를 노리고, 손절은 변동성 기준으로 둔다.";
  assert.equal(await research.ctResolveBoard(j, async (role, _schema, prompt) => (prompts.push([role, prompt]), { decision: "new_direction", brief: direction, rationale: "이전 실행은 돌파 계열을 측정하지 않았다" }), done), false);
  assert.equal(prompts[0][0], "ctOrchestrator");
  assert.match(prompts[0][1], /설계 세션 한도/, "the earlier run's end reason reaches the orchestrator");
  assert.equal(j.brief, direction);
  assert.notEqual(j.ct.contract.boardSignature, prior.ct.contract.boardSignature);
  assert.equal(j.ct.boardRepeat.resolved.brief, direction);
  assert.match(j.events.at(-1).detail, /총괄이 새 연구 방향/);
  assert.equal(ended.length, 0);
  // 2) 'stop': the run ends with the orchestrator's reason.
  j = await fresh();
  assert.equal(await research.ctResolveBoard(j, async () => ({ decision: "stop", brief: "", rationale: "교훈상 이 판의 모든 계열이 이미 측정됐다" }), done), true);
  assert.match(ended.at(-1), /총괄 판단/);
  // 3) Twice the same board (empty brief = the owner's): ends after two tries, the second prompt carries the first answer.
  j = await fresh(); prompts = [];
  assert.equal(await research.ctResolveBoard(j, async (_r, _s, prompt) => (prompts.push(prompt), { decision: "new_direction", brief: "  ", rationale: "같은 방향을 다시 본다" }), done), true);
  assert.equal(prompts.length, 2);
  assert.equal(j.ct.boardRepeat.attempts.length, 2);
  assert.match(ended.at(-1), /다른 연구 방향을 만들지 못함/);
});
