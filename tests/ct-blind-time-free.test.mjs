// Time-free blind sets (traderTools 5, 2026-10-16). Run 7a4354f4 (BTCUSDT, 15-minute labels) graded 18/24 on a stage-4 blind set
// whose "today" panel told how far into the day each chart was, while controls only shared their event's HOUR: the designer paired
// its own event/control times 30 minutes apart by panel length. Here: blind charts carry no time of day, controls share the
// event's bar slot, times of an ungraded set cannot be opened any other way, and old and new formats are never pooled together.
// Older contracts (free bars, stage 5 and before) keep their brief, tools and chart bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { ctState } from "./helpers/ct-fixture.mjs";
import { plantedMarket, plantedContract, MINUTE, DAY } from "./helpers/ct-trader-fixture.mjs";
import { ctHash, CT_POLICY, ctSessionPolicy } from "../lib/ct-spec.ts";
import { FREEBARS_POLICY, STAGE5_POLICY } from "./helpers/ct-policies.mjs";
import { ctRunLabels, ctLabelMovesReport, ctLabelMovesSchemaBars, ctChartable } from "../lib/ct-trader-tools.ts";
import { ctRenderChart, ctBase64 } from "../lib/ct-chart-image.ts";
import { CT_DESIGNER_SYSTEM, CT_DESIGNER_SYSTEM_FREEBARS, CT_DESIGNER_SYSTEM_STAGE5, ctDesignerSystem } from "../lib/ct-research.ts";
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
await research.ensureCTSchema();

const sha = (x) => createHash("sha256").update(typeof x === "string" || x instanceof Uint8Array ? x : JSON.stringify(x)).digest("hex");
// 24 days, 18 of them training: time-free anchors need five days of chart history behind them. The first 12 days are the
// default planted market bar for bar (same seed, same sequence), so the pinned chart bytes below are those of that market.
const { bars } = plantedMarket({ days: 24 });
const contract = { ...plantedContract({ days: 24, trainingDays: 18 }), policy: CT_POLICY };
const params = ctLabelMovesSchemaBars.parse({ k: 3, m: 1, horizon: 8, barMinutes: 15 });
const minuteOfDay = (ms) => (ms % DAY) / MINUTE;

/* ------------------------------------------------------------------ frozen bytes */

test("free-bar contracts (traderTools 4) keep their brief and tools byte for byte; time-free contracts change only the blind words", () => {
  // Pinned from HEAD e87ae79, where they were the newest brief and tool set.
  assert.equal(sha(CT_DESIGNER_SYSTEM_FREEBARS), "f3102e453b4677fdeb3192ead49c9b218f5cef280acbf709d7ad6a81b6e1e440");
  assert.equal(sha(research.CT_SESSION_TOOLS_FREEBARS), "a9c1ed2be37725b7070388389e31cc9d6117a1820f1227e116a90007604b3685");
  assert.equal(CT_POLICY.traderTools, 5);
  assert.equal(ctDesignerSystem({ policy: FREEBARS_POLICY }), CT_DESIGNER_SYSTEM_FREEBARS);
  assert.equal(ctDesignerSystem({ policy: STAGE5_POLICY }), CT_DESIGNER_SYSTEM_STAGE5);
  assert.equal(ctDesignerSystem({ policy: CT_POLICY }), CT_DESIGNER_SYSTEM);
  assert.equal(research.ctSessionTools({ policy: FREEBARS_POLICY }), research.CT_SESSION_TOOLS_FREEBARS);
  assert.equal(research.ctSessionTools({ policy: CT_POLICY }), research.CT_SESSION_TOOLS);
  assert.equal(ctSessionPolicy({ policy: FREEBARS_POLICY }).timeFreeBlind, false);
  assert.equal(ctSessionPolicy({ policy: FREEBARS_POLICY }).freeBars, true);
  assert.equal(ctSessionPolicy({ policy: CT_POLICY }).timeFreeBlind, true);
  // Same tools in the same order; only label_moves and view_charts are new objects, and only their descriptions differ.
  assert.deepEqual(research.CT_SESSION_TOOLS.map((t) => t.name), research.CT_SESSION_TOOLS_FREEBARS.map((t) => t.name));
  for (const t of research.CT_SESSION_TOOLS) {
    const old = research.CT_SESSION_TOOLS_FREEBARS.find((x) => x.name === t.name);
    if (t.name === "label_moves" || t.name === "view_charts") {
      assert.notEqual(t.description, old.description, t.name);
      assert.equal(JSON.stringify(t.input_schema), JSON.stringify(old.input_schema), t.name);
    } else assert.equal(t, old, t.name);
  }
  assert.match(research.CT_SESSION_TOOLS.find((t) => t.name === "view_charts").description, /no time of day at all/);
  assert.match(research.CT_SESSION_TOOLS.find((t) => t.name === "label_moves").description, /bar slot of the day/);
  // The brief: the stage-4 blind sentence is replaced, nothing else moves.
  const [before, after] = CT_DESIGNER_SYSTEM_FREEBARS.split(/A blind set may only use times[^\n]*?own list\./);
  assert.ok(CT_DESIGNER_SYSTEM.startsWith(before) && CT_DESIGNER_SYSTEM.endsWith(after));
  assert.match(CT_DESIGNER_SYSTEM, /judge the shape, not the clock/);
  assert.doesNotMatch(CT_DESIGNER_SYSTEM, /relative minutes only/);
});

