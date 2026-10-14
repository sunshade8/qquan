// CT designer research session (2026-10-13): roles, Opus request shape, training-only tools,
// evidence rules, durable/resumable turns, multi-candidate screening and "no edge" endings.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { ctState, candidate, bars, contract, spec } from "./helpers/ct-fixture.mjs";
import { ctHash, executableCT } from "../lib/ct-spec.ts";
import {
  RESEARCH_MODELS,
  GENERATION_MODELS,
  assertDifferentProvider,
  researchModel,
} from "../lib/strategy-generation-models.ts";
import { assertCTTool } from "../lib/ct-tools.ts";
import { validateCTCandidate, ctSessionContext } from "../lib/ct-research.ts";
import { ctQueryEvents, ctQueryReturns, ctCostHurdle, ctReadBars, ctQuerySpec } from "../lib/ct-design-tools.ts";
import { detectCT, replayCT, ctRoundTripCostPct } from "../lib/ct-engine.ts";
import { agentIdOf, agentModel, callDoing, ctAgents, ctNow, mergeCalls } from "../lib/ct-activity.ts";
register("./helpers/slot-test-loader.mjs", import.meta.url);

const sqlite = new DatabaseSync(":memory:");
let failSessionInsert = 0;
class Statement {
  constructor(sql, values = []) { this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sql, values); }
  async run() {
    // Simulates the runner dying after a paid turn completed, before its message is stored.
    if (failSessionInsert && /INTO ct_session_messages/.test(this.sql)) {
      failSessionInsert--;
      throw new Error("runner killed");
    }
    return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } };
  }
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

/* ------------------------------------------------------------- fixtures */

const MINUTE = 60_000;
/** Four days of 1-minute BTCUSDT bars with a slow wave and bursts of volume. */
function minuteBars(days = 4, start = Date.UTC(2025, 0, 1)) {
  return Array.from({ length: days * 1440 }, (_, i) => {
    const p = 20000 * (1 + 0.004 * Math.sin(i / 47) + 0.002 * Math.sin(i / 7));
    const q = 20000 * (1 + 0.004 * Math.sin((i + 1) / 47) + 0.002 * Math.sin((i + 1) / 7));
    return {
      startMs: start + i * MINUTE, endMs: start + (i + 1) * MINUTE,
      open: p, close: q, high: Math.max(p, q) * 1.0004, low: Math.min(p, q) * 0.9996,
      volume: 10 + (i % 13 === 0 ? 40 : i % 5),
    };
  });
}
function minuteContract(start = Date.UTC(2025, 0, 1)) {
  return {
    ...contract(), symbols: ["BTCUSDT"], minutes: 1, currency: "USDT", timezone: "UTC", capital: 1000,
    costs: { ...contract().costs, minimumOrder: 5, quantityDecimals: 8 },
    fromMs: start, trainingToMs: start + 2 * 86400000, developmentToMs: start + 3 * 86400000, toMs: start + 4 * 86400000,
  };
}
const query = (over = {}) => ({
  stages: [{ maxGapBars: 1, conditions: [{ feature: "return_pct", lookback: 5, offset: 0, timeframe: 1, op: "gte", value: 0.05 }] }],
  horizons: [5, 30], grid: { stopPcts: [0.5], targetPcts: [0.5, 1] }, cooldownBars: 5, ...over,
});

let sequence = 0;
async function sessionJob(over = {}) {
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled' WHERE status='running'");
  const ct = ctState();
  ct.phase = "design";
  const data = over.data ?? bars(864);
  if (over.contract) Object.assign(ct.contract, over.contract);
  ct.dataHash = await ctHash({ "KRW-BTC": data });
  const now = new Date().toISOString();
  const j = { id: "ct-session-" + ++sequence, ownerId: "owner", slot: "open", status: "running", stageIndex: 0, createdAt: now, updatedAt: now,
    from: "2025-01-01", to: "2025-01-04", capitalUsd: 1e6, budgetUsd: 8, costUsd: 0, brief: "", events: [], calls: [], universe: ["KRW-BTC"], ct };
  await store.createGenerationJob(j);
  sqlite.prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)").run(j.id, "KRW-BTC", ct.contract.toMs, JSON.stringify(data));
  return j;
}
const advance = (id) => flow.advanceGeneration(id);
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const reply = (...content) => ({ content: [{ type: "thinking", thinking: "", signature: `sig-${content.map((c) => c.id).join("-")}` }, ...content], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 200 } });
/** A v2 submission draft for the 5-minute KRW-BTC fixture, citing the verified web source. */
const draft = (mutate = () => {}) => {
  const c = structuredClone(candidate());
  delete c.evidenceVersion;
  c.selfRebuttal = [1, 2, 3].map((n) => ({ chance: `우연 가능성 ${n}: 표본이 적거나 한 시기에 몰렸을 수 있음`, check: `월별 분포와 비용 2배 결과로 ${n}번째 가능성을 확인함`, excluded: "partly" }));
  mutate(c);
  return c;
};
const sessionMessages = (id, session = 0) =>
  sqlite.prepare("SELECT payload FROM ct_session_messages WHERE run_id=? AND session=? ORDER BY seq").all(id, session).map((r) => JSON.parse(r.payload));

