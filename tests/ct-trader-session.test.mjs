// Stage 3 in a real session: the trader tools through the designer loop with the real request layer
// (fake fetch), chart images in tool_results, blind grading, playbook recording and the leak rule.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { ctState } from "./helpers/ct-fixture.mjs";
import { plantedMarket, plantedContract, MINUTE } from "./helpers/ct-trader-fixture.mjs";
import { ctHash, executableCT, CT_ENGINE, CT_POLICY_V6 as CT_POLICY, ctSessionPolicy } from "../lib/ct-spec.ts";
import { STAGE3_POLICY, STAGE4_POLICY } from "./helpers/ct-policies.mjs";
import { ctRunLabels, ctLabelMovesReport, ctLabelMovesSchema, ctLabelMovesSchemaBars } from "../lib/ct-trader-tools.ts";
import { CT_DESIGNER_SYSTEM, CT_DESIGNER_SYSTEM_STAGE2, CT_DESIGNER_SYSTEM_STAGE3, CT_DESIGNER_SYSTEM_STAGE4, ctDesignerSystem } from "../lib/ct-research.ts";
import { assertCTTool } from "../lib/ct-tools.ts";
import { designerRequestChars } from "../lib/designer-request-size.ts";
register("./helpers/slot-test-loader.mjs", import.meta.url);

/** The policy of a contract frozen at stage 3 (before the 2026-10-14 stage-4 policy). */
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
const playbook = await import("../lib/ct-playbook.ts");
await research.ensureCTSchema();