test("chart bytes of ordinary and stage-4 blind charts are unchanged (pinned before the time-free format)", async () => {
  const pins = {
    [3 * 1440 + 14 * 60 + 37]: ["af73f8c630989f990541f31942c8608bb8b53e1247cf14fd3c5597a20b4fe0a4", "25fd53a1c19eb235271b36ee5f5ce033cd0d6f0b23a76bade39cc3192753c3ed"],
    [4 * 1440 + 20]: ["0da4195db863481b9db71eb99bcea04bd82e5af889e3f9b1ff5683d335ba02a5", "bff99916b94b10dc0f221e385abfed858b6b14e4bcd34002a27d3ea17dcecd1e"],
    [5 * 1440 + 23 * 60 + 5]: ["5837cfea84c116ae260e9b0baf1e2354d4df6bdde6a359ba38198de558e5b17f", "6ff773a37b30bdc304ee95fd8f2e4f8692df7f7b26ad1c529f2af10856693217"],
  };
  for (const [index, [ordinary, blind]] of Object.entries(pins)) {
    const at = bars[Number(index)].endMs;
    assert.equal(sha((await ctRenderChart(bars, at, contract, "BTCUSDT", 3)).png), ordinary, `ordinary ${index}`);
    assert.equal(sha((await ctRenderChart(bars, at, contract, "BTCUSDT", 3, { blind: true })).png), blind, `stage-4 blind ${index}`);
  }
});

/* ------------------------------------------------------------------ the picture */

/** The same market with every timestamp moved by `d`: the same shapes at another time of day. */
const shifted = (d) => ({
  bars: bars.map((b) => ({ ...b, startMs: b.startMs + d, endMs: b.endMs + d })),
  contract: { ...contract, fromMs: contract.fromMs + d, trainingToMs: contract.trainingToMs + d, developmentToMs: contract.developmentToMs + d, toMs: contract.toMs + d },
});

test("a time-free blind chart depends on nothing but the bars before the decision: the same market at another time of day draws the same bytes", async () => {
  const index = 6 * 1440 + 20; // 00:21 UTC: the stage-4 "today" panel is 21 minutes long here (and five full days lie behind it)
  const at = bars[index].endMs;
  const free = await ctRenderChart(bars, at, contract, "BTCUSDT", 5, { blind: true, timeFree: true });
  const stage4 = await ctRenderChart(bars, at, contract, "BTCUSDT", 5, { blind: true });
  for (const d of [15 * MINUTE, 37 * MINUTE, 5 * 60 * MINUTE, 13 * 60 * MINUTE + 45 * MINUTE]) {
    const s = shifted(d);
    const moved = await ctRenderChart(s.bars, at + d, s.contract, "BTCUSDT", 5, { blind: true, timeFree: true });
    assert.equal(sha(moved.png), sha(free.png), `time-free picture moved by ${d / MINUTE} minutes`);
    const moved4 = await ctRenderChart(s.bars, at + d, s.contract, "BTCUSDT", 5, { blind: true });
    assert.notEqual(sha(moved4.png), sha(stage4.png), `the stage-4 blind picture tells the time of day (moved by ${d / MINUTE} minutes)`);
  }
  // No clock, no day separators, no opening range, no "today": fixed windows ending at the decision.
  assert.ok(!free.labels.some((l) => /\d\d:\d\d|today|decision at|OR first|PDH|D-\d|^D0$/.test(l)), JSON.stringify(free.labels));
  assert.ok(free.labels.some((l) => /every panel ends at the decision/.test(l)));
  assert.deepEqual([free.data.h1.length, free.data.m5.length, free.data.m1.length], [120, 72, 90]);
  assert.equal(free.data.openingRange, null);
  assert.ok(free.data.maxEndMs <= at, "nothing after the decision");
  // Bars are built backwards from the decision: the last bar of every panel closes at the decision.
  for (const panel of [free.data.h1, free.data.m5, free.data.m1]) assert.equal(panel.at(-1).endMs, at);
  // Nothing after the decision is read: poisoning the future leaves the bytes alone.
  const poisoned = bars.map((b) => (b.endMs > at ? { ...b, high: b.high * 3, close: b.close * 2, volume: 1e9 } : b));
  assert.equal(sha((await ctRenderChart(poisoned, at, contract, "BTCUSDT", 5, { blind: true, timeFree: true })).png), sha(free.png));
});