/* -------------------------------------------------------------- 1 roles */

test("CT roles: Opus designs, OpenAI reviews, same company refused; strategy tab unchanged", () => {
  assert.deepEqual([RESEARCH_MODELS.ctDesigner.provider, RESEARCH_MODELS.ctDesigner.model], ["Anthropic", "claude-opus-5-5"]);
  assert.equal(RESEARCH_MODELS.ctDesigner.effort, "high");
  for (const role of ["ctRiskReviewer", "ctEvidenceReviewer", "ctOrchestrator"])
    assert.deepEqual([RESEARCH_MODELS[role].provider, RESEARCH_MODELS[role].model], ["OpenAI", "gpt-6.1-sol"], role);
  assert.equal(RESEARCH_MODELS.ctOrchestrator.effort, "medium");
  assert.equal(RESEARCH_MODELS.ctAnalyst.model, "gpt-6-luna");
  assert.doesNotThrow(() => assertDifferentProvider("ctDesigner", "ctRiskReviewer"));
  assert.doesNotThrow(() => assertDifferentProvider("ctDesigner", "ctEvidenceReviewer"));
  assert.throws(() => assertDifferentProvider("ctDesigner", "riskReviewer"), /다른 회사/);
  assert.throws(() => assertDifferentProvider("designer", "ctRiskReviewer"), /다른 회사/);
  assert.equal(GENERATION_MODELS.designer.model, "gpt-6.1-sol");
  assert.equal(GENERATION_MODELS.riskReviewer.provider, "Anthropic");
  // Outage fallback stays inside the company.
  assert.deepEqual([researchModel("ctDesigner", 2).provider, researchModel("ctDesigner", 2).model], ["Anthropic", "claude-sonnet-5-5"]);
  assert.equal(researchModel("ctRiskReviewer", 2).model, "gpt-6.1-sol");
  assert.deepEqual(research.ctReviewRoles("ctDesigner"), { author: "ctDesigner", risk: "ctRiskReviewer", evidence: "ctEvidenceReviewer" });
  assert.deepEqual(research.ctReviewRoles(undefined), { author: "designer", risk: "riskReviewer", evidence: "evidenceReviewer" });
});

/* --------------------------------------------------- 2 + 9 Opus request */

