// traderTools 8: cost-lean designer sessions (docs/ct.md「비용 절감 세션」). Run c58b159a ($3.13) paid ~$0.99 for four
// one-error-at-a-time submission refusals and $1.52 for a third session after two sessions without usable components.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { CT_POLICY, CT_POLICY_V7, ctPolicyForNewContract, ctSessionPolicy, ctHash } from "../lib/ct-spec.ts";
import { CT_DESIGNER_SYSTEM_BOOK, CT_DESIGNER_SYSTEM_LEAN, ctDesignerSystem, ctCandidateIssues, validateCTCandidate } from "../lib/ct-research.ts";
import { ctApplySubmissionEdits, ctCompactAnswer, ctTabulate, ctTurnEffort, CT_AMEND_HINT } from "../lib/ct-lean.ts";
import { plantedContract } from "./helpers/ct-trader-fixture.mjs";
import { ctState, bars, candidate } from "./helpers/ct-fixture.mjs";
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
    return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } };
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
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  DB: { prepare: (s) => new Statement(s), batch: async (ss) => Promise.all(ss.map((s) => s.run())) },
};
globalThis.__strategyTestHooks = {
  call: () => {
    throw new Error("unexpected model call");
  },
};
const { usageCostUsd } = await import("../lib/llm-usage.ts");
const research = await import("../lib/ct-research-store.ts"),
  store = await import("../lib/strategy-generation-store.ts"),
  flow = await import("../lib/strategy-generation.ts");
await research.ensureCTSchema();

test("new contracts freeze traderTools 8; policy 7 keeps its brief and tools byte for byte", () => {
  assert.equal(CT_POLICY.traderTools, 8);
  assert.equal(ctSessionPolicy({ policy: CT_POLICY }).lean, true);
  assert.equal(ctSessionPolicy({ policy: CT_POLICY }).book, true);
  assert.equal(ctSessionPolicy({ policy: CT_POLICY_V7 }).lean, false);
  assert.equal(ctDesignerSystem({ policy: CT_POLICY_V7 }), CT_DESIGNER_SYSTEM_BOOK);
  assert.equal(ctDesignerSystem({ policy: CT_POLICY }), CT_DESIGNER_SYSTEM_LEAN);
  assert.ok(CT_DESIGNER_SYSTEM_LEAN.startsWith(CT_DESIGNER_SYSTEM_BOOK));
  assert.equal(research.ctSessionTools({ policy: CT_POLICY_V7 }), research.CT_SESSION_TOOLS_BOOK);
  const lean = research.ctSessionTools({ policy: CT_POLICY });
  assert.equal(lean, research.CT_SESSION_TOOLS_LEAN);
  assert.deepEqual(lean.map((t) => t.name), [...research.CT_SESSION_TOOLS_BOOK.map((t) => t.name), "amend_submission"]);
  for (const t of research.CT_SESSION_TOOLS_BOOK) {
    const same = lean.find((x) => x.name === t.name);
    if (t.name === "submit_candidates") assert.ok(same.description.startsWith(t.description) && same.input_schema === t.input_schema);
    else assert.equal(same, t, `${t.name} must stay the book tool object`);
  }
  const old = process.env.QQUAN_CT_POLICY_VERSION;
  try {
    process.env.QQUAN_CT_POLICY_VERSION = "7";
    assert.equal(ctPolicyForNewContract(), CT_POLICY_V7);
    delete process.env.QQUAN_CT_POLICY_VERSION;
    assert.equal(ctPolicyForNewContract(), CT_POLICY);
  } finally {
    if (old === undefined) delete process.env.QQUAN_CT_POLICY_VERSION;
    else process.env.QQUAN_CT_POLICY_VERSION = old;
  }
});

