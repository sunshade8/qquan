import test from "node:test";
import assert from "node:assert/strict";
import { ctAgents, ctNow, ctTimeline, mergeCalls, pickMeter, stalledFor } from "../lib/ct-activity.ts";

const contract = { symbols: ["NVDA"], minutes: 15, policy: { maxCandidates: 6, maxActiveMs: 1_800_000 } };
const ct = (over = {}) => ({ phase: "design", contract, sources: [{ id: "s1" }], trials: [], tools: [], backtests: 0, ...over });
const call = (over = {}) => ({
  id: "c1", key: "k", role: "designer", model: "gpt-6.1-sol", provider: "OpenAI", status: "started",
  startedAt: "2026-10-12T22:40:46.064Z", updatedAt: "2026-10-12T22:41:00.000Z", usage: { input_tokens: 9476, output_tokens: 120 },
  estimated: true, costUsd: 0.01, reserveUsd: 0.34, result: { big: true }, ...over,
});
const job = (over = {}) => ({
  id: "j1", status: "running", createdAt: "2026-10-12T22:39:27.223Z", updatedAt: "2026-10-12T22:40:46.070Z",
  costUsd: 0.1, budgetUsd: 8, error: null, ct: ct(), calls: [], ...over,
});
const meter = (c) => ({ jobId: "j1", call: c, costUsd: 0.1, uncertainUsd: 0 });

test("a meter streams tokens into the call in flight and drops heavy fields", () => {
  const live = { ...call({ updatedAt: "2026-10-12T22:42:00.000Z", usage: { input_tokens: 9476, output_tokens: 5000 } }) };
  delete live.result;
  delete live.key;
  const merged = mergeCalls([call()], meter(live));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].usage.output_tokens, 5000);
  assert.equal("result" in merged[0], false);
  assert.equal("key" in merged[0], false);
});

test("a stale 'started' meter never resurrects a call the payload marks failed", () => {
  // Real case 2026-10-12: the designer hit 16,000 output tokens, the call failed at the
  // same millisecond the last meter (still "started") was written.
  const failed = call({ status: "failed", updatedAt: "2026-10-12T22:44:53.060Z", usage: { output_tokens: 16000 }, error: "OpenAI 구조화 응답이 완성되지 않았습니다." });
  const merged = mergeCalls([failed], meter({ ...failed, status: "started" }));
  assert.equal(merged[0].status, "failed");
  const j = job({
    calls: [failed],
    updatedAt: "2026-10-12T22:44:53.069Z",
    error: failed.error,
    recovery: { failures: 1, retryAt: "2026-10-12T22:45:03.069Z", message: failed.error },
  });
  const now = ctNow(j, merged);
  assert.equal(now.kind, "retry");
  // A legacy "designer" call is shown as the CT research/design agent.
  assert.equal(now.agent, "ctDesigner");
  assert.equal(now.truncatedAt, 16000);
  // Retry was due at 22:45:03; 45s of grace, then nobody advanced it.
  assert.equal(stalledFor(now, Date.parse("2026-10-12T22:45:30.000Z")), 0);
  assert.ok(stalledFor(now, Date.parse("2026-10-12T22:52:11.000Z")) > 7 * 60_000);
  const designer = ctAgents(j, merged, now).find((a) => a.id === "ctDesigner");
  assert.equal(designer.state, "retry");
  assert.equal(designer.outputTokens, 16000);
});

test("the current actor is the model call, else the running tool, else the phase owner", () => {
  const c = call();
  assert.equal(ctNow(job({ calls: [c] }), mergeCalls([c], null)).kind, "model");
  const tool = { id: "t1", name: "backtest", at: "2026-10-12T22:41:00.000Z", status: "started", input: { kind: "development" } };
  const withTool = job({ ct: ct({ phase: "experiment", tools: [tool] }) });
  const now = ctNow(withTool, []);
  assert.equal(now.kind, "tool");
  assert.equal(now.agent, "engine");
  assert.equal(ctAgents(withTool, [], now).find((a) => a.id === "engine").state, "working");
  const between = ctNow(job({ ct: ct({ phase: "sources" }) }), []);
  assert.deepEqual([between.kind, between.agent], ["between", "ctOrchestrator"]);
  assert.equal(ctNow(job({ status: "paused" }), []).kind, "paused");
  assert.equal(ctNow(job({ status: "completed" }), []).kind, "ended");
});

test("a silent model call gets minutes before it counts as stalled; a step transition does not", () => {
  const c = call({ updatedAt: "2026-10-12T22:40:46.064Z" });
  const now = ctNow(job({ calls: [c] }), mergeCalls([c], null));
  assert.equal(stalledFor(now, Date.parse("2026-10-12T22:44:00.000Z")), 0);
  assert.ok(stalledFor(now, Date.parse("2026-10-12T22:47:00.000Z")) > 0);
  const between = ctNow(job(), []);
  assert.ok(stalledFor(between, Date.parse("2026-10-12T22:41:40.000Z")) > 0);
});

test("the newer meter wins, and only for its own job", () => {
  const saved = meter(call({ updatedAt: "2026-10-12T22:41:00.000Z" }));
  const streamed = meter(call({ updatedAt: "2026-10-12T22:41:02.000Z" }));
  assert.equal(pickMeter("j1", saved, streamed), streamed);
  assert.equal(pickMeter("j1", streamed, saved), streamed);
  assert.equal(pickMeter("other", saved, streamed), saved);
});