function sse(events) {
  return new Response(new ReadableStream({ start(c) {
    for (const e of events) c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    c.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
/** Streams an assistant turn: one thinking block then tool_use blocks, as the API does. */
function claudeTurn(id, tools, usage) {
  const events = [
    { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1, cache_creation_input_tokens: usage.write, cache_read_input_tokens: usage.read } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${id}` } },
    { type: "content_block_stop", index: 0 },
  ];
  tools.forEach((t, k) => {
    events.push(
      { type: "content_block_start", index: k + 1, content_block: { type: "tool_use", id: t.id, name: t.name, input: {} } },
      { type: "content_block_delta", index: k + 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } },
      { type: "content_block_stop", index: k + 1 },
    );
  });
  events.push({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: usage.output } }, { type: "message_stop" });
  return { events, content: [{ type: "thinking", thinking: "", signature: `sig-${id}` }, ...tools.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input }))] };
}

test("Opus session turns: adaptive thinking at explicit high effort, auto tools, cache points, append-only replay; zero candidates ends with no strategy", async () => {
  const original = globalThis.fetch;
  globalThis.__strategyTestHooks.realLlm = true;
  const requests = [];
  const q = query({ stages: [{ maxGapBars: 1, conditions: [{ feature: "return_pct", lookback: 3, offset: 0, timeframe: 1, op: "gte", value: 0 }] }], horizons: [3], grid: null, cooldownBars: 3 });
  const turns = [
    claudeTurn("msg_1", [{ id: "toolu_q", name: "query_conditional_returns", input: q }], { input: 30, write: 12000, read: 0, output: 900 }),
    claudeTurn("msg_2", [{ id: "toolu_s", name: "submit_candidates", input: { candidates: [], noEdgeReason: "비용 장벽을 넘는 조건부 우위가 없음", rejectedHypotheses: [{ hypothesis: "단기 상승 지속", mechanism: "모멘텀", evidence: ["(queryId)"], result: "기준선 대비 차이 없음" }] } }], { input: 40, write: 800, read: 12000, output: 600 }),
  ];
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/v1\/messages$/);
    const body = JSON.parse(options.body);
    requests.push({ body, raw: options.body });
    return sse(turns[requests.length - 1].events);
  };
  try {
    const created = await sessionJob();
    let job = await advance(created.id); // opens session 1 (cost hurdle + context)
    assert.equal(job.ct.sessions[0].status, "open");
    job = await advance(created.id); // turn 1
    job = await advance(created.id); // runs the query
    assert.equal(job.ct.queries.length, 1);
    job = await advance(created.id); // turn 2
    job = await advance(created.id); // runs the submission
    assert.equal(requests.length, 2);
    for (const { body } of requests) {
      assert.equal(body.model, "claude-opus-5-5");
      assert.deepEqual(body.thinking, { type: "adaptive" });
      assert.equal(body.output_config.effort, "high");
      for (const banned of ["temperature", "top_p", "top_k", "budget_tokens"]) assert.equal(banned in body, false, banned);
      assert.equal(JSON.stringify(body.thinking).includes("budget_tokens"), false);
      assert.ok(!body.tool_choice || body.tool_choice.type === "auto");
      assert.equal(body.stream, true);
      assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
      assert.deepEqual(body.cache_control, { type: "ephemeral" });
      // The fixed context block is the explicit breakpoint at the end of the stable prefix.
      const first = body.messages[0].content;
      assert.match(first[0].text, /^<context>/);
      assert.deepEqual(first[0].cache_control, { type: "ephemeral" });
      assert.ok(first.slice(1).every((b) => !b.cache_control));
      // strict grammar for the full DSL is refused by the API (400 "compiled grammar is too large"); the server validates instead.
      assert.equal(body.tools.some((t) => t.strict), false);
      assert.deepEqual(body.tools.map((t) => t.name), ["label_moves", "contrast_moves", "view_charts", "grade_blind", "query_conditional_returns", "read_bars", "screen_rule", "diagnose_trades", "submit_candidates"]);
    }
    // No raw source text or raw price CSV in the designer's input.
    assert.ok(!requests[0].raw.includes(created.ct.sources[0].text));
    assert.ok(!/time,open,high,low,close,volume/.test(requests[0].raw));
    // Turn 2 carries turn 1's assistant content exactly as streamed (thinking signature included).
    const second = requests[1].body.messages;
    assert.equal(second[1].role, "assistant");
    assert.equal(JSON.stringify(second[1].content), JSON.stringify(turns[0].content));
    assert.deepEqual(second.slice(0, 1), requests[0].body.messages, "history is append-only");
    assert.equal(second[2].content[0].type, "tool_result");
    assert.equal(second[2].content[0].tool_use_id, "toolu_q");
    // Usage, cache reads and the payload reference instead of inline content.
    const paid = job.calls.filter((c) => c.role === "ctDesigner");
    assert.equal(paid.length, 2);
    assert.equal(paid[1].usage.cache_read_input_tokens, 12000);
    assert.ok(paid.every((c) => c.result?.ref === "ct_session_messages"));
    assert.equal(paid[0].label, "설계 세션 1 · 턴 1/16");
    // 9: zero candidates is a normal "no passing strategy" ending; the final split stays sealed.
    assert.equal(job.status, "completed");
    assert.equal(job.ct.passed, false);
    assert.match(job.ct.endReason, /우위 미발견 · 통과 전략 없음 · 최종 기간 미개봉/);
    assert.equal(job.ct.finalConsumed, undefined);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM ct_exposure WHERE run_id=?").get(created.id).n, 0);
    assert.equal(job.ct.sessions[0].submission.rejectedHypotheses.length, 1);
    assert.equal(sessionMessages(created.id).length, 5);
  } finally {
    globalThis.fetch = original;
    globalThis.__strategyTestHooks.realLlm = false;
  }
});

/* ------------------------------------------------------- 3 boundaries */

test("training-only tools reject times and look-ahead past the training end", () => {
  // ct-pattern-1 look-ahead is not day-bounded, so events near the training end are dropped.
  const c = { ...minuteContract(), engine: "ct-pattern-1" };
  const ct = { ...ctState(), contract: c, anchors: [c.fromMs + 600 * MINUTE] };
  const ok = { from: c.fromMs, to: c.trainingToMs, dataHash: ct.dataHash };
  assert.doesNotThrow(() => assertCTTool("query_conditional_returns", { query: query(), ...ok }, ct));
  assert.throws(() => assertCTTool("query_conditional_returns", { query: query(), ...ok, to: c.trainingToMs + MINUTE }, ct), /학습 구간/);
  assert.throws(() => assertCTTool("query_conditional_returns", { query: query(), ...ok, to: c.developmentToMs }, ct), /학습 구간/);
  assert.throws(() => assertCTTool("screen_rule", { spec: { ...spec(), symbols: ["BTCUSDT"], minutes: 1 }, ...ok, to: c.toMs }, ct), /학습 구간/);
  assert.throws(() => assertCTTool("cost_hurdle", { ...ok, to: c.trainingToMs + 1 }, ct), /학습 구간/);
  // read_bars: server-provided anchors only, and the window must end inside training.
  const read = (anchors, after = 10) => ({ request: { anchors, before: 10, after }, dataHash: ct.dataHash });
  assert.doesNotThrow(() => assertCTTool("read_bars", read([c.fromMs + 600 * MINUTE]), ct));
  assert.throws(() => assertCTTool("read_bars", read([c.fromMs + 601 * MINUTE]), ct), /서버가 제공한/);
  ct.anchors.push(c.trainingToMs - 5 * MINUTE);
  assert.throws(() => assertCTTool("read_bars", read([c.trainingToMs - 5 * MINUTE], 30), ct), /학습 구간/);
  // A training backtest is allowed while designing; development is not.
  const bt = { hash: "h", kind: "training", from: c.fromMs, to: c.trainingToMs, dataHash: ct.dataHash, options: {} };
  assert.doesNotThrow(() => assertCTTool("backtest", bt, ct));
  assert.throws(() => assertCTTool("backtest", { ...bt, kind: "development", from: c.trainingToMs, to: c.developmentToMs }, ct));
  ct.phase = "experiment";
  assert.throws(() => assertCTTool("query_conditional_returns", { query: query(), ...ok }, ct), /단계/);

  // Look-ahead: events whose horizon would cross the training end are dropped, and later bars cannot move results.
  const data = { BTCUSDT: minuteBars() };
  const before = ctQueryReturns(query({ horizons: [240] }), data, c);
  assert.ok(before.droppedAtBoundary > 0);
  const poisoned = { BTCUSDT: data.BTCUSDT.map((b) => (b.startMs >= c.trainingToMs ? { ...b, open: 1, high: 1e9, low: 1, close: 1e9 } : b)) };
  assert.deepEqual(ctQueryReturns(query({ horizons: [240] }), poisoned, c), before);
  assert.deepEqual(ctCostHurdle(poisoned, c), ctCostHurdle(data, c));
  assert.throws(() => ctReadBars({ anchors: [c.trainingToMs - 5 * MINUTE], before: 0, after: 30 }, data, c), /학습 구간/);
  const shown = ctReadBars({ anchors: [c.fromMs + 600 * MINUTE], before: 30, after: 29 }, data, c)[0];
  assert.equal(shown.bars, 60);
  assert.equal(shown.text.split("\n").length, 60);
  assert.match(shown.text.split("\n")[0], /^\d\d:\d\d,0,/, "first row: clock and bp from first open");
  assert.match(shown.text.split("\n")[30], /^\d\d:\d\d\*?,/, "clock every 30 rows");
  assert.equal(shown.text.split("\n")[1].split(",")[0], "");
  assert.ok(!shown.text.includes("20000"), "no raw prices");
  assert.deepEqual(ctReadBars({ anchors: [c.fromMs + 600 * MINUTE], before: 30, after: 29 }, data, c)[0], shown, "deterministic");
});

/* ---------------------------------------------------- 4 same detector */

test("query events are exactly the bars where detectCT signals the same conditions", () => {
  const c = minuteContract();
  const data = { BTCUSDT: minuteBars() };
  const q = query({
    stages: [
      { maxGapBars: 1, conditions: [{ feature: "contraction_ratio", lookback: 12, offset: 0, timeframe: 1, op: "lte", value: 1.3 }] },
      { maxGapBars: 6, conditions: [{ feature: "prior_high_distance_pct", lookback: 6, offset: 0, timeframe: 3, op: "gte", value: 0 }, { feature: "volume_ratio", lookback: 5, offset: 0, timeframe: 1, op: "gte", value: 0.8 }] },
    ],
    horizons: [10], grid: null, cooldownBars: 1,
  });
  const probe = ctQuerySpec(q, c);
  const rows = data.BTCUSDT;
  const expected = [];
  for (let i = 0; i < rows.length && rows[i].endMs <= c.trainingToMs; i++)
    if (detectCT(probe, "BTCUSDT", rows.slice(0, i + 1), rows[i].endMs)) expected.push(rows[i].endMs);
  const { events, truncated } = ctQueryEvents(q, data, c);
  assert.ok(expected.length > 20, `signals ${expected.length}`);
  assert.deepEqual([...events.map((e) => e.at)], expected.slice(0, expected.length - truncated));
});

/* ----------------------------------------------------- 5 same costs */

test("the cost hurdle's round trip is what replayCT actually charges", () => {
  const c = minuteContract();
  // Flat prices: any trade's loss is cost alone. 20000 × (1 ± impact) lands on the 0.01 USDT tick.
  const flat = minuteBars().map((b) => ({ ...b, open: 20000, close: 20000, high: 20000, low: 20000 }));
  const s = { ...spec(), symbols: ["BTCUSDT"], minutes: 1 };
  s.stages[0].conditions = [{ feature: "range_position", lookback: 3, offset: 0, timeframe: 1, op: "lte", value: 1 }];
  s.exit = { stopPct: 1, targetPct: 2, maxHoldBars: 5, invalidation: "stop" };
  const result = replayCT(s, { BTCUSDT: flat }, c, c.fromMs, c.trainingToMs, "h");
  assert.ok(result.trades.length > 10);
  for (const t of result.trades) {
    const paid = t.quantity * t.entry * (1 + c.costs.feePct / 100);
    assert.ok(Math.abs(-t.pnl / paid * 100 - ctRoundTripCostPct(c)) < 1e-9, `${-t.pnl / paid * 100}`);
  }
  const hurdle = ctCostHurdle({ BTCUSDT: flat }, c);
  assert.equal(hurdle.roundTripCostPct, Number(ctRoundTripCostPct(c).toFixed(4)));
  assert.ok(Math.abs(ctRoundTripCostPct(c) - 0.3095) < 0.001, "0.1% fee, 0.05% spread, 0.03% slippage ≈ 0.31%");
  assert.equal(hurdle.roundTripCost2xPct, Number(ctRoundTripCostPct(c, 2).toFixed(4)));
});

/* ------------------------------------------------------ 6 evidence */

test("evidence ids must exist in this run and measure the same feature and timeframe; old candidates still read", () => {
  const ct = ctState();
  const record = (over = {}) => ({ queryId: "q-this-run", session: 0, at: "", from: ct.contract.fromMs, to: ct.contract.trainingToMs, stages: [],
    features: [{ feature: "prior_high_distance_pct", timeframe: 1 }], horizons: [5], events: 40, uniqueDays: 10, summary: "", ...over });
  ct.queries = [record()];
  const v2 = (id) => {
    const c = draft((d) => { d.spec.sourceIds = [id]; d.mapping[0].sourceId = id; });
    c.evidenceVersion = 2;
    return c;
  };
  assert.doesNotThrow(() => validateCTCandidate(v2("q-this-run"), ct));
  assert.doesNotThrow(() => validateCTCandidate(v2("verified"), ct), "web source still valid");
  assert.throws(() => validateCTCandidate(v2("q-made-up"), ct), /확인되지 않은 근거/);
  assert.throws(() => validateCTCandidate(v2("q-other-run"), ct), /확인되지 않은 근거/);
  ct.queries = [record({ features: [{ feature: "prior_high_distance_pct", timeframe: 3 }] })];
  assert.throws(() => validateCTCandidate(v2("q-this-run"), ct), /측정하지 않음/);
  ct.queries = [record({ features: [{ feature: "volume_ratio", timeframe: 1 }] })];
  assert.throws(() => validateCTCandidate(v2("q-this-run"), ct), /측정하지 않음/);
  ct.queries = [record({ to: ct.contract.developmentToMs })];
  assert.throws(() => validateCTCandidate(v2("q-this-run"), ct), /학습 구간 밖/);
  // Version 1 (no evidenceVersion): web sources only, exactly as before.
  ct.queries = [record()];
  assert.doesNotThrow(() => validateCTCandidate(candidate(), ct));
  const old = candidate();
  old.spec.sourceIds = ["q-this-run"];
  old.mapping[0].sourceId = "q-this-run";
  assert.throws(() => validateCTCandidate(old, ct));
  // A new idea needs no parent even after earlier trials; a named parent must be real.
  ct.trials = [{ id: "parent" }];
  assert.doesNotThrow(() => validateCTCandidate(v2("verified"), ct));
  const child = v2("verified");
  child.parentId = "imaginary";
  assert.throws(() => validateCTCandidate(child, ct), /부모/);
});

/* ------------------------------------------------- 7 resume / cancel */

test("a runner killed after a paid turn resumes without paying again; a late answer after cancel changes nothing", async () => {
  const replies = [];
  let calls = 0;
  globalThis.__strategyTestHooks.turn = async () => {
    calls++;
    return replies.shift();
  };
  const q = (n) => query({ stages: [{ maxGapBars: 1, conditions: [{ feature: "return_pct", lookback: 3 + n, offset: 0, timeframe: 1, op: "gte", value: 0 }] }], horizons: [3], grid: null, cooldownBars: 3 });
  replies.push(
    reply(toolUse("t1", "query_conditional_returns", q(1))),
    reply(toolUse("t2", "query_conditional_returns", q(2))),
    reply(toolUse("t3", "query_conditional_returns", q(3))),
    reply(toolUse("t4", "query_conditional_returns", q(4))),
  );
  const created = await sessionJob();
  let job = await advance(created.id); // session opened
  for (let k = 0; k < 2; k++) {
    job = await advance(created.id); // turn
    job = await advance(created.id); // tools
  }
  assert.equal(calls, 2);
  failSessionInsert = 1;
  job = await advance(created.id); // turn 3 is paid, then the runner dies before storing it
  assert.equal(calls, 3);
  assert.equal(job.status, "paused", job.error);
  const paidBefore = job.calls.filter((c) => c.role === "ctDesigner" && c.status === "completed").length;
  const costBefore = job.costUsd;
  assert.equal(paidBefore, 3);
  await store.resumeGenerationFailure(job);
  job = await advance(created.id); // turn 3 reused from the ledger: no new call, no new cost
  assert.equal(calls, 3);
  assert.equal(job.costUsd, costBefore);
  assert.equal(job.calls.filter((c) => c.role === "ctDesigner").length, 3);
  assert.equal(job.ct.sessions[0].turns, 3);
  job = await advance(created.id); // tools of turn 3
  job = await advance(created.id); // turn 4 is new
  assert.equal(calls, 4);
  assert.equal(job.ct.sessions[0].turns, 4);
  const stored = sessionMessages(created.id).filter((m) => m.role === "assistant").map((m) => m.content[1].id);
  assert.deepEqual(stored, ["t1", "t2", "t3", "t4"]);

  // Cancel while turn 5 is in flight: its late answer is neither stored nor counted as progress.
  job = await advance(created.id); // tools of turn 4
  const messagesBefore = sessionMessages(created.id).length;
  globalThis.__strategyTestHooks.turn = async () => {
    calls++;
    await store.cancelGenerationJob(structuredClone(await store.getGenerationJob(created.id)));
    return reply(toolUse("late", "submit_candidates", { candidates: [], noEdgeReason: "late", rejectedHypotheses: [] }));
  };
  job = await advance(created.id);
  assert.equal(calls, 5);
  assert.equal(job.status, "cancelled");
  assert.equal(sessionMessages(created.id).length, messagesBefore);
  assert.equal(job.ct.sessions[0].turns, 4);
});

/* ----------------------------------- 7b multiple-testing ledger (ct-pattern-3) */

test("the designer sees how many distinct hypotheses the run has tested: threshold variants count once, another feature is a new test", async () => {
  const replies = [];
  globalThis.__strategyTestHooks.turn = async () => replies.shift();
  const q = (feature, lookback, value) => query({ stages: [{ maxGapBars: 1, conditions: [{ feature, lookback, offset: 0, timeframe: 1, op: "gte", value }] }], horizons: [3], grid: null, cooldownBars: 3 });
  replies.push(
    reply(toolUse("l1", "query_conditional_returns", q("return_pct", 4, 0))),
    reply(toolUse("l2", "query_conditional_returns", q("return_pct", 9, 0.1))),
    reply(toolUse("l3", "query_conditional_returns", q("volume_ratio", 4, 1))),
  );
  const created = await sessionJob();
  let job = await advance(created.id); // session opened
  for (let k = 0; k < 3; k++) {
    job = await advance(created.id); // turn
    job = await advance(created.id); // tools
  }
  const results = sessionMessages(created.id)
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    .map((b) => JSON.parse(b.content));
  assert.deepEqual(results.map((r) => r.multipleTesting.hypothesisTests), [1, 1, 2]);
  assert.deepEqual(results.map((r) => r.multipleTesting.toolCalls), [1, 2, 3]);
  assert.equal(Object.keys(job.ct.tests.signatures).length, 2);
  assert.equal(job.ct.queries.length, 3);
  assert.ok(job.ct.queries.every((r) => typeof r.signature === "string"));
  assert.equal(job.ct.queries[0].signature, job.ct.queries[1].signature);
  assert.notEqual(job.ct.queries[0].signature, job.ct.queries[2].signature);
});

/* -------------------------------------------- 8 multiple candidates */

test("submitted candidates are de-duplicated, training failures skip development, and submissions count against the limit", async () => {
  const c = { fromMs: Date.UTC(2025, 0, 1), trainingToMs: Date.UTC(2025, 3, 1), developmentToMs: Date.UTC(2025, 6, 1), toMs: Date.UTC(2025, 9, 1) };
  const data = Array.from({ length: 273 }, (_, day) =>
    bars(18, c.fromMs + day * 86400000).map((b, i) => ({
      ...b, open: 1000 + i * 6, close: 1004 + i * 6, high: 1005 + i * 6, low: 999 + i * 6,
      volume: i < 9 ? 100000 : 100000 / 10 ** (i - 8),
    })),
  ).flat();
  const passing = draft((d) => {
    d.spec.stages[0].conditions.push({ feature: "volume_ratio", lookback: 3, offset: 0, timeframe: 1, op: "gte", value: 0.5 });
    d.mapping.push({ stage: 0, condition: 1, feature: "volume_ratio", sourceId: "verified", implementationAssumption: "Fixture completion-volume condition." });
  });
  const renamed = structuredClone(passing);
  renamed.spec.name = "Same rule, new name";
  const never = draft((d) => { d.spec.stages[0].conditions[0].value = 50; });
  const tooMany = { candidates: [passing, never, renamed, passing], noEdgeReason: null, rejectedHypotheses: [] };
  const submission = { candidates: [passing, never, renamed], noEdgeReason: null, rejectedHypotheses: [] };
  const replies = [reply(toolUse("s1", "submit_candidates", tooMany)), reply(toolUse("s2", "submit_candidates", submission))];
  globalThis.__strategyTestHooks.turn = async () => replies.shift();
  const created = await sessionJob({ data, contract: c });
  let job = await advance(created.id); // open
  job = await advance(created.id); // turn: too many
  job = await advance(created.id); // is_error back to the designer
  const errorResult = sessionMessages(created.id).at(-1).content[0];
  assert.equal(errorResult.is_error, true);
  job = await advance(created.id); // turn: valid
  job = await advance(created.id); // accepted
  assert.equal(job.ct.phase, "experiment");
  assert.equal(job.ct.submitted, 2, "the renamed duplicate does not count");
  assert.equal(job.ct.sessions[0].submission.duplicates, 1);
  assert.equal(job.ct.duplicateCount, 1);
  assert.equal(job.ct.queue.length, 2);
  job = await advance(created.id); // candidate 1: training passes → full experiment
  job = await advance(created.id); // candidate 2: training fails → screened
  const hashOf = async (d) => ctHash(executableCT(d.spec));
  const kinds = (hash) => sqlite.prepare("SELECT input_payload FROM ct_tools WHERE run_id=? AND name='backtest'").all(created.id)
    .map((r) => JSON.parse(r.input_payload)).filter((i) => i.hash === hash).map((i) => i.kind).sort();
  assert.deepEqual(kinds(await hashOf(never)), ["training"], "no development replay for a training failure");
  // Sensitivity variants change the stop, so they replay under their own hashes.
  assert.deepEqual(kinds(await hashOf(passing)), ["development", "development_delay", "development_stress", "training"]);
  assert.equal(job.ct.backtests, 7);
  assert.equal(job.ct.trials.length, 1);
  assert.equal(job.ct.screened.length, 1);
  assert.equal(job.ct.trials[0].designedBy, "ctDesigner");
  assert.equal(job.ct.phase, "risk_review", "a candidate that passes development is frozen for review");
  assert.equal(job.ct.frozenHash, await hashOf(passing));
  // Reviews go to the other company (OpenAI) and registration accepts the new roles.
  sqlite.exec("DELETE FROM ct_exposure");
  const reviewed = [];
  globalThis.__strategyTestHooks.call = async (role, prompt) => {
    reviewed.push(role);
    assert.match(prompt, /data snooping|multiple testing/i);
    assert.match(prompt, /queriesRun/);
    return { approved: true, summary: "독립 검토 고정 응답입니다.", blockers: [], cautions: [] };
  };
  try {
    for (let k = 0; k < 3 && job.status === "running"; k++) job = await advance(created.id);
  } finally {
    globalThis.__strategyTestHooks.call = () => { throw new Error("unexpected structured call"); };
  }
  assert.deepEqual(reviewed, ["ctRiskReviewer", "ctEvidenceReviewer"], `${job.status} ${job.ct.phase} ${job.ct.endReason} ${job.error}`);
  assert.equal(job.ct.passed, true, job.ct.endReason);
  assert.ok(job.calls.some((c) => c.role === "ctRiskReviewer" && c.provider === "OpenAI"));
  assert.ok(job.calls.some((c) => c.role === "ctDesigner" && c.provider === "Anthropic"));
  await research.registerCT(job);
  assert.ok((await research.ctPackages("crypto")).some((p) => p.runId === created.id));
});

/* ---------------------------------------------- 10 progress screen */

test("the progress screen shows new and legacy role names as the same CT agents", () => {
  for (const [legacy, current] of [["orchestrator", "ctOrchestrator"], ["dataAnalyst", "ctAnalyst"], ["designer", "ctDesigner"], ["riskReviewer", "ctRiskReviewer"], ["evidenceReviewer", "ctEvidenceReviewer"]]) {
    assert.equal(agentIdOf(legacy), current);
    assert.equal(agentIdOf(current), current);
  }
  const ct = { ...ctState(), phase: "design", sessions: [{ index: 0, kind: "design", status: "open", turns: 2, toolCalls: 3, screens: 0, messages: 5 }], queries: [] };
  const call = (over) => ({ id: over.id, key: "k", status: "completed", startedAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:01:00Z", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, estimated: false, costUsd: 0.1, reserveUsd: 1, ...over });
  const calls = mergeCalls([
    call({ id: "old", role: "designer", model: "gpt-6.1-sol", provider: "OpenAI" }),
    call({ id: "new", role: "ctDesigner", model: "claude-opus-5-5", provider: "Anthropic", status: "started", label: "설계 세션 1 · 턴 3/12" }),
  ], null);
  const job = { id: "j", status: "running", createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:01:00Z", costUsd: 0.2, budgetUsd: 8, error: null, calls, ct };
  const now = ctNow(job, calls);
  assert.equal(now.agent, "ctDesigner");
  const designer = ctAgents(job, calls, now).find((a) => a.id === "ctDesigner");
  assert.equal(designer.calls, 2);
  assert.equal(designer.model, "claude-opus-5-5");
  assert.equal(designer.cacheReadTokens, 200);
  assert.equal(agentModel("ctDesigner", calls[0]).model, "gpt-6.1-sol", "legacy calls keep their real model");
  assert.match(callDoing("ctDesigner", ct, calls[1]), /설계 세션 1 · 턴 3\/12/);
  assert.match(callDoing("designer", ct), /설계/);
  assert.match(callDoing("riskReviewer", ct), /독립 검토/);
  assert.match(callDoing("ctRiskReviewer", ct), /데이터 스누핑/);
});

test("the session context is stable first, appends history, and carries no source text or price CSV", () => {
  const ct = ctState();
  ct.approaches = [{ sourceId: "verified", trader: "x", principle: "breakouts after contraction", quote: "q".repeat(25), structure: "", regime: "", approximation: "", discretionary: "", publishedAt: null }];
  ct.sessions = [{ index: 0, kind: "design", status: "submitted", turns: 3, toolCalls: 4, screens: 1, messages: 7, submission: { candidates: 0, accepted: 0, duplicates: 0, noEdgeReason: "none", rejectedHypotheses: [] } }];
  ct.queries = [{ queryId: "q1", session: 0, at: "", from: 0, to: 1, stages: [], features: [], horizons: [5], events: 9, uniqueDays: 3, summary: "s" }];
  const one = ctSessionContext(ct, "brief", { conclusion: "hurdle" }, { index: 1, kind: "reflect" });
  const two = ctSessionContext(ct, "other brief", { conclusion: "hurdle" }, { index: 1, kind: "reflect" });
  assert.equal(one.stable, two.stable, "brief and session state live outside the cached block");
  assert.match(one.history, /q1/);
  assert.ok(!one.stable.includes(ct.sources[0].text));
  assert.match(one.stable, /breakouts after contraction/);
  ct.sessions.push({ index: 1, kind: "reflect", status: "submitted", turns: 1, toolCalls: 1, screens: 0, messages: 3 });
  const three = ctSessionContext(ct, "brief", { conclusion: "hurdle" }, { index: 2, kind: "reflect" });
  assert.ok(three.history.startsWith(one.history), "history only grows at the end");
});

test("web research is optional: unverifiable quotes are dropped and design proceeds without sources", async () => {
  const created = await sessionJob();
  const j = structuredClone(created);
  j.ct.phase = "approaches";
  const approach = (quote) => ({ sourceId: "verified", trader: "x", principle: "p", quote, structure: "", regime: "", approximation: "", discretionary: "", publishedAt: "2020-01-01" });
  await research.advanceCTResearch(j, "fixture", async () => ({
    approaches: [approach("Actual verified source text, this is"), approach("A quote the source never contained at all")],
  }));
  assert.equal(j.ct.phase, "design");
  assert.equal(j.ct.approaches.length, 1);
  assert.equal(j.ct.approaches[0].publishedAt, null);
  assert.ok(j.ct.tools.some((t) => t.name === "approach_quote_rejected"));
  const none = structuredClone(j);
  none.ct.phase = "approaches";
  await research.advanceCTResearch(none, "fixture", async () => ({ approaches: [approach("A quote the source never contained at all")] }));
  assert.equal(none.ct.phase, "design");
  assert.equal(none.ct.approaches.length, 0);
  assert.match(none.ct.sourceNote, /출처 없이/);
  // No readable sources at all: straight to design with the note.
  const unread = structuredClone(j);
  unread.ct.phase = "read";
  unread.ct.sources = [];
  unread.ct.search = { queries: ["q"], urls: [], rationale: "" };
  await research.advanceCTResearch(unread, "fixture", async () => { throw new Error("no model"); });
  assert.equal(unread.ct.phase, "design");
  assert.match(unread.ct.sourceNote, /출처 없이/);
  await store.cancelGenerationJob(j);
});