test("amend edits set, append and remove by dotted path on a copy, and refuse unknown or prototype paths", () => {
  const draft = { candidates: [{ selfRebuttal: [{ chance: "짧음" }] }], noEdgeReason: null, rejectedHypotheses: [] };
  const out = ctApplySubmissionEdits(draft, [
    { path: "candidates.0.selfRebuttal.0.chance", value: "열 글자가 넘는 우연 설명입니다" },
    { path: "candidates.0.selfRebuttal.-", value: { chance: "추가", check: "c", excluded: "no" } },
    { path: "rejectedHypotheses", value: [{ hypothesis: "h" }] },
    { path: "noEdgeReason", remove: true },
  ]);
  assert.equal(out.candidates[0].selfRebuttal[0].chance, "열 글자가 넘는 우연 설명입니다");
  assert.equal(out.candidates[0].selfRebuttal.length, 2);
  assert.equal("noEdgeReason" in out, false);
  assert.equal(draft.candidates[0].selfRebuttal[0].chance, "짧음", "the stored draft is not mutated");
  assert.throws(() => ctApplySubmissionEdits(draft, [{ path: "candidates.3.spec", value: 1 }]), /경로 없음/);
  assert.throws(() => ctApplySubmissionEdits(draft, [{ path: "__proto__.polluted", value: 1 }]), /잘못된 경로/);
  assert.throws(() => ctApplySubmissionEdits(undefined, [{ path: "a", value: 1 }]), /직전 제출이 없습니다/);
  assert.equal({}.polluted, undefined);
});

test("column tables keep every value and cut a query answer's size", () => {
  const exitCompare = Array.from({ length: 14 }, (_, i) => ({
    mode: i % 2 ? "fixed" : "trail",
    label: `손절 ${i}`,
    events: 98,
    winRatePct: 18.37 + i,
    avgR: -0.258,
    netMeanPct: -0.41,
    netMean2xCostPct: -0.72,
    dailyNetPct: -0.18,
    exits: i % 2 ? { stop: 55.1, target: 13.27 } : { stop: 48.98, trail: 24.49 },
  }));
  const horizons = [6, 12, 24].map((bars) => ({ bars, grossRetPct: { mean: 0.02, p10: -0.8 }, netMeanPct: -0.29 }));
  const out = { queryId: "q", events: 98, horizons, exitCompare, grid: [], multipleTesting: { hypothesisTests: 3 } };
  const compact = ctCompactAnswer(out);
  assert.equal(compact.queryId, "q");
  assert.deepEqual(compact.grid, []);
  assert.deepEqual(compact.multipleTesting, out.multipleTesting);
  const back = (t) => t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
  const e = back(compact.exitCompare);
  assert.equal(e.length, 14);
  assert.equal(e[1]["exits.target"], 13.27);
  assert.equal(e[0]["exits.target"], null, "a missing cell is null");
  assert.equal(e[0]["exits.trail"], 24.49);
  assert.equal(back(compact.horizons)[2]["grossRetPct.p10"], -0.8);
  assert.match(compact.tableFormat, /exitCompare/);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(out).length * 0.75, `${JSON.stringify(compact).length} vs ${JSON.stringify(out).length}`);
  assert.deepEqual(ctTabulate([{ a: 1 }, { b: 2 }]), { columns: ["a", "b"], rows: [[1, null], [null, 2]] });
});

test("measurement turns run at medium; deciding, refused and final turns at high", () => {
  assert.equal(ctTurnEffort(["query_conditional_returns", "label_moves"], { finalNotice: false, refused: false }), "medium");
  assert.equal(ctTurnEffort(["view_charts"], { finalNotice: false, refused: false }), "medium");
  assert.equal(ctTurnEffort(["query_conditional_returns", "screen_rule"], { finalNotice: false, refused: false }), "high");
  assert.equal(ctTurnEffort(["diagnose_trades"], { finalNotice: false, refused: false }), "high");
  assert.equal(ctTurnEffort(["query_conditional_returns"], { finalNotice: true, refused: false }), "high");
  assert.equal(ctTurnEffort(["submit_candidates"], { finalNotice: false, refused: true }), "high");
});