test("a blind set from a 15-minute label cannot be ordered by panel length: every event and control chart carries the same time-of-day information", async () => {
  const runs = ctRunLabels(params, { BTCUSDT: bars }, contract);
  const report = ctLabelMovesReport(params, runs, contract, "label-tf", { blindReserve: true, controlSlot: "bar" });
  const stage4 = ctLabelMovesReport(params, runs, contract, "label-tf", { blindReserve: true });
  assert.match(report.controlMatching, /같은 봉 자리/);
  assert.equal("controlMatching" in stage4, false, "hour matching reports what it always did");
  // Only moments with five days of chart history behind them are issued (a short hourly panel would single a chart out).
  const issued = [...report.anchors, ...report.controlAnchors, ...report.blindReserve.anchors, ...report.blindReserve.controlAnchors];
  assert.ok(issued.every((a) => ctChartable(a.at, contract) && a.at >= contract.fromMs + 5 * DAY));
  assert.ok(stage4.anchors.some((a) => !ctChartable(a.at, contract)), "hour matching still issues early moments, as before");
  assert.equal(report.events, stage4.events, "the counts use every event");
  const events = report.blindReserve.anchors.slice(0, 8),
    controls = report.blindReserve.controlAnchors.slice(0, 8);
  assert.equal(controls.length, 8);
  // Every control sits on the quarter hour of an event (an event whose cell has no label-0 bar gets none, so the lists need not
  // line up one to one); hour matching put controls up to 45 minutes away within the hour, which is what run 7a4354f4 used.
  const slots = (list) => new Set(list.map((a) => minuteOfDay(a.at)));
  const eventSlots = slots(report.blindReserve.anchors);
  assert.ok(report.blindReserve.controlAnchors.every((c) => eventSlots.has(minuteOfDay(c.at))));
  assert.ok(report.controlAnchors.every((c) => slots(report.anchors).has(minuteOfDay(c.at))));
  assert.ok(stage4.blindReserve.controlAnchors.some((c) => !slots(stage4.blindReserve.anchors).has(minuteOfDay(c.at))), "the run's leak: same hour, another quarter");
  // Everything about position in time is identical across the 16 time-free charts: bar counts, every bar's offset from the
  // decision, and the tick labels. Panel length cannot sort events from controls (or pair them).
  const layout = (img) => JSON.stringify({
    panels: [img.data.h1, img.data.m5, img.data.m1].map((p) => p.map((b) => [b.startMs - img.data.at, b.endMs - img.data.at])),
    ticks: img.labels.filter((l) => /^-\d+[mh]$/.test(l)),
    window: [img.data.dayStart - img.data.at, img.data.dayEnd - img.data.at],
  });
  const charts = [];
  for (const a of [...events, ...controls]) charts.push({ group: a.group, image: await ctRenderChart(bars, a.at, contract, "BTCUSDT", 1, { blind: true, timeFree: true }) });
  assert.equal(new Set(charts.map((c) => layout(c.image))).size, 1, "one layout for all 16 charts");
  // The stage-4 picture of the same set: the 5-minute "today" panel length differs between an event and its hour-matched control.
  const len = async (at) => (await ctRenderChart(bars, at, contract, "BTCUSDT", 1, { blind: true })).data.m5.length;
  const oldEvents = stage4.blindReserve.anchors.slice(0, 8),
    oldControls = stage4.blindReserve.controlAnchors.slice(0, 8);
  const differ = [];
  for (const [k, c] of oldControls.entries()) if ((await len(c.at)) !== (await len(oldEvents[k].at))) differ.push(k);
  assert.ok(differ.length > 0, "stage-4 blind charts of hour-matched pairs could be told apart by panel length");
});

