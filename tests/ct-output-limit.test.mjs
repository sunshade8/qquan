import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { ctState, bars } from "./helpers/ct-fixture.mjs";
import { ctHash } from "../lib/ct-spec.ts";
import { researchCallLimits, researchMaxTokens, GENERATION_MODELS, CT_DESIGNER_RETRY_MAX_TOKENS } from "../lib/strategy-generation-models.ts";
import { IncompleteResponseError } from "../lib/llm-error.ts";
import { researchFailure } from "../lib/research-recovery.ts";
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
globalThis.__strategyTestHooks = { realLlm: true, call: () => { throw new Error("unexpected fake call"); } };
const research = await import("../lib/ct-research-store.ts");
const store = await import("../lib/strategy-generation-store.ts");
const flow = await import("../lib/strategy-generation.ts");
await research.ensureCTSchema();

// Never reaches the network: every OpenAI request gets an incomplete stream that used its whole allowance.
const originalFetch = globalThis.fetch;
let requests = [];
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /\/responses$/);
  const body = JSON.parse(options.body);
  requests.push(body);
  const max = body.max_output_tokens;
  const response = { id: "resp_cut", object: "response", created_at: 1, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, model: body.model, output: [],
    usage: { input_tokens: 9476, output_tokens: max, total_tokens: 9476 + max, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: max - 300 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", incomplete_details: null, usage: null } },
    { type: "response.incomplete", response },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
  return new Response(new ReadableStream({ start(c) {
    for (const e of events) c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    c.close();
  } }), { headers: { "content-type": "text/event-stream" } });
};
test.after(() => { globalThis.fetch = originalFetch; });

let sequence = 0;
async function designJob(budgetUsd = 8) {
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled' WHERE status='running'");
  const ct = ctState();
  ct.phase = "design";
  const data = bars(864);
  ct.dataHash = await ctHash({ "KRW-BTC": data });
  const now = new Date().toISOString();
  const j = { id: "ct-limit-" + ++sequence, ownerId: "owner", slot: "open", status: "running", stageIndex: 0, createdAt: now, updatedAt: now,
    from: "2025-01-01", to: "2025-01-04", capitalUsd: 1e6, budgetUsd, costUsd: 0, events: [], calls: [], universe: ["KRW-BTC"], ct };
  await store.createGenerationJob(j);
  sqlite.prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)").run(j.id, "KRW-BTC", ct.contract.toMs, JSON.stringify(data));
  return j;
}