test("detailed candidate issues list every problem; the legacy error stays the first one, unchanged", () => {
  const ct = ctState();
  const c = candidate();
  c.evidenceVersion = 2;
  c.memoryIds = ["ghost-memory"];
  c.mapping = [{ ...c.mapping[0], feature: "volume_ratio" }];
  c.spec.sourceIds = ["verified", "unknown-q"];
  const legacy = (() => {
    try {
      validateCTCandidate(c, ct);
    } catch (error) {
      return error.message;
    }
  })();
  assert.equal(legacy, "허용되지 않은 연구 기억");
  const issues = ctCandidateIssues(c, ct);
  assert.deepEqual(issues, ["허용되지 않은 연구 기억", issues[1], "확인되지 않은 근거 id: unknown-q", "서술·실행 규칙 추적 불일치"]);
  assert.match(issues[1], /^selfRebuttal: .*3가지/);
  const detailed = ctCandidateIssues(c, ct, true);
  assert.equal(detailed.length, 4);
  assert.match(detailed[0], /ghost-memory/);
  assert.match(detailed[1], /지금 0개/);
  assert.match(detailed[3], /stage 0 condition 0의 mapping\.feature volume_ratio ≠ 규칙/);
});

test("Haiku 5.5 is priced at $0.10/$0.50 up to 100K prompt tokens and 5x beyond", () => {
  assert.equal(usageCostUsd("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 0 }), 0.01);
  assert.equal(usageCostUsd("claude-haiku-5-5", { input_tokens: 0, output_tokens: 1_000_000 }), 0.5);
  assert.equal(usageCostUsd("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 1000 }), 0.1025, "beyond 100K: $0.50/$2.50");
  assert.equal(usageCostUsd("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 }), 2);
});

const job = (id, ct, extra = {}) => ({
  id,
  ownerId: "owner",
  slot: "open",
  status: "running",
  stageIndex: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  from: "2025-01-01",
  to: "2025-01-04",
  capitalUsd: 1000,
  budgetUsd: 8,
  costUsd: 0,
  brief: "",
  events: [],
  calls: [],
  universe: ["KRW-BTC"],
  ct,
  ...extra,
});
const turnWith = (...uses) => ({
  content: uses.map(([name, input], i) => ({ type: "tool_use", id: `${name}-${i}-${Math.random()}`, name, input })),
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 100 },
});

test("a refused submission lists every issue once; amend_submission fixes it; effort switches by turn kind", async () => {
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled'");
  const ct = ctState();
  ct.contract.policy = { ...CT_POLICY, lessonReserveUsd: 0 };
  ct.dataHash = await ctHash({ "KRW-BTC": bars(864) });
  const j = job("lean-amend-fixture", ct);
  await store.createGenerationJob(j);
  sqlite.prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)").run(j.id, "KRW-BTC", ct.contract.toMs, JSON.stringify(bars(864)));
  const turns = [
    turnWith(["query_conditional_returns", { stages: [], horizons: [6] }]),
    // Two problems at once: no noEdgeReason for zero candidates, and a whyNotAlone under 10 characters.
    turnWith(["submit_candidates", { candidates: [], components: [{ ...candidate(), whyNotAlone: "짧다" }], noEdgeReason: null, rejectedHypotheses: [] }]),
    turnWith(["amend_submission", { edits: [{ path: "noEdgeReason", value: "학습 구간에서 비용을 넘는 규칙이 없었습니다" }, { path: "components", value: [] }] }]),
  ];
  let calls = 0;
  globalThis.__strategyTestHooks.turn = () => turns[calls++];
  for (let i = 0; i < 12 && calls < turns.length; i++) await flow.advanceGeneration(j.id);
  await flow.advanceGeneration(j.id);
  const saved = await store.getGenerationJob(j.id);
  const rows = sqlite.prepare("SELECT payload FROM ct_session_messages WHERE run_id=? AND session=0 ORDER BY seq").all(j.id).map((r) => JSON.parse(r.payload));
  const refusal = rows.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_result" && b.is_error && /제출 거부/.test(b.content));
  assert.ok(refusal, JSON.stringify(rows.map((m) => m.role)));
  assert.match(refusal.content, /문제 2개/);
  assert.match(refusal.content, /noEdgeReason/);
  assert.match(refusal.content, /whyNotAlone/);
  assert.ok(refusal.content.includes(CT_AMEND_HINT));
  const efforts = rows.filter((m) => m.role === "system").map((m) => m.output_config.effort);
  assert.deepEqual(efforts, ["medium", "high"], "medium after the query turn, high again after the refusal");
  assert.equal(saved.ct.sessions[0].status, "submitted");
  assert.equal(saved.ct.sessions[0].draft, undefined);
  assert.equal(saved.ct.emptySessions, 1);
  assert.equal(saved.ct.phase, "reflect");
});

test("a components-only session whose components all fail training counts as empty; two in a row end the run", async () => {
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled'");
  const DAY = 86400000, start = Date.UTC(2025, 0, 15), raw = [];
  for (let day = 0; day < 40; day++)
    for (let m = 0; m < 1440; m++) {
      const open = 100 + (m % 7) * 0.01, close = 100 + ((m + 1) % 7) * 0.01;
      raw.push({ startMs: start + day * DAY + m * 60000, endMs: start + day * DAY + (m + 1) * 60000, open, close, high: Math.max(open, close) + 0.001, low: Math.min(open, close) - 0.001, volume: 1e5 });
    }
  const c = { ...plantedContract({ days: 40, trainingDays: 30, start }), policy: { ...CT_POLICY, lessonReserveUsd: 0 } };
  // A volume ratio of 50 never happens in flat volume: zero events, so the component gate fails on training.
  const spec = { version: 1, engine: c.engine, name: "never", market: "crypto", symbols: ["BTCUSDT"], minutes: 1, stages: [{ label: "never", maxGapBars: 1, conditions: [{ feature: "volume_ratio", lookback: 2, offset: 0, timeframe: 1, op: "gte", value: 50 }] }], entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 }, exit: { stopPct: 0.6, targetPct: 1.2, maxHoldBars: 6, invalidation: "stop" }, sizing: { riskPct: 0.5, allocationPct: 25, maxPositions: 1, cooldownBars: 8, participationPct: 1 }, sourceIds: ["verified"], assumptions: ["Synthetic fixture, not evidence of market edge."] };
  const component = { id: "dead-0", hash: "dead-0", session: 1, grade: "pending", whyNotAlone: "Synthetic component, never fires.", candidate: { ...candidate(), spec } };
  const ct = {
    ...ctState(),
    phase: "book",
    contract: c,
    dataHash: await ctHash({ BTCUSDT: raw }),
    components: [component],
    emptySessions: 1,
    sessions: [
      { index: 0, kind: "design", status: "submitted", turns: 1, toolCalls: 1, screens: 0, messages: 2, graded: true, submission: { candidates: 0, accepted: 0, components: 0, acceptedComponents: 0, duplicates: 0, noEdgeReason: "x", rejectedHypotheses: [] } },
      { index: 1, kind: "reflect", status: "submitted", turns: 1, toolCalls: 1, screens: 0, messages: 2, bookable: true, submission: { candidates: 0, accepted: 0, components: 1, acceptedComponents: 1, duplicates: 0, noEdgeReason: "x", rejectedHypotheses: [] } },
    ],
  };
  const j = job("lean-dead-components", ct, { universe: ["BTCUSDT"] });
  await store.createGenerationJob(j);
  sqlite.prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)").run(j.id, "BTCUSDT", c.toMs, JSON.stringify(raw));
  await flow.advanceGeneration(j.id);
  const saved = await store.getGenerationJob(j.id);
  assert.equal(saved.ct.components[0].grade, "training_failed");
  assert.equal(saved.ct.sessions[1].graded, true);
  assert.equal(saved.ct.emptySessions, 2);
  assert.equal(saved.ct.phase, "done", saved.ct.endReason);
  assert.match(saved.ct.endReason, /두 세션 연속 쓸 수 있는 후보·부품 없음/);
});