/* ------------------------------------------------------------------ calibration records */

test("old and new blind formats are never pooled together; the owner-excluded 7a4354f4 set is pooled by no policy; records are only listed, never removed", async () => {
  sqlite.exec("DELETE FROM ct_calibration;");
  const c = { ...contract };
  const mk = (run, blind, k, n, format) =>
    calibration.ctRecordCalibration(calibration.ctCalibrationRow({ id: run, ownerId: "owner" }, { contract: c }, blind, { correct: k, total: n }, "research", format));
  const contaminated = "7a4354f4-ae1e-49ba-9f1b-9d5e33734498:blind:562efbccb2a2";
  assert.ok(calibration.CT_CALIBRATION_EXCLUDED[contaminated], "the owner's exclusion (2026-10-16) names the exact record");
  await mk("7a4354f4-ae1e-49ba-9f1b-9d5e33734498", "562efbccb2a2", 18, 24, calibration.CT_CHART_FORMAT_BLIND);
  await mk("older-s4", "b4", 12, 24, calibration.CT_CHART_FORMAT_BLIND);
  await mk("free-1", "f1", 13, 24, calibration.CT_CHART_FORMAT_BLIND_TIME_FREE);
  await mk("free-2", "f2", 11, 24, calibration.CT_CHART_FORMAT_BLIND_TIME_FREE);
  await mk("printed", "p1", 7, 8, calibration.CT_CHART_FORMAT);
  assert.equal(calibration.ctBlindChartFormat(5), "ct-chart-3-blind");
  assert.equal(calibration.ctBlindChartFormat(4), "ct-chart-2-blind");
  assert.equal(calibration.ctBlindChartFormat(2), "ct-chart-2-blind");
  assert.equal(calibration.ctBlindChartFormat(1), "ct-chart-1");
  // A time-free run pools only time-free sets: the contaminated 18/24 never reaches it.
  const fresh = await calibration.ctCalibrationSnapshot("owner", c, "new-run", calibration.ctBlindChartFormat(ctSessionPolicy(c).toolsVersion));
  assert.deepEqual([fresh.pooled.sets, fresh.pooled.n, fresh.pooled.hits], [2, 48, 24]);
  assert.equal(fresh.pooled.verdict, "no_skill", "48 charts are enough to say it");
  const byRun = Object.fromEntries(fresh.records.map((r) => [r.run, r]));
  assert.equal(byRun["7a4354f4"].chartFormat, "시각 숨김(오늘 패널 길이로 시각을 맞춘 흔적(소유자 결정으로 합산 제외) · 합산하지 않음)");
  assert.equal(byRun["older-s4"].chartFormat, "시각 숨김(오늘 패널 길이로 시간대 식별 가능성 · 합산하지 않음)");
  assert.equal(byRun["7a4354f4"].hits, 18, "listed with its numbers, just not pooled");
  assert.equal(byRun["free-1"].chartFormat, "시각·시간대 숨김");
  assert.match(byRun["printed"].chartFormat, /시각 표시/);
  assert.match(fresh.note, /ct-chart-3-blind/);
  // A stage-4 / free-bar run pools its own format as before — without the excluded set (the owner's decision) — and in the same
  // words for every other record (the time-free sets are another format to it).
  const old = await calibration.ctCalibrationSnapshot("owner", c, "new-run");
  assert.deepEqual([old.pooled.sets, old.pooled.n, old.pooled.hits], [1, 24, 12], "only older-s4: 18/24 of 7a4354f4 is left out");
  assert.equal(old.pooled.verdict, "inconclusive");
  const oldBy = Object.fromEntries(old.records.map((r) => [r.run, r]));
  assert.equal(oldBy["7a4354f4"].chartFormat, "시각 숨김(오늘 패널 길이로 시각을 맞춘 흔적(소유자 결정으로 합산 제외) · 합산하지 않음)");
  assert.equal(oldBy["7a4354f4"].hits, 18, "still listed with its numbers");
  assert.equal(oldBy["older-s4"].chartFormat, "시각 숨김");
  assert.equal(oldBy["free-1"].chartFormat, "시각·시간대 숨김(다른 형식 · 합산하지 않음)");
  assert.match(old.note, /^설계자의 '눈'\(차트 판독\)을 블라인드 세트로 잰 보정 기록\(합산은 결정 시각을 숨긴 세트만\)/);
  // Nothing is deleted or edited.
  const row = sqlite.prepare("SELECT * FROM ct_calibration WHERE id=?").get(contaminated);
  assert.deepEqual([row.n, row.k, row.verdict, row.chart_format], [24, 18, "skill", "ct-chart-2-blind"], "the row itself is untouched");
  // The same exclusion for every older policy that pools the stage-4 format.
  for (const v of [2, 3, 4]) {
    const snap = await calibration.ctCalibrationSnapshot("owner", c, "new-run", calibration.ctBlindChartFormat(v));
    assert.equal(snap.pooled.n, 24, `traderTools ${v}`);
  }
  assert.equal(sqlite.prepare("SELECT count(*) n FROM ct_calibration").get().n, 5);
});

