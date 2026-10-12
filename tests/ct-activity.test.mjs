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
  assert.equal(now.agent, "designer");
  assert.equal(now.truncatedAt, 16000);
  // Retry was due at 22:45:03; 45s of grace, then nobody advanced it.
  assert.equal(stalledFor(now, Date.parse("2026-10-12T22:45:30.000Z")), 0);
  assert.ok(stalledFor(now, Date.parse("2026-10-12T22:52:11.000Z")) > 7 * 60_000);
  const designer = ctAgents(j, merged, now).find((a) => a.id === "designer");
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
  assert.deepEqual([between.kind, between.agent], ["between", "orchestrator"]);
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
