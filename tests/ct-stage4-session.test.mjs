// Stage 4 in a real session (fake fetch, the real request layer): 16–32-chart blind sets with reserve anchors, the seen-anchor rule,
// control groups, calibration records, "already measured", summarized thinking, stage-3 contracts unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { ctState } from "./helpers/ct-fixture.mjs";
import { plantedMarket, plantedContract, MINUTE } from "./helpers/ct-trader-fixture.mjs";
import { ctHash, CT_POLICY } from "../lib/ct-spec.ts";
import { STAGE3_POLICY, STAGE4_POLICY } from "./helpers/ct-policies.mjs";
import { ctRunLabels, ctLabelMovesReport, ctLabelMovesSchema, ctContrastMovesSchema } from "../lib/ct-trader-tools.ts";
import { CT_DESIGNER_SYSTEM, CT_DESIGNER_SYSTEM_STAGE3, CT_DESIGNER_SYSTEM_STAGE4 } from "../lib/ct-research.ts";
import { sessionThinking } from "../lib/ct-activity.ts";
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
const playbook = await import("../lib/ct-playbook.ts");
const calibration = await import("../lib/ct-calibration.ts");
const measured = await import("../lib/ct-measured.ts");
await research.ensureCTSchema();

const sha = (x) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const { bars } = plantedMarket();
// This file is the stage-4 session: its contracts carry the stage-4 policy (the default policy has moved on to stage 5).
const contract = { ...plantedContract(), policy: STAGE4_POLICY };
const DATA_HASH = await ctHash({ BTCUSDT: bars });
const params = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30 });
let sequence = 0;
const advance = (id) => flow.advanceGeneration(id);
const now = () => new Date().toISOString();
async function job(over = {}, extra = {}) {
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled' WHERE status='running'");
  const ct = ctState();
  ct.phase = "design";
  ct.contract = { ...contract, ...(over.contract ?? {}) };
  ct.dataHash = DATA_HASH;
  const id = `s4-${++sequence}`;
  ct.playbook = await playbook.ctPlaybookSnapshot("owner", ct.contract, id);
  Object.assign(ct, extra);
  const j = { id, ownerId: "owner", slot: "open", status: "running", stageIndex: 0, createdAt: now(), updatedAt: now(), from: "2025-01-01", to: "2025-01-12", capitalUsd: 1e6, budgetUsd: 8, costUsd: 0, brief: "", events: [], calls: [], universe: ["BTCUSDT"], ct };
  await store.createGenerationJob(j);
  sqlite.prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)").run(j.id, "BTCUSDT", ct.contract.toMs, JSON.stringify(bars));
  return j;
}
function sse(events) {
  return new Response(new ReadableStream({ start(c) {
    for (const e of events) c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    c.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
/** A designer turn; `thinking` is the summary text a stage-4 request gets back (the default shows none: empty text + signature). */
function claudeTurn(id, tools, thinking = "", usage = { input: 40, write: 0, read: 0, output: 500 }) {
  const events = [
    { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1, cache_creation_input_tokens: usage.write, cache_read_input_tokens: usage.read } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    ...(thinking ? [{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } }] : []),
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
const resultOf = (req, id) => req.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_result" && b.tool_use_id === id);
const textOf = (r) => (typeof r.content === "string" ? r.content : r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
// The Anthropic client is cached with the fetch it first saw, so one dispatcher is installed once and each run swaps its handler.
let handler = null;
const baseFetch = globalThis.fetch;
globalThis.fetch = (...args) => (handler ? handler(...args) : baseFetch(...args));
/** Runs a scripted session to its end; returns the requests the real request layer sent. */
async function run(created, script) {
  globalThis.__strategyTestHooks.realLlm = true;
  const requests = [];
  handler = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ body, raw: options.body });
    const step = script[requests.length - 1];
    if (!step) throw new Error(`unscripted request #${requests.length}`);
    return sse(claudeTurn(`msg_${requests.length}`, step.tools, step.thinking ?? "", { input: 40, write: requests.length === 1 ? 9000 : 300, read: requests.length === 1 ? 0 : 9000, output: 500 }));
  };
  try {
    let j = await advance(created.id);
    for (let i = 0; i < 80 && j.status === "running" && j.ct.phase !== "done"; i++) j = await advance(created.id);
    return { j, requests };
  } finally {
    handler = null;
    globalThis.__strategyTestHooks.realLlm = false;
  }
}

test("pinned bytes: stage-2 and stage-3 briefs and the stage-3 tool definitions never change; stage 4 has its own", () => {
  assert.equal(sha(CT_DESIGNER_SYSTEM_STAGE3), "08e7ef36f0ec5d9a8a4731aa37ae6d47216ae3be4e4e7520217b4058e32cacba");
  assert.equal(sha(research.CT_SESSION_TOOLS_STAGE2), "8b81e696a38a070c1aecbe18fd94bdb579f214deae803ca69393596f86d229fb");
  assert.equal(sha(research.CT_SESSION_TOOLS_STAGE3), "0b76e033089573b92fe2958d474659e37dbebd3782028d42336529948c8723f6");
  // Stage 4 is fixed within a contract as well (a byte change invalidates every cached prefix of a running contract): change these pins together with a policy bump.
  assert.equal(sha(CT_DESIGNER_SYSTEM_STAGE4), "bc6b18e14505fdc67827872c1f6d57f21fdb558a65736bffe04cdda9ab015ad3");
  assert.equal(sha(research.CT_SESSION_TOOLS_STAGE4), "38763047f3977d83fa767e1033f8a4c97629d5ade4d98d7be52a69ea20b34848");
  assert.notEqual(sha(research.CT_SESSION_TOOLS_STAGE4), sha(research.CT_SESSION_TOOLS_STAGE3));
  assert.equal(research.ctSessionTools({ policy: STAGE3_POLICY }), research.CT_SESSION_TOOLS_STAGE3);
  assert.equal(research.ctSessionTools({ policy: STAGE4_POLICY }), research.CT_SESSION_TOOLS_STAGE4);
  assert.equal(research.ctSessionTools({ policy: CT_POLICY }), research.CT_SESSION_TOOLS);
  // Stage-4 tool names and order are the stage-3 ones; control groups and the blind-set size are in the definitions.
  assert.deepEqual(research.CT_SESSION_TOOLS_STAGE4.map((t) => t.name), research.CT_SESSION_TOOLS_STAGE3.map((t) => t.name));
  const contrast = research.CT_SESSION_TOOLS_STAGE4.find((t) => t.name === "contrast_moves");
  assert.ok(contrast.input_schema.properties.controls, "controls is in the stage-4 input schema");
  assert.ok(!research.CT_SESSION_TOOLS_STAGE3.find((t) => t.name === "contrast_moves").input_schema.properties.controls);
  assert.match(CT_DESIGNER_SYSTEM_STAGE4, /vol_matched[\s\S]*losers/);
  assert.match(CT_DESIGNER_SYSTEM_STAGE4, /calibration record/);
  assert.match(CT_DESIGNER_SYSTEM_STAGE4, /16–32 charts/);
});

test("a full stage-4 session: reserve anchors, a 16-chart blind set, the seen-anchor rule, calibration record, losers control, summarized thinking, eye hypothesis moved out of the playbook", async () => {
  // An earlier run measured exactly this label on exactly this training data.
  const label0 = "prior-label-1";
  await store.createGenerationJob({
    id: "prior-run", ownerId: "owner", slot: "open", status: "completed", stageIndex: 0, createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: now(), from: "a", to: "b", capitalUsd: 1, budgetUsd: 8, costUsd: 0, brief: "", events: [], calls: [], universe: ["BTCUSDT"],
    ct: {
      ...ctState(), phase: "done", endReason: "설계자 판단: 비용 후 우위 미발견", contract: { ...contract }, dataHash: DATA_HASH,
      labels: { [label0]: { labelId: label0, session: 0, at: "", params, events: 41, positiveMoments: 600, eventsPerDay: 5.1 } },
      contrasts: [{ contrastId: "prior-c1", labelId: label0, session: 0, at: "", from: contract.fromMs, to: contract.trainingToMs, features: [{ feature: "range_pct", timeframe: 1 }], topLift: { feature: "range_pct(10, 1m)", bin: "하위 20%", lift: 3.1 }, treeLeaves: 4, summary: "이벤트 41건" }],
      sessions: [{ index: 0, kind: "design", status: "submitted", startedAt: "", turns: 3, toolCalls: 3, screens: 0, messages: 4, submission: { candidates: 0, accepted: 0, duplicates: 0, noEdgeReason: "수축 뒤 확장은 변동성 효과였다. 나머지 문장은 잘린다.", rejectedHypotheses: [{ hypothesis: "수축 뒤 확장", mechanism: "m", evidence: ["prior-c1"], result: "방향 정보 없음" }] } }],
      tests: { signatures: { "label|k3|m1|h30|c1": 1 } },
    },
  });
  sqlite.prepare("UPDATE strategy_generation_runs SET created_at=? WHERE id='prior-run'").run(Date.now() - 60_000);
  // An earlier blind set, graded 6/8 (stage 3 filed it as a rejected idea; stage 4 keeps it as a calibration record).
  await calibration.ctRecordCalibration(calibration.ctCalibrationRow({ id: "prior-run", ownerId: "owner" }, { contract }, "b-prior", { correct: 6, total: 8 }, "migrated"));
  const created = await job();
  const label = (await ctHash({ run: created.id, params })).slice(0, 16);
  created.ct.calibration = await calibration.ctCalibrationSnapshot("owner", created.ct.contract, created.id);
  created.ct.measured = await measured.ctMeasuredBefore({ id: created.id, ownerId: "owner" }, created.ct.contract, DATA_HASH);
  sqlite.prepare("UPDATE strategy_generation_runs SET payload=? WHERE id=?").run(JSON.stringify(created), created.id);
  assert.equal(created.ct.measured.runs.length, 1);
  assert.equal(created.ct.calibration.records.length, 1);
  assert.equal(created.ct.calibration.records[0].verdict, "inconclusive");
  assert.equal(created.ct.calibration.pooled, null, "a set whose charts printed the decision time is listed but never pooled");
  assert.match(created.ct.calibration.records[0].chartFormat, /시각 표시/);

  const issued = ctLabelMovesReport(params, ctRunLabels(params, { BTCUSDT: bars }, contract), contract, label, { blindReserve: true });
  assert.ok(issued.blindReserve.anchors.length >= 8 && issued.blindReserve.controlAnchors.length >= 8);
  const displayed = new Set([...issued.anchors, ...issued.controlAnchors].map((a) => a.at));
  assert.ok([...issued.blindReserve.anchors, ...issued.blindReserve.controlAnchors].every((a) => !displayed.has(a.at)), "reserve times never repeat displayed ones");
  const seen = issued.anchors[0].at;
  const blindPos = issued.blindReserve.anchors.slice(0, 8).map((a) => a.at),
    blindCtl = issued.blindReserve.controlAnchors.slice(0, 8).map((a) => a.at);
  const blindAnchors = [...blindPos, ...blindCtl];
  const blindId = (await ctHash({ run: created.id, blind: [...blindAnchors].sort((a, b) => a - b) })).slice(0, 12);
  const contrastRequest = ctContrastMovesSchema.parse({ labelId: label, controls: "losers", features: [{ feature: "range_pct", lookback: 10, timeframe: 1 }] });
  const contrastId = (await ctHash({ run: created.id, request: contrastRequest })).slice(0, 16);
  const eyeText = "눈으로 사건과 대조군을 구분할 수 있다";
  const script = [
    { tools: [{ id: "t1", name: "label_moves", input: params }], thinking: "먼저 라벨을 본다. 이전 연구가 같은 정의를 이미 쟀는지 확인한다." },
    { tools: [{ id: "t2", name: "view_charts", input: { anchors: [seen] } }], thinking: "이벤트 하나를 눈으로 본다." },
    { tools: [{ id: "t3", name: "view_charts", input: { anchors: [seen, ...blindAnchors.slice(0, 15)], blind: true } }] },
    { tools: [{ id: "t4", name: "view_charts", input: { anchors: blindAnchors, blind: true } }], thinking: "방금 본 시각을 빼고 예비 앵커로 16장 세트를 만든다." },
    { tools: [{ id: "t5", name: "grade_blind", input: { blindId, predictions: blindAnchors.map((_, k) => ({ chart: k + 1, call: k % 2 ? "positive" : "control" })) } }] },
    { tools: [{ id: "t6", name: "contrast_moves", input: { labelId: label, controls: "losers", features: [{ feature: "range_pct", lookback: 10, timeframe: 1 }] } }] },
    { tools: [{ id: "t7", name: "contrast_moves", input: { labelId: label, features: [{ feature: "range_pct", lookback: 10, timeframe: 1 }], controls: "nonsense" } }] },
    { tools: [{ id: "t8", name: "submit_candidates", input: { candidates: [], noEdgeReason: "비용 후 우위를 찾지 못함", rejectedHypotheses: [
      { hypothesis: eyeText, mechanism: "재량 트레이더의 패턴 인식", evidence: [blindId], result: "블라인드 16장 중 8장, 판별력이 입증되지 않았다" },
      { hypothesis: "수축 뒤 확장", mechanism: "변동성 수축 뒤 확장", evidence: [label, contrastId], result: "방향 정보 없음" },
    ] } }] },
  ];
  const { j, requests } = await run(created, script);
  assert.equal(j.ct.phase, "done", j.error ?? j.ct.endReason);
  assert.equal(requests.length, 8);
  // Request layer: stage-4 brief and tools, summarized thinking asked for explicitly, tool_choice auto, no budget_tokens.
  for (const { body } of requests) {
    assert.equal(body.system[0].text, CT_DESIGNER_SYSTEM_STAGE4);
    assert.equal(sha(body.tools), sha(research.CT_SESSION_TOOLS_STAGE4));
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
    assert.ok(!body.tool_choice || body.tool_choice.type === "auto");
    assert.equal("budget_tokens" in body.thinking, false);
  }
  // The stable block carries what earlier runs measured and the eye's calibration (and the leak-safe playbook).
  const stable = requests[0].body.messages[0].content[0].text;
  assert.match(stable, /"alreadyMeasured"/);
  assert.match(stable, /"eyeCalibration"/);
  assert.match(stable, /"conclusion":"방향 정보 없음"/, "the earlier run's own result for that measurement");
  assert.equal(measured.ctFirstSentence("수축 뒤 확장은 변동성 효과였다. 나머지 문장은 잘린다."), "수축 뒤 확장은 변동성 효과였다.");
  assert.match(stable, /"verdict":"inconclusive"/);
  assert.match(stable, /"blindSetSize":\{"min":16,"default":24,"max":32\}/);
  // label_moves: reserve anchors, and it says an earlier run already measured this definition.
  const labelOut = JSON.parse(textOf(resultOf(requests[1], "t1")));
  assert.equal(labelOut.blindReserve.anchors.length, issued.blindReserve.anchors.length);
  assert.deepEqual(labelOut.previouslyMeasured.map((p) => p.runId), ["prior-ru"]);
  assert.match(labelOut.previouslyMeasured[0].conclusion, /방향 정보 없음/);
  // The seen-anchor rule: a blind set may not contain a time shown in an ordinary view.
  const refused = resultOf(requests[3], "t3");
  assert.equal(refused.is_error, true);
  assert.match(textOf(refused), /일반 보기로 이미 정답 그룹을 본 시각 1개/);
  // The corrected set: 16 images, group hidden, identical bytes in every later request.
  const blind = resultOf(requests[4], "t4");
  assert.equal(blind.content.filter((b) => b.type === "image").length, 16);
  assert.ok(!/이벤트\(양성\) 시점|대조군 시점/.test(textOf(blind).replace(/이벤트와 대조군이 절반씩/, "")));
  for (const k of [5, 6, 7]) assert.equal(JSON.stringify(resultOf(requests[k], "t4")), JSON.stringify(blind), `request ${k + 1} resends the identical images`);
  assert.equal(j.ct.sessions[0].charts, 17);
  assert.equal(j.ct.sessions[0].blinds, 1);
  // grade_blind reports the facts that make a small set readable, and the server filed a calibration record.
  const graded = JSON.parse(textOf(resultOf(requests[5], "t5")));
  assert.equal(graded.total, 16);
  assert.equal(graded.neededHitsForSignificance, 12);
  assert.equal(graded.verdict, "inconclusive");
  assert.ok(graded.powerIfEyeIs70Pct > 0.4 && graded.powerIfEyeIs70Pct < 0.5);
  assert.match(graded.reading, /판별력 없음.*아니라/);
  const rows = sqlite.prepare("SELECT * FROM ct_calibration WHERE run_id=?").all(created.id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].n, rows[0].verdict, rows[0].blind_id, rows[0].source], [16, "inconclusive", blindId, "research"]);
  assert.equal(j.ct.blinds[blindId].graded.verdict, "inconclusive");
  // contrast_moves with the losers control; an unknown control group is the model's error to fix.
  const contrastOut = JSON.parse(textOf(resultOf(requests[6], "t6")));
  assert.equal(contrastOut.controlMode, "losers");
  assert.equal(contrastOut.contrastId, contrastId);
  assert.ok(contrastOut.features[0].shape);
  assert.equal(resultOf(requests[7], "t7").is_error, true);
  assert.ok(Object.keys(j.ct.tests.signatures).some((k) => k.startsWith("contrast|") && k.endsWith("|losers")));
  assert.equal(j.ct.contrasts[0].request.controls, "losers");
  // The eye is not a trading idea: it left the playbook, the real hypothesis stayed.
  const sub = j.ct.sessions[0].submission;
  assert.equal(sub.rejectedHypotheses.length, 1);
  assert.equal(sub.calibrationRefs.length, 1);
  assert.equal(sub.calibrationRefs[0].blindId, blindId);
  const filed = sqlite.prepare("SELECT mechanism,evidence_ref FROM ct_playbook WHERE run_id=?").all(created.id);
  assert.ok(filed.some((r) => /수축 뒤 확장/.test(r.mechanism)));
  assert.ok(filed.every((r) => !r.evidence_ref.includes(blindId) && !/눈으로/.test(r.mechanism)), JSON.stringify(filed));
  // Summarized thinking is stored with the turn and reaches the progress data, turn by turn.
  const stored = messages(created.id).filter((m) => m.role === "assistant");
  assert.equal(stored[0].content[0].thinking, script[0].thinking);
  const turns = sessionThinking(messages(created.id));
  assert.equal(turns.length, 8);
  assert.equal(turns[0].text, script[0].thinking);
  assert.deepEqual(turns[0].tools, ["label_moves"]);
  assert.equal(turns[2].text, "", "a turn without a summary is reported empty, not invented");
});

test("a stage-3 contract keeps its request exactly: stage-3 brief and tools, thinking without display, no control groups", async () => {
  const created = await job({ contract: { policy: STAGE3_POLICY } });
  const label = (await ctHash({ run: created.id, params })).slice(0, 16);
  const script = [
    { tools: [{ id: "t1", name: "label_moves", input: params }] },
    { tools: [{ id: "t2", name: "contrast_moves", input: { labelId: label, features: [{ feature: "range_pct", lookback: 10, timeframe: 1 }], controls: "losers" } }] },
    { tools: [{ id: "t3", name: "contrast_moves", input: { labelId: label, features: [{ feature: "range_pct", lookback: 10, timeframe: 1 }] } }] },
    { tools: [{ id: "t4", name: "submit_candidates", input: { candidates: [], noEdgeReason: "우위 없음", rejectedHypotheses: [] } }] },
  ];
  const { j, requests } = await run(created, script);
  assert.equal(j.ct.phase, "done", j.error ?? j.ct.endReason);
  for (const { body } of requests) {
    assert.equal(sha(body.system[0].text), "08e7ef36f0ec5d9a8a4731aa37ae6d47216ae3be4e4e7520217b4058e32cacba");
    assert.equal(sha(body.tools), "0b76e033089573b92fe2958d474659e37dbebd3782028d42336529948c8723f6");
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal("display" in body.thinking, false);
  }
  const labelOut = JSON.parse(textOf(resultOf(requests[1], "t1")));
  assert.ok(!("blindReserve" in labelOut) && !("previouslyMeasured" in labelOut), "stage-3 label_moves output is unchanged");
  assert.equal(resultOf(requests[2], "t2").is_error, true, "a stage-3 request cannot name a control group");
  const ok = JSON.parse(textOf(resultOf(requests[3], "t3")));
  assert.ok(!("controlMode" in ok) && !("shape" in ok.features[0]), "stage-3 contrast_moves output is unchanged");
  const stable = requests[0].body.messages[0].content[0].text;
  assert.ok(!/alreadyMeasured|eyeCalibration|blindSetSize/.test(stable), "no stage-4 keys in a stage-3 stable block");
  // The stable block is built from fields frozen into the run, so playbook/calibration changes after the start cannot alter a resumed context.
  const { ctSessionContext } = await import("../lib/ct-research.ts");
  const before = ctSessionContext(j.ct, "", { rows: [] }, j.ct.sessions[0]).stable;
  sqlite.prepare("INSERT INTO ct_playbook (id,owner_id,run_id,market,symbols,timeframe,comparable,mechanism,structure,evidence_kind,evidence_ref,grade,reason,measured_from,measured_to,cost_profile,engine,source,detail,recorded_at) VALUES ('late-1','owner','late','crypto','[]','1m',1,'나중에 생긴 항목','s','queryId','q','rejected_in_training','r',0,1,'','e','research','{}',1)").run();
  await calibration.ctRecordCalibration(calibration.ctCalibrationRow({ id: "late", ownerId: "owner" }, { contract }, "b-late", { correct: 30, total: 40 }, "research"));
  assert.equal(ctSessionContext(j.ct, "", { rows: [] }, j.ct.sessions[0]).stable, before);
});

test("the session image limit counts blind sets too (stage 4 default is 48 per session)", async () => {
  const policy = { ...STAGE4_POLICY, sessionMaxCharts: 10 };
  const created = await job({ contract: { policy } });
  const label = (await ctHash({ run: created.id, params })).slice(0, 16);
  const issued = ctLabelMovesReport(params, ctRunLabels(params, { BTCUSDT: bars }, contract), contract, label, { blindReserve: true });
  const blindAnchors = [...issued.blindReserve.anchors.slice(0, 8), ...issued.blindReserve.controlAnchors.slice(0, 8)].map((a) => a.at);
  const script = [
    { tools: [{ id: "t1", name: "label_moves", input: params }] },
    { tools: [{ id: "t2", name: "view_charts", input: { anchors: blindAnchors, blind: true } }] },
    { tools: [{ id: "t3", name: "view_charts", input: { anchors: issued.anchors.slice(0, 3).map((a) => a.at) } }] },
    { tools: [{ id: "t4", name: "view_charts", input: { anchors: issued.anchors.slice(0, 8).map((a) => a.at), blind: true } }] },
    { tools: [{ id: "t5", name: "submit_candidates", input: { candidates: [], noEdgeReason: "우위 없음", rejectedHypotheses: [] } }] },
  ];
  const { j, requests } = await run(created, script);
  assert.equal(j.ct.phase, "done", j.error ?? j.ct.endReason);
  const limit = resultOf(requests[2], "t2");
  assert.equal(limit.is_error, true);
  assert.match(textOf(limit), /차트 이미지 한도 10장/);
  assert.equal(resultOf(requests[3], "t3").is_error ?? false, false, "3 ordinary charts fit");
  assert.match(textOf(resultOf(requests[4], "t4")), /블라인드 세트는 .*16–32장|8장 이하|이미지 한도/, "an 8-chart blind set is refused on a stage-4 contract");
});