test("the timeline interleaves tool and model calls by time with stable keys", () => {
  const tools = [
    { id: "a", name: "inspect_data", at: "2026-10-12T22:39:31.584Z", status: "completed", input: {} },
    { id: "b", name: "analyze_training", at: "2026-10-12T22:40:46.056Z", status: "completed", input: {} },
  ];
  const entries = ctTimeline(tools, mergeCalls([call({ startedAt: "2026-10-12T22:40:00.000Z" })], null));
  assert.deepEqual(entries.map((e) => e.key), ["t:a:0", "c:c1", "t:b:1"]);
});

test("truncation uses the recorded stop reason and allowance, not the role default", () => {
  const recovery = { failures: 0, retryAt: "2026-10-13T00:00:10.000Z", message: "한도 32,000토큰 · 추론 medium 설정으로 1회 재시도" };
  const cut = call({ status: "failed", maxOutputTokens: 16000, effort: "high", incompleteReason: "max_output_tokens", reasoningTokens: 15700, usage: { output_tokens: 16000 } });
  const now = ctNow(job({ calls: [cut], recovery }), mergeCalls([cut], null));
  assert.equal(now.truncatedAt, 16000);
  assert.equal(now.reasoningTokens, 15700);
  // A filtered response is not reported as cut off even if it used the whole allowance.
  const filtered = call({ status: "failed", maxOutputTokens: 16000, incompleteReason: "content_filter", usage: { output_tokens: 16000 } });
  assert.equal(ctNow(job({ calls: [filtered], recovery }), mergeCalls([filtered], null)).truncatedAt, undefined);
  // The retry in flight shows its own raised allowance.
  const retry = call({ maxOutputTokens: 32000, effort: "medium" });
  assert.equal(ctNow(job({ calls: [cut, retry] }), mergeCalls([cut, retry], null)).maxTokens, 32000);
});

import { traderSummary, toolDoing, sessionProgress } from "../lib/ct-activity.ts";
import { CT_POLICY } from "../lib/ct-spec.ts";
test("the progress view summarises the trader tools and names them while they run", () => {
  assert.equal(traderSummary({}), null);
  const summary = traderSummary({
    labels: { a: { labelId: "a", session: 0, at: "", params: { k: 3, m: 1, horizon: "day_end", costMultiplier: 1 }, events: 40, positiveMoments: 900, eventsPerDay: 0.2 } },
    contrasts: [{ contrastId: "c", labelId: "a", session: 0, at: "", from: 0, to: 1, features: [], topLift: { feature: "range_pct(10, 1m)", bin: "하위 20%", lift: 3.1 }, treeLeaves: 4, summary: "" }],
    charts: [{ chartId: "x", session: 0, n: 1, symbol: "BTCUSDT", at: 1, group: "positive" }],
    blinds: { b: { blindId: "b", session: 0, order: [], graded: { correct: 6, total: 8, accuracyPct: 75, pValue: 0.145 } } },
    diagnoses: [{ diagnosisId: "d", source: "s", session: 0, at: "", features: [], verdict: "청산 문제 의심", losersTouched1RPct: 55, losersNeverProfitablePct: 20 }],
  });
  assert.equal(summary.events, 40);
  assert.equal(summary.topLift.lift, 3.1);
  assert.equal(summary.blindAccuracyPct, 75);
  assert.equal(summary.blindP, 0.145);
  assert.equal(summary.lastDiagnosis.losersTouched1RPct, 55);
  assert.match(toolDoing({ name: "label_moves", input: { params: { k: 3, m: 1, horizon: "day_end" } } }), /거래할 가치/);
  assert.match(toolDoing({ name: "view_charts", input: { request: { anchors: [1, 2], blind: true } } }), /블라인드/);
  assert.match(toolDoing({ name: "diagnose_trades", input: {} }), /손실 원인/);
  const ctWith = { contract: { policy: CT_POLICY }, sessions: [{ index: 0, turns: 3, toolCalls: 5, screens: 1, charts: 4 }], queries: [], tests: { signatures: {} } };
  assert.match(sessionProgress(ctWith), /턴 3\/16 · 도구 5\/40/);
  assert.match(sessionProgress(ctWith), /차트 4\/48/);
  const old = { ...ctWith, contract: { policy: { ...CT_POLICY, traderTools: undefined, sessionMaxTurns: undefined, sessionMaxToolCalls: undefined, sessionMaxCharts: undefined } } };
  assert.match(sessionProgress(old), /턴 3\/12 · 도구 5\/24/);
  assert.doesNotMatch(sessionProgress(old), /차트/);
});

import { sessionThinking } from "../lib/ct-activity.ts";
test("the progress data lists the designer's summarized thinking turn by turn; stage-3 turns (signature only) are reported empty", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "<context>…" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "비용 장벽부터 본다. 이벤트가 하루 몇 건인지 확인한다.", signature: "sig-1" }, { type: "tool_use", id: "t1", name: "label_moves", input: {} }, { type: "tool_use", id: "t2", name: "view_charts", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-2" }, { type: "tool_use", id: "t3", name: "contrast_moves", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "{}" }] },
    { role: "assistant", content: [{ type: "text", text: "끝" }] },
  ];
  const turns = sessionThinking(messages);
  assert.deepEqual(turns.map((t) => t.turn), [1, 2, 3]);
  assert.equal(turns[0].text, "비용 장벽부터 본다. 이벤트가 하루 몇 건인지 확인한다.");
  assert.deepEqual(turns[0].tools, ["label_moves", "view_charts"]);
  assert.deepEqual([turns[1].text, turns[1].blocks], ["", 1], "signature only: nothing to show, and nothing made up");
  assert.deepEqual([turns[2].text, turns[2].blocks, turns[2].tools], ["", 0, []]);
});