const { bars } = plantedMarket();
const contract = plantedContract();
const params = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30 });
let sequence = 0;
async function job(over = {}) {
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled' WHERE status='running'");
  const ct = ctState();
  ct.phase = "design";
  ct.contract = { ...contract, ...(over.contract ?? {}) };
  ct.dataHash = await ctHash({ BTCUSDT: bars });
  ct.playbook = await playbook.ctPlaybookSnapshot("owner", ct.contract, `trader-${sequence + 1}`);
  const now = new Date().toISOString();
  const j = { id: `trader-${++sequence}`, ownerId: "owner", slot: "open", status: "running", stageIndex: 0, createdAt: now, updatedAt: now, from: "2025-01-01", to: "2025-01-12", capitalUsd: 1e6, budgetUsd: 8, costUsd: 0, brief: "", events: [], calls: [], universe: ["BTCUSDT"], ct };
  await store.createGenerationJob(j);
  sqlite.prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)").run(j.id, "BTCUSDT", ct.contract.toMs, JSON.stringify(bars));
  return j;
}
const advance = (id) => flow.advanceGeneration(id);
function sse(events) {
  return new Response(new ReadableStream({ start(c) {
    for (const e of events) c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    c.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
function claudeTurn(id, tools, usage = { input: 40, write: 0, read: 0, output: 500 }) {
  const events = [
    { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1, cache_creation_input_tokens: usage.write, cache_read_input_tokens: usage.read } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${id}` } },
    { type: "content_block_stop", index: 0 },
  ];
  tools.forEach((t, k) => events.push(
    { type: "content_block_start", index: k + 1, content_block: { type: "tool_use", id: t.id, name: t.name, input: {} } },
    { type: "content_block_delta", index: k + 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } },
    { type: "content_block_stop", index: k + 1 },
  ));
  events.push({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: usage.output } }, { type: "message_stop" });
  return events;
}
const messages = (id) => sqlite.prepare("SELECT payload FROM ct_session_messages WHERE run_id=? AND session=0 ORDER BY seq").all(id).map((r) => JSON.parse(r.payload));

test("the stage-2 brief is byte-identical, contracts decide which brief and tools run", () => {
  assert.equal(createHash("sha256").update(CT_DESIGNER_SYSTEM_STAGE2).digest("hex"), "12fa22726e2b1f10700de1f6d9a3bc5b50b0ba2df22024c3e9b566695dbeeffd");
  assert.equal(createHash("sha256").update(CT_DESIGNER_SYSTEM_STAGE3).digest("hex"), "08e7ef36f0ec5d9a8a4731aa37ae6d47216ae3be4e4e7520217b4058e32cacba");
  assert.equal(ctDesignerSystem({ policy: STAGE3_POLICY }), CT_DESIGNER_SYSTEM_STAGE3);
  assert.equal(ctDesignerSystem({ policy: STAGE4_POLICY }), CT_DESIGNER_SYSTEM_STAGE4);
  assert.equal(ctDesignerSystem({ policy: CT_POLICY }), CT_DESIGNER_SYSTEM);
  assert.notEqual(CT_DESIGNER_SYSTEM, CT_DESIGNER_SYSTEM_STAGE3);
  const old = { policy: { ...CT_POLICY, traderTools: undefined, sessionMaxTurns: undefined, sessionMaxToolCalls: undefined, sessionMaxCharts: undefined, sessionMaxBlindSets: undefined } };
  assert.equal(ctDesignerSystem(old), CT_DESIGNER_SYSTEM_STAGE2);
  assert.deepEqual(ctSessionPolicy(old), { maxTurns: 12, maxToolCalls: 24, maxScreens: 6, maxSessions: 3, maxCharts: 0, maxBlindSets: 0, traderTools: false, toolsVersion: 0, freeBars: false, barOverview: false, timeFreeBlind: false, book:false, lessons: false, lessonReserveUsd: 0, lessonMaxInputChars: 60000, lessonMaxOutputTokens: 8000, blindSize: null });
  // Stage 3 contracts (traderTools = 1) keep 32 images and their own brief; stage 4 (= 2) has 48 images and 16–32-chart blind sets.
  assert.deepEqual(ctSessionPolicy({ policy: STAGE3_POLICY }), { maxTurns: 16, maxToolCalls: 40, maxScreens: 6, maxSessions: 3, maxCharts: 32, maxBlindSets: 2, traderTools: true, toolsVersion: 1, freeBars: false, barOverview: false, timeFreeBlind: false, book:false, lessons: false, lessonReserveUsd: 0, lessonMaxInputChars: 60000, lessonMaxOutputTokens: 8000, blindSize: null });
  assert.deepEqual(ctSessionPolicy({ policy: STAGE4_POLICY }), { maxTurns: 16, maxToolCalls: 40, maxScreens: 6, maxSessions: 3, maxCharts: 48, maxBlindSets: 2, traderTools: true, toolsVersion: 2, freeBars: false, barOverview: false, timeFreeBlind: false, book:false, lessons: false, lessonReserveUsd: 0, lessonMaxInputChars: 60000, lessonMaxOutputTokens: 8000, blindSize: { min: 16, default: 24, max: 32 } });
  // Stage 5 adds the lessons and withholds their reserve; the session limits are the stage-4 ones. Free bars (4) change only the bar choice; the bar overview (5) only the stable block and brief; time-free blind sets (6) only the blind charts and their controls.
  assert.deepEqual(ctSessionPolicy({ policy: CT_POLICY }), { maxTurns: 16, maxToolCalls: 40, maxScreens: 6, maxSessions: 3, maxCharts: 48, maxBlindSets: 2, traderTools: true, toolsVersion: 6, freeBars: true, barOverview: true, timeFreeBlind: true, book:false, lessons: true, lessonReserveUsd: 0.05, lessonMaxInputChars: 60000, lessonMaxOutputTokens: 8000, blindSize: { min: 16, default: 24, max: 32 } });
  assert.match(CT_DESIGNER_SYSTEM, /selfRebuttal/);
  assert.match(CT_DESIGNER_SYSTEM, /label_moves[\s\S]*contrast_moves[\s\S]*grade_blind[\s\S]*diagnose_trades/);
});

test("trader tools are refused outside the training split, for unknown ids and for contracts without them", () => {
  const ct = { ...ctState(), contract: { ...contract }, anchors: [], chartAnchors: {}, labels: {}, blinds: {}, screens: {} };
  const ok = { from: contract.fromMs, to: contract.trainingToMs, dataHash: ct.dataHash };
  assert.doesNotThrow(() => assertCTTool("label_moves", { params: params, ...ok }, ct));
  assert.throws(() => assertCTTool("label_moves", { params, ...ok, to: contract.developmentToMs }, ct), /학습 구간/);
  assert.throws(() => assertCTTool("contrast_moves", { request: { labelId: "nonexistent-id", features: [{ feature: "range_pct", lookback: 10, timeframe: 1 }] }, params, ...ok }, ct), /labelId/);
  assert.throws(() => assertCTTool("view_charts", { request: { anchors: [contract.fromMs + 5 * MINUTE] }, ...ok }, ct), /서버가 제공한/);
  ct.chartAnchors = { [`BTCUSDT:${contract.trainingToMs + MINUTE}`]: { symbol: "BTCUSDT", at: contract.trainingToMs + MINUTE, group: "positive", ref: "l" } };
  assert.throws(() => assertCTTool("view_charts", { request: { anchors: [contract.trainingToMs + MINUTE] }, ...ok }, ct), /학습 구간/);
  assert.throws(() => assertCTTool("grade_blind", { request: { blindId: "nope1234", predictions: [1, 2, 3, 4].map((chart) => ({ chart, call: "control" })) }, ...ok }, ct), /blindId/);
  assert.throws(() => assertCTTool("diagnose_trades", { request: { screenId: "nopenope1" }, ...ok }, ct), /screenId/);
  ct.phase = "experiment";
  assert.throws(() => assertCTTool("label_moves", { params, ...ok }, ct), /단계/);
});

test("a full STAGE-3 trader session (traderTools = 1 contract): labels → contrast → charts (images in tool_result) → blind grade → screen → diagnose → submit; playbook written", async () => {
  const original = globalThis.fetch;
  globalThis.__strategyTestHooks.realLlm = true;
  const requests = [];
  const created = await job({ contract: { policy: STAGE3_POLICY } });
  const label = (await ctHash({ run: created.id, params })).slice(0, 16);
  // Event and control times are what label_moves will issue for this run's labelId (the seed derives from it).
  const issued = ctLabelMovesReport(params, ctRunLabels(params, { BTCUSDT: bars }, contract), contract, label);
  const positives = issued.anchors.slice(0, 2).map((a) => a.at),
    controls = issued.controlAnchors.slice(0, 2).map((a) => a.at);
  const blindAnchors = [...positives, ...controls];
  const blindId = (await ctHash({ run: created.id, blind: [...blindAnchors].sort((a, b) => a - b) })).slice(0, 12);
  const rule = {
    version: 1, engine: CT_ENGINE, name: "planted contraction", market: "crypto", symbols: ["BTCUSDT"], minutes: 1,
    stages: [{ label: "contraction", maxGapBars: 1, conditions: [{ feature: "range_pct", lookback: 10, offset: 0, timeframe: 1, op: "lte", value: 0.05 }] }],
    entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
    exit: { stopPct: 0.5, targetPct: 1.5, maxHoldBars: 40, invalidation: "stop" },
    sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 30, participationPct: 1 },
    sourceIds: ["verified"], assumptions: ["planted fixture rule"],
  };
  const screenId = (await ctHash({ run: created.id, hash: await ctHash(executableCT(rule)) })).slice(0, 16);
  const script = [
    [{ id: "t1", name: "label_moves", input: params }],
    [{ id: "t2", name: "contrast_moves", input: { labelId: label, features: [{ feature: "range_pct", lookback: 10, timeframe: 1 }, { feature: "return_pct", lookback: 10, timeframe: 1 }] } }],
    [{ id: "t3", name: "view_charts", input: { anchors: positives.slice(0, 1) } }],
    [{ id: "t4", name: "view_charts", input: { anchors: blindAnchors, blind: true } }],
    [{ id: "t5", name: "grade_blind", input: { blindId, predictions: [1, 2, 3, 4].map((chart) => ({ chart, call: chart % 2 ? "positive" : "control" })) } }],
    [{ id: "t6", name: "screen_rule", input: { spec: rule } }],
    [{ id: "t7", name: "diagnose_trades", input: { screenId } }],
    [{ id: "t8", name: "submit_candidates", input: { candidates: [], noEdgeReason: "비용 후 우위를 찾지 못함", rejectedHypotheses: [{ hypothesis: "수축 뒤 돌파", mechanism: "변동성 수축 뒤 방향성 확장", evidence: [label], result: "이벤트는 있으나 비용 후 일평균이 음수" }] } }],
  ];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ body, raw: options.body });
    return sse(claudeTurn(`msg_${requests.length}`, script[requests.length - 1], { input: 40, write: requests.length === 1 ? 9000 : 300, read: requests.length === 1 ? 0 : 9000, output: 500 }));
  };
  try {
    let j = await advance(created.id); // open session
    for (let i = 0; i < 60 && j.status === "running" && j.ct.phase !== "done"; i++) j = await advance(created.id);
    assert.equal(j.ct.phase, "done", j.error ?? j.ct.endReason);
    assert.equal(requests.length, 8);
    // Tool set, brief, cache points.
    for (const { body } of requests) {
      assert.deepEqual(body.tools.map((t) => t.name), ["label_moves", "contrast_moves", "view_charts", "grade_blind", "query_conditional_returns", "read_bars", "screen_rule", "diagnose_trades", "submit_candidates"]);
      assert.equal(body.system[0].text, CT_DESIGNER_SYSTEM_STAGE3);
      assert.deepEqual(body.cache_control, { type: "ephemeral" });
      assert.deepEqual(body.messages[0].content[0].cache_control, { type: "ephemeral" });
      assert.deepEqual(body.thinking, { type: "adaptive" });
    }
    // The playbook reached the cached stable block (same market, no earlier runs of this market → empty or seeds only).
    assert.match(requests[0].body.messages[0].content[0].text, /"playbook"/);
    // Images: the first view_charts result carries a real PNG, and every later request carries the SAME bytes.
    const resultOf = (req, id) => req.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_result" && b.tool_use_id === id);
    const first = resultOf(requests[3], "t3");
    const image = first.content.find((b) => b.type === "image");
    assert.equal(image.source.media_type, "image/png");
    assert.equal(Buffer.from(image.source.data, "base64")[0], 0x89);
    for (const k of [4, 5, 6, 7]) assert.equal(JSON.stringify(resultOf(requests[k], "t3")), JSON.stringify(first), `request ${k + 1} resends the identical image result`);
    // The blind result shows no group; the graded result reveals it.
    const blind = resultOf(requests[4], "t4");
    const blindText = blind.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    assert.ok(!/이벤트\(양성\) 시점|대조군 시점/.test(blindText.replace(/이벤트와 대조군이 절반씩/, "")), blindText);
    assert.equal(blind.content.filter((b) => b.type === "image").length, 4);
    // Ledger, evidence records, session counters.
    const ct = j.ct;
    assert.ok(ct.labels[label] && ct.contrasts.length === 1 && ct.diagnoses.length === 1);
    assert.equal(ct.sessions[0].charts, 5);
    assert.equal(ct.sessions[0].blinds, 1);
    assert.ok(ct.blinds[blindId].graded.total === 4);
    const ledger = Object.keys(ct.tests.signatures);
    assert.ok(ledger.some((k) => k.startsWith("label|")) && ledger.some((k) => k.startsWith("contrast|")) && ledger.some((k) => k.startsWith("diagnose|")) && ledger.some((k) => k.startsWith("blind|")));
    assert.equal(ledger.filter((k) => k.startsWith("contrast|")).length, 10, "2 features × 5 control quintiles");
    assert.ok(ct.tests.treeSplits >= 0);
    // Image rows for the owner's view; reserve per turn stays small (images are tokens, not base64 characters).
    assert.equal(sqlite.prepare("SELECT count(*) n FROM ct_chart_images WHERE run_id=?").get(created.id).n, 5);
    const paid = j.calls.filter((c) => c.role === "ctDesigner");
    assert.ok(paid.every((c) => c.reserveUsd < 3), paid.map((c) => c.reserveUsd).join());
    const big = JSON.stringify(requests[7].body.messages).length;
    assert.ok(designerRequestChars(requests[7].body.messages) < big / 3, "base64 is not counted as text");
    // Playbook: the finished run and its rejected hypothesis were recorded, with the ledger.
    assert.ok(ct.playbookRecorded.entries >= 1);
    const row = sqlite.prepare("SELECT * FROM ct_playbook WHERE run_id=?").get(created.id);
    assert.equal(row.grade, "rejected_in_training");
    const run = sqlite.prepare("SELECT * FROM ct_playbook_runs WHERE run_id=?").get(created.id);
    assert.equal(run.hypothesis_tests, ledger.length);
    assert.equal(messages(created.id).length > 10, true);
  } finally {
    globalThis.fetch = original;
    globalThis.__strategyTestHooks.realLlm = false;
  }
});

test("free bars in a real session: label, contrast, query and read_bars on 5-minute bars; a 5-minute rule is screened and diagnosed; the ledger counts the bar", async () => {
  const original = globalThis.fetch,
    key = globalThis.__strategyTestEnv.ANTHROPIC_API_KEY;
  // The SDK client is cached per key and keeps the fetch it was built with: a key of its own gives this test a client on its fetch.
  globalThis.__strategyTestEnv.ANTHROPIC_API_KEY = "test-anthropic-free-bars";
  globalThis.__strategyTestHooks.realLlm = true;
  const requests = [];
  const created = await job();
  assert.equal(ctSessionPolicy(created.ct.contract).freeBars, true);
  const p5 = ctLabelMovesSchemaBars.parse({ k: 3, m: 1, horizon: 8, barMinutes: 5 });
  const label = (await ctHash({ run: created.id, params: p5 })).slice(0, 16);
  // The default policy has time-free blind sets (traderTools 5): the server issues anchors with bar-slot controls and full chart history.
  const issued = ctLabelMovesReport(p5, ctRunLabels(p5, { BTCUSDT: bars }, contract), contract, label, { controlSlot: "bar" });
  assert.ok(issued.anchors.length > 0);
  const at = issued.anchors[0].at;
  assert.equal(at % (5 * MINUTE), 0, "issued on the 5-minute grid");
  const rule = {
    version: 1, engine: CT_ENGINE, name: "five-minute contraction", market: "crypto", symbols: ["BTCUSDT"], minutes: 5,
    stages: [{ label: "contraction", maxGapBars: 1, conditions: [{ feature: "range_pct", lookback: 6, offset: 0, timeframe: 1, op: "lte", value: 0.2 }] }],
    entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
    exit: { stopPct: 0.5, targetPct: 1.5, maxHoldBars: 24, invalidation: "stop" },
    sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 6, participationPct: 1 },
    sourceIds: ["verified"], assumptions: ["planted fixture rule on 5-minute bars"],
  };
  const screenId = (await ctHash({ run: created.id, hash: await ctHash(executableCT(rule)) })).slice(0, 16);
  const query = { stages: [{ maxGapBars: 1, conditions: [{ feature: "range_pct", lookback: 6, offset: 0, timeframe: 1, op: "lte", value: 0.2 }] }], horizons: [6, 12], grid: null, cooldownBars: 6, barMinutes: 5 };
  const script = [
    [{ id: "b1", name: "label_moves", input: { k: 3, m: 1, horizon: 8, barMinutes: 5 } }],
    [{ id: "b2", name: "contrast_moves", input: { labelId: label, features: [{ feature: "range_pct", lookback: 6, timeframe: 1 }] } }],
    [{ id: "b3", name: "query_conditional_returns", input: query }],
    [{ id: "b4", name: "read_bars", input: { anchors: [at], before: 12, after: 0, barMinutes: 5 } }],
    [{ id: "b5", name: "screen_rule", input: { spec: rule } }],
    [{ id: "b6", name: "diagnose_trades", input: { screenId } }],
    [{ id: "b7", name: "label_moves", input: { k: 3, m: 1, horizon: 8, barMinutes: 3 } }],
    [{ id: "b8", name: "submit_candidates", input: { candidates: [], noEdgeReason: "5분봉에서도 비용 후 우위 없음", rejectedHypotheses: [{ hypothesis: "5분 수축 뒤 돌파", mechanism: "변동성 수축 뒤 확장", evidence: [label], result: "비용 후 일평균 음수" }] } }],
  ];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    // Designer turns only (a stage-5 contract also distils its lessons at the end with its own call).
    if (!body.tools?.some((t) => t.name === "submit_candidates")) return sse(claudeTurn(`other_${requests.length}`, []));
    requests.push({ body });
    return sse(claudeTurn(`msg_${requests.length}`, script[requests.length - 1], { input: 40, write: requests.length === 1 ? 9000 : 300, read: requests.length === 1 ? 0 : 9000, output: 500 }));
  };
  try {
    let j = await advance(created.id);
    for (let i = 0; i < 60 && j.status === "running" && j.ct.phase !== "done"; i++) j = await advance(created.id);
    assert.equal(j.ct.phase, "done", j.error ?? j.ct.endReason);
    assert.equal(requests.length, 8);
    assert.equal(requests[0].body.system[0].text, CT_DESIGNER_SYSTEM);
    assert.ok(requests[0].body.tools.find((t) => t.name === "label_moves").input_schema.properties.barMinutes);
    const resultOf = (id) => requests.at(-1).body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_result" && b.tool_use_id === id);
    for (const id of ["b1", "b2", "b3", "b4", "b5", "b6"]) assert.equal(resultOf(id).is_error, undefined, `${id}: ${JSON.stringify(resultOf(id).content).slice(0, 300)}`);
    assert.equal(resultOf("b7").is_error, true, "a 3-minute bar is not a choice");
    const ct = j.ct;
    assert.equal(ct.labels[label].params.barMinutes, 5);
    assert.equal(ct.queries[0].barMinutes, 5);
    assert.match(ct.queries[0].summary, /^\[5분봉\]/);
    const screened = ct.screens[screenId];
    assert.ok(screened.trades > 0, "the 5-minute rule trades on the planted market");
    assert.ok(ct.diagnoses.length === 1);
    const ledger = Object.keys(ct.tests.signatures);
    assert.ok(ledger.includes("label|k3|m1|h8|c1|b5"), ledger.join(" "));
    assert.ok(ledger.some((k) => k.startsWith("b5:range_pct|1|lte|pct")), "query and screen count the 5-minute structure");
    assert.ok(ledger.some((k) => k.startsWith("contrast|range_pct|1|pct|q0|k3m1h8c1b5")));
    assert.ok(ledger.some((k) => k.startsWith("diagnose|b5:")));
    assert.ok(!ledger.some((k) => k === "range_pct|1|lte|pct"), "nothing was tested on one-minute bars");
    const bars5 = JSON.stringify(resultOf("b4").content);
    assert.match(bars5, /13봉/);
  } finally {
    globalThis.fetch = original;
    globalThis.__strategyTestEnv.ANTHROPIC_API_KEY = key;
    globalThis.__strategyTestHooks.realLlm = false;
  }
});

test("selfRebuttal is required on a new contract's submission and every diagnosis filter must be recorded as a change", async () => {
  const created = await job();
  const ct = created.ct;
  const { validateCTCandidate } = await import("../lib/ct-research.ts");
  const { candidate } = await import("./helpers/ct-fixture.mjs");
  const draft = (extra = {}) => ({ ...structuredClone(candidate()), evidenceVersion: 2, ...extra });
  ct.contract.symbols = ["KRW-BTC"];
  assert.throws(() => validateCTCandidate(draft(), ct), /selfRebuttal/);
  const three = [1, 2, 3].map((n) => ({ chance: `우연 이유 ${n}번: 표본이 적음`, check: `월별 분포를 확인했다 ${n}`, excluded: "partly" }));
  assert.doesNotThrow(() => validateCTCandidate(draft({ selfRebuttal: three }), ct));
  assert.throws(() => validateCTCandidate(draft({ selfRebuttal: three.slice(0, 2) }), ct), /selfRebuttal/);
  // A contrastId is evidence only for the features it measured; a diagnosisId needs the change recorded.
  ct.contrasts = [{ contrastId: "c-1", labelId: "l", session: 0, at: "", from: ct.contract.fromMs, to: ct.contract.trainingToMs, features: [{ feature: "prior_high_distance_pct", timeframe: 1 }], topLift: null, treeLeaves: 0, summary: "" }];
  const cite = (id, extra = {}) => { const c = draft({ selfRebuttal: three, ...extra }); c.spec.sourceIds = [id]; c.mapping[0].sourceId = id; return c; };
  assert.doesNotThrow(() => validateCTCandidate(cite("c-1"), ct));
  ct.contrasts[0].features = [{ feature: "volume_ratio", timeframe: 1 }];
  assert.throws(() => validateCTCandidate(cite("c-1"), ct), /측정하지 않음/);
  ct.diagnoses = [{ diagnosisId: "d-1", source: "s", session: 0, at: "", features: [{ feature: "prior_high_distance_pct", timeframe: 1 }], verdict: "", losersTouched1RPct: 0, losersNeverProfitablePct: 0 }];
  assert.throws(() => validateCTCandidate(cite("d-1"), ct), /진단/);
  assert.doesNotThrow(() => validateCTCandidate(cite("d-1", { parentId: null, observedProblem: "저변동 시간대 손실 집중", changes: ["진단 필터 추가"] }), ct));
});

test("playbook: recorded once, final numbers never stored, overlapping windows show grade without numbers, seeds and backfill load", async () => {
  sqlite.exec("DELETE FROM ct_playbook; DELETE FROM ct_playbook_runs; DELETE FROM strategy_generation_runs;");
  playbook.resetPlaybookBackfill();
  const day = 86_400_000;
  const old = {
    id: "old-run-1", ownerId: "owner",
    ct: {
      ...ctState(), phase: "done", endReason: "설계자 판단", finalConsumed: true, passed: false, selectedId: "old-run-1:0",
      contract: { ...contract },
      sessions: [{ index: 0, kind: "design", status: "submitted", startedAt: "", turns: 3, toolCalls: 4, screens: 1, messages: 5, submission: { candidates: 1, accepted: 1, duplicates: 0, noEdgeReason: null, rejectedHypotheses: [{ hypothesis: "급락 반등", mechanism: "강제 청산 뒤 반등", evidence: ["q1"], result: "이벤트 23건에서 +0.4%p였지만 월 집중" }] } }],
      queries: [{ queryId: "q1", session: 0, at: "", from: contract.fromMs, to: contract.trainingToMs, stages: [], features: [{ feature: "return_pct", timeframe: 3 }], horizons: [5], events: 23, uniqueDays: 9, summary: "" }],
      tests: { signatures: { a: 2, b: 1, c: 1 } },
      screened: [],
      trials: [{ id: "old-run-1:0", spec: { ...(await import("./helpers/ct-fixture.mjs")).spec(), name: "old rule" }, hypothesis: { phenomenon: "p".repeat(12), mechanism: "수축 뒤 확장", falsification: "f".repeat(12), failureRegimes: ["x"] }, training: { netReturnPct: 1.2, trades: [], tradeCount: 30 }, development: { netReturnPct: 0.3, trades: [], tradeCount: 21 }, reasons: [] }],
      final: { netReturnPct: 99.9 },
    },
  };
  old.ct.contrasts = [{ contrastId: "c9", features: [{ feature: "range_pct", timeframe: 1 }] }];
  old.ct.sessions[0].submission.rejectedHypotheses.push({ hypothesis: "대칭 lift", mechanism: "변동성 효과", evidence: ["c9"], result: "방향 효과 없음" });
  assert.equal(await playbook.recordCTPlaybook(old), 3);
  assert.equal(await playbook.recordCTPlaybook(old), 3, "idempotent");
  assert.equal(sqlite.prepare("SELECT count(*) n FROM ct_playbook").get().n, 3);
  assert.match(sqlite.prepare("SELECT structure FROM ct_playbook WHERE evidence_ref='c9'").get().structure, /range_pct\(1m\)/, "a contrastId's features name the structure");
  const stored = sqlite.prepare("SELECT * FROM ct_playbook ORDER BY id").all();
  assert.ok(stored.every((r) => !r.detail.includes("99.9")), "the final split's numbers are never stored");
  assert.equal(stored.find((r) => r.grade === "failed_final").measured_to, contract.toMs);
  assert.equal(sqlite.prepare("SELECT hypothesis_tests n FROM ct_playbook_runs WHERE run_id='old-run-1'").get().n, 3);
  // A new run on the same dates: its development/final windows overlap → grade and mechanism, no numbers.
  // Same training window: the old rejected idea measured only training, so its (training) numbers may be shown.
  const sameTraining = await playbook.ctPlaybookSnapshot("owner", { ...contract }, "new-run");
  assert.match(sameTraining.entries.find((e) => e.grade === "rejected_in_training").reason, /23건/);
  const same = await playbook.ctPlaybookSnapshot("owner", { ...contract, trainingToMs: contract.trainingToMs - 3 * day }, "new-run");
  assert.equal(same.priorRuns, 1);
  assert.equal(same.cumulativeTests, 3);
  const rejected = same.entries.find((e) => e.grade === "rejected_in_training");
  assert.ok(rejected, JSON.stringify(same.entries.map((e) => e.grade)));
  assert.ok(!/\d/.test(rejected.reason), `numbers stripped: ${rejected.reason}`);
  const failedFinal = same.entries.find((e) => e.grade === "failed_final");
  assert.equal(failedFinal.detail, undefined);
  assert.match(failedFinal.measured, /수치 비공개/);
  // A later run whose development starts after the old run's whole window may see the old numbers (no final ones).
  const later = { ...contract, fromMs: contract.fromMs + 400 * day, trainingToMs: contract.toMs + 100 * day, developmentToMs: contract.toMs + 150 * day, toMs: contract.toMs + 200 * day };
  const after = await playbook.ctPlaybookSnapshot("owner", later, "new-run");
  const trial = after.entries.find((e) => e.id.includes(":trial:"));
  assert.equal(trial.detail.developmentNetReturnPct, 0.3);
  assert.ok(!JSON.stringify(after).includes("99.9"));
  // Seeds: the ten daily results, never mixed into the 1-minute test count; stock only.
  const stock = await playbook.ctPlaybookSnapshot("owner", { ...contract, market: "stock" }, "new-run");
  assert.equal(stock.entries.filter((e) => e.timeframe === "daily").length, 10);
  assert.ok(stock.entries.filter((e) => e.timeframe === "daily").every((e) => e.comparable === false));
  assert.equal(stock.cumulativeTests, 0);
  assert.equal(stock.dailyTests, 10);
  assert.ok(stock.entries.find((e) => e.grade === "adopted_daily"));
  assert.equal(same.entries.some((e) => e.timeframe === "daily"), false);
});

test("ctMemory hides measured numbers of rules whose window reaches this run's development/final, shows older ones", async () => {
  sqlite.exec("DELETE FROM strategy_generation_runs;");
  const { spec } = await import("./helpers/ct-fixture.mjs");
  const day = 86_400_000;
  const oldCt = { ...ctState(), contract: { ...contract }, dataHash: "d", trials: [{ id: "o:0", spec: spec(), reasons: ["비용 2배 스트레스 실패"], development: { netReturnPct: 1.5 } }] };
  const now = Date.now();
  await store.createGenerationJob({ id: "memory-old", ownerId: "owner", slot: "open", status: "completed", stageIndex: 0, createdAt: new Date(now - 5000).toISOString(), updatedAt: new Date(now - 5000).toISOString(), from: "a", to: "b", capitalUsd: 1, budgetUsd: 8, costUsd: 0, brief: "", events: [], calls: [], universe: ["BTCUSDT"], ct: oldCt });
  sqlite.prepare("UPDATE strategy_generation_runs SET created_at=? WHERE id='memory-old'").run(now - 5000);
  const mk = (over) => ({ id: "memory-new", ownerId: "owner", createdAt: new Date(now).toISOString(), ct: { ...ctState(), contract: { ...contract, ...over } } });
  const same = await research.ctMemory(mk({}));
  assert.equal(same.length, 1);
  assert.equal(same[0].netReturnPct, null);
  assert.equal(same[0].overlaps, true);
  assert.deepEqual(same[0].diagnostics, ["비용 2배 스트레스 실패"]);
  const later = await research.ctMemory(mk({ fromMs: contract.fromMs + 100 * day, trainingToMs: contract.toMs + 20 * day, developmentToMs: contract.toMs + 40 * day, toMs: contract.toMs + 60 * day }));
  assert.equal(later[0].netReturnPct, 1.5);
});