test("CT designer truncation retries once with a larger allowance and less reasoning, then pauses", async () => {
  requests = [];
  const created = await designJob();
  let job = await flow.advanceGeneration(created.id);
  // (a) Not the transient path: no 10s wait, no transient failure counted, the cause is stated.
  assert.equal(job.status, "running", job.error);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].max_output_tokens, 16000);
  assert.equal(requests[0].reasoning.effort, "high");
  assert.equal(job.recovery.failures, 0);
  assert.ok(Date.parse(job.recovery.retryAt) <= Date.now());
  assert.match(job.error, /^출력 한도 16,000토큰 초과 · 출력 16,000토큰 중 추론 15,700토큰/);
  assert.equal(job.nextAction, "출력 한도 16,000토큰 초과 · 한도 32,000토큰 · 추론 medium 설정으로 1회 재시도. 기존 후보와 검증 기록은 유지됩니다.");
  assert.doesNotMatch(job.nextAction, /같은 단계 자동 재시도/);
  const first = job.calls.at(-1);
  assert.equal(first.status, "failed");
  assert.equal(first.incompleteReason, "max_output_tokens");
  assert.equal(first.reasoningTokens, 15700);
  assert.equal(first.maxOutputTokens, 16000);
  assert.equal(first.effort, "high");
  assert.equal(first.estimated, false);

  // (b) The single retry changes the conditions.
  job = await flow.advanceGeneration(created.id);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].max_output_tokens, CT_DESIGNER_RETRY_MAX_TOKENS);
  assert.equal(requests[1].reasoning.effort, "medium");
  assert.equal(requests[1].input, requests[0].input, "same prompt, different limits");
  const second = job.calls.at(-1);
  assert.equal(second.maxOutputTokens, 32000);
  assert.equal(second.effort, "medium");
  assert.equal(second.incompleteReason, "max_output_tokens");

  // (c) Truncated twice: paused, no scheduled retry, nextAction names the cause.
  assert.equal(job.status, "paused");
  assert.equal(job.pauseReason, "interrupted");
  assert.equal(job.recovery.retryAt, undefined);
  assert.match(job.error, /^출력 한도 32,000토큰 초과 · 출력 32,000토큰 중 추론 31,700토큰/);
  assert.match(job.nextAction, /출력 한도 32,000토큰 초과가 조건을 바꾼 재시도에서도 반복되어 자동 재시도를 멈췄습니다 \(출력 32,000토큰 중 추론 31,700토큰\)/);
  job = await flow.advanceGeneration(created.id);
  assert.equal(job.status, "paused");
  assert.equal(requests.length, 2, "no further paid call after the second truncation");

  // (d) Actual spend and every reservation stay inside the CT design ceiling of the $8 budget.
  const price = GENERATION_MODELS.designer;
  const spent = (9476 * price.input + 16000 * price.output + 9476 * price.input + 32000 * price.output) / 1e6;
  assert.ok(Math.abs(job.costUsd - spent) < 1e-9, `${job.costUsd} vs ${spent}`);
  assert.ok(second.reserveUsd >= 32000 * price.output / 1e6);
  assert.ok(second.reserveUsd - first.reserveUsd >= 16000 * price.output / 1e6 - 1e-12);
  for (const call of job.calls) assert.ok(call.costUsd <= call.reserveUsd);
  assert.ok(job.costUsd <= 8 * (1 - job.ct.contract.policy.reserveFraction));
});

test("CT truncation retry is refused before any request when its larger reserve exceeds the budget", async () => {
  requests = [];
  const created = await designJob();
  let job = await flow.advanceGeneration(created.id);
  assert.equal(requests.length, 1);
  const first = job.calls.at(-1);
  // Room for another 16k call but not for the 32k retry reserve.
  const budget = (job.costUsd + first.reserveUsd + 0.08) / (1 - job.ct.contract.policy.reserveFraction);
  sqlite.prepare("UPDATE strategy_generation_runs SET payload=json_set(payload,'$.budgetUsd',?) WHERE id=?").run(budget, created.id);
  job = await flow.advanceGeneration(created.id);
  assert.equal(requests.length, 1, "no request beyond the budget");
  assert.equal(job.status, "completed");
  assert.match(job.ct.endReason, /연구 한도 종료 · 통과 전략 없음 · 연구 예산/);
});

test("CT roles with nothing left to lower pause on the first truncation; others keep their allowance", () => {
  // dataAnalyst already reasons at "low" with its fixed allowance: a retry would be identical.
  assert.deepEqual(researchCallLimits("dataAnalyst", { ct: true, truncated: true }), researchCallLimits("dataAnalyst"));
  for (const role of ["orchestrator", "riskReviewer", "evidenceReviewer"]) {
    const retry = researchCallLimits(role, { ct: true, truncated: true });
    assert.equal(retry.maxOutputTokens, researchMaxTokens(role), role);
    assert.equal(retry.effort, "medium", role);
  }
});

test("slot and legacy research keep their limits and the transient classification", () => {
  for (const role of Object.keys(GENERATION_MODELS)) {
    const base = researchCallLimits(role);
    assert.equal(base.maxOutputTokens, researchMaxTokens(role));
    assert.deepEqual(researchCallLimits(role, { ct: false, truncated: true }), base, role);
  }
  const error = new IncompleteResponseError("OpenAI", { reason: "max_output_tokens", maxOutputTokens: 16000, outputTokens: 16000, reasoningTokens: 15000, effort: "high" });
  assert.equal(error.status, 502);
  assert.equal(researchFailure(error).transient, true);
});