/* ------------------------------------------------------------------ a real session */

const DATA_HASH = await ctHash({ BTCUSDT: bars });
const now = () => new Date().toISOString();
async function job() {
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled' WHERE status='running'");
  const ct = ctState();
  ct.phase = "design";
  ct.contract = { ...contract };
  ct.dataHash = DATA_HASH;
  const id = "tf-1";
  ct.playbook = await playbook.ctPlaybookSnapshot("owner", ct.contract, id);
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
function claudeTurn(id, tools) {
  const events = [
    { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1, cache_creation_input_tokens: 300, cache_read_input_tokens: 9000 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${id}` } },
    { type: "content_block_stop", index: 0 },
  ];
  tools.forEach((t, k) => events.push(
    { type: "content_block_start", index: k + 1, content_block: { type: "tool_use", id: t.id, name: t.name, input: {} } },
    { type: "content_block_delta", index: k + 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } },
    { type: "content_block_stop", index: k + 1 },
  ));
  events.push({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 500 } }, { type: "message_stop" });
  return events;
}
const resultOf = (req, id) => req.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_result" && b.tool_use_id === id);
const textOf = (r) => (typeof r.content === "string" ? r.content : r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
let handler = null;
const baseFetch = globalThis.fetch;
globalThis.fetch = (...args) => (handler ? handler(...args) : baseFetch(...args));
async function run(created, script) {
  globalThis.__strategyTestHooks.realLlm = true;
  const requests = [];
  handler = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ body });
    const step = script[requests.length - 1];
    if (!step) throw new Error(`unscripted request #${requests.length}`);
    return sse(claudeTurn(`msg_${requests.length}`, step.tools));
  };
  try {
    let j = await flow.advanceGeneration(created.id);
    for (let i = 0; i < 80 && j.status === "running" && j.ct.phase !== "done"; i++) j = await flow.advanceGeneration(created.id);
    return { j, requests };
  } finally {
    handler = null;
    globalThis.__strategyTestHooks.realLlm = false;
  }
}

test("a time-free session: slot-matched controls, time-free blind images, an ungraded set's times stay closed to read_bars and ordinary views, a ct-chart-3-blind record", async () => {
  sqlite.exec("DELETE FROM ct_calibration;");
  const created = await job();
  const label = (await ctHash({ run: created.id, params })).slice(0, 16);
  const issued = ctLabelMovesReport(params, ctRunLabels(params, { BTCUSDT: bars }, contract), contract, label, { blindReserve: true, controlSlot: "bar" });
  const blindAnchors = [...issued.blindReserve.anchors.slice(0, 8), ...issued.blindReserve.controlAnchors.slice(0, 8)].map((a) => a.at);
  const readable = (at) => at - 21 * 15 * MINUTE >= contract.fromMs && at + 9 * 15 * MINUTE <= contract.trainingToMs;
  const readFirst = issued.blindReserve.anchors.slice(8).find((a) => readable(a.at)).at;
  const blindId = (await ctHash({ run: created.id, blind: [...blindAnchors].sort((a, b) => a - b) })).slice(0, 12);
  const inSet = blindAnchors.find(readable);
  const script = [
    { tools: [{ id: "t1", name: "label_moves", input: params }] },
    { tools: [{ id: "t2", name: "read_bars", input: { anchors: [readFirst], before: 20, after: 8, barMinutes: 15 } }] },
    { tools: [{ id: "t3", name: "view_charts", input: { anchors: [readFirst, ...blindAnchors.slice(0, 7), ...blindAnchors.slice(8)], blind: true } }] },
    { tools: [{ id: "t4", name: "view_charts", input: { anchors: blindAnchors, blind: true } }] },
    { tools: [{ id: "t5", name: "read_bars", input: { anchors: [inSet], before: 20, after: 8, barMinutes: 15 } }] },
    { tools: [{ id: "t6", name: "view_charts", input: { anchors: [blindAnchors[9]] } }] },
    { tools: [{ id: "t7", name: "grade_blind", input: { blindId, predictions: blindAnchors.map((_, k) => ({ chart: k + 1, call: k % 2 ? "positive" : "control" })) } }] },
    { tools: [{ id: "t8", name: "read_bars", input: { anchors: [inSet], before: 20, after: 8, barMinutes: 15 } }] },
    { tools: [{ id: "t9", name: "submit_candidates", input: { candidates: [], noEdgeReason: "비용 후 우위를 찾지 못함", rejectedHypotheses: [], lessonChecks: [] } }] },
  ];
  const { j, requests } = await run(created, script);
  assert.equal(j.ct.phase, "done", j.error ?? j.ct.endReason);
  assert.equal(requests.length, script.length);
  for (const { body } of requests) {
    assert.equal(body.system[0].text, CT_DESIGNER_SYSTEM);
    assert.equal(sha(body.tools), sha(research.CT_SESSION_TOOLS));
  }
  // label_moves: controls share their event's quarter hour.
  const labelOut = JSON.parse(textOf(resultOf(requests[1], "t1")));
  assert.match(labelOut.controlMatching, /같은 봉 자리/);
  assert.deepEqual(labelOut.blindReserve.controlAnchors.map((a) => a.at), issued.blindReserve.controlAnchors.map((a) => a.at));
  // A time opened with read_bars is refused in a blind set (its bars and what followed were its answer).
  const refused = resultOf(requests[3], "t3");
  assert.equal(refused.is_error, true);
  assert.match(textOf(refused), /read_bars로 이미 연 시각 1개/);
  // The set: 16 images, each the time-free picture of one of the 16 times.
  const blind = resultOf(requests[4], "t4");
  const images = blind.content.filter((b) => b.type === "image").map((b) => b.source.data);
  assert.equal(images.length, 16);
  const drawn = j.ct.charts.filter((x) => x.blind === blindId).sort((a, b) => a.n - b.n);
  assert.deepEqual(drawn.map((x) => x.at).sort(), [...blindAnchors].sort());
  for (const [k, x] of drawn.entries())
    assert.equal(images[k], ctBase64((await ctRenderChart(bars, x.at, contract, "BTCUSDT", x.n, { blind: true, timeFree: true })).png), `chart #${x.n} is the time-free picture`);
  assert.match(textOf(blind), /시계·하루 경계가 없습니다/);
  // Until it is graded, its times cannot be opened with read_bars or in an ordinary view.
  assert.equal(resultOf(requests[5], "t5").is_error, true);
  assert.match(textOf(resultOf(requests[5], "t5")), /채점 전 블라인드 세트의 시각 1개는 read_bars로/);
  assert.equal(resultOf(requests[6], "t6").is_error, true);
  assert.match(textOf(resultOf(requests[6], "t6")), /채점 전 블라인드 세트의 시각 1개는 일반 보기로/);
  // Graded: filed in the time-free format; afterwards the times open normally.
  const graded = JSON.parse(textOf(resultOf(requests[7], "t7")));
  assert.equal(graded.total, 16);
  const rows = sqlite.prepare("SELECT chart_format, n FROM ct_calibration WHERE run_id=?").all(created.id);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ chart_format: "ct-chart-3-blind", n: 16 }]);
  assert.equal(resultOf(requests[8], "t8").is_error ?? false, false, textOf(resultOf(requests[8], "t8")));
  assert.deepEqual(j.ct.barsRead, [readFirst, inSet]);
});
