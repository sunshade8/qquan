import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
register("./helpers/strategy-test-loader.mjs", import.meta.url);

const sqlite = new DatabaseSync(":memory:");
/** Like D1, refuses more than 100 bound parameters — local SQLite alone would accept 32,766. */
const D1_MAX_PARAMS = 100;
class Statement {
  constructor(sql, values = []) {
    if (values.length > D1_MAX_PARAMS) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`);
    this.sql = sql; this.values = values;
  }
  bind(...values) { return new Statement(this.sql, values); }
  _run() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  async run() { return this._run(); }
  async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
  async raw() { return sqlite.prepare(this.sql).all(...this.values).map((row) => Object.values(row)); }
}
globalThis.__strategyTestEnv = {
  MASSIVE_API_KEY: "test-key",
  DB: {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const result = statements.map((s) => s._run()); sqlite.exec("COMMIT"); return result; }
      catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
  },
};
globalThis.__strategyTestHooks = { sessions: [], call: async () => { throw new Error("no model call expected"); } };

const store = await import("../lib/surge-store.ts");
const { ClaudeApiError } = await import("../lib/llm-error.ts");
const day = (n) => new Date(Date.UTC(2025, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
const workflow = await import("../lib/surge-generation.ts");

test("an interrupted data stage resumes instead of failing the run", async () => {
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return Response.json({ results: [{ T: "AAA", o: 10, h: 11, l: 9.5, c: 10.5, v: 2_000_000 }] });
  };
  try {
    const now = new Date().toISOString();
    const job = {
      researchVersion: 3,
      id: crypto.randomUUID(), ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", pool: "gainers", status: "running",
      stageIndex: 0, createdAt: now, updatedAt: now, from: "2025-11-24", to: "2025-11-24", capitalUsd: 1000, brief: "",
      costUsd: 0, budgetUsd: 8, error: null, attempt: 1, attempts: [], splitsLoaded: true, splitEvents: 0,
      marketTasks: ["2025-11-24"], marketCursor: 0, barTasks: [], barCursor: 0, barFailures: [],
      // The dev server died after this was written and before the matching `done`.
      events: [{ at: now, stage: "market", state: "started", detail: "전 종목 일별 시세", role: null }],
    };
    await store.createSurgeJob(job);

    const resumed = await workflow.advanceSurgeGeneration(job.id);
    assert.equal(resumed.status, "running", resumed.error ?? "");
    assert.equal(resumed.marketCursor, 1);
    assert.equal(resumed.interruptions.market, 1);
    assert.ok(requested.some((url) => url.includes("/grouped/locale/us/market/stocks/2025-11-24")));
    // The interruption stays on record; per-chunk started/done pairs collapse to the latest.
    assert.deepEqual(resumed.events.map((event) => event.state), ["error", "done"]);
    assert.match(resumed.events[0].detail, /저장된 지점에서 재개/);
    assert.match(resumed.events[1].detail, /^일별 시세 1\/1일/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("data stages always resume; a paid model stage is retried once, then stops", () => {
  const policy = workflow.interruptedStagePolicy;
  for (const stage of ["market", "bars", "training", "validation", "publish"]) {
    assert.equal(policy(stage, { interruptions: { [stage]: 9 } }), "resume", stage);
  }
  assert.equal(policy("design", {}), "retry");
  assert.equal(policy("design", { interruptions: { design: 1 } }), "fail");
  assert.equal(policy("evidence_review", { interruptions: { design: 1 } }), "retry");
});

const SESSIONS = 130;
const dates = Array.from({ length: SESSIONS }, (_, n) => day(n));

test("six months of same-day events load without exceeding D1's 100-parameter limit", async () => {
  await store.createSurgeJob({
    id: crypto.randomUUID(), ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", pool: "losers", status: "cancelled",
    stageIndex: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), from: "2025-01-01", to: "2025-12-31",
    capitalUsd: 1000, brief: "", costUsd: 0, budgetUsd: 8, error: null, events: [],
  }); // runs ensureSchema
  for (const date of dates) {
    // Fifty envelope names a day — more than one IN-list chunk — of which the first three crash in the session.
    const seeds = Array.from({ length: 50 }, (_, index) => ({ symbol: `S${date.replace(/-/g, "")}${index}`, rank: 0, changePct: 0, prevClose: 10, priorDollarVolume: 9e6, dollarVolume: 0, volume: 0, rankedOn: date }));
    sqlite.prepare("INSERT INTO surge_rank_days (id,ranked_on,pool,payload,created_at,basis) VALUES (?,?,?,?,?,'raw-events-v2')")
      .run(`losers|${date}`, date, "losers", JSON.stringify(seeds), Date.now());
    for (const [index, seed] of seeds.entries()) {
      const crash = index < 3;
      const minutes = [["09:30", 10, 10, 9.8, 9.9, 20_000], ["09:31", 9.9, 9.9, crash ? 8.7 : 9.8, crash ? 8.8 : 9.85, 150_000], crash ? ["09:32", 8.8, 9, 8.7, 8.9, 1_000] : ["09:32", 9.85, 9.9, 9.8, 9.85, 1_000]];
      sqlite.prepare("INSERT INTO intraday_bar_days (id,symbol,interval,trading_date,payload,provider) VALUES (?,?,?,?,?,?)")
        .run(`${seed.symbol}|1m-raw|${date}`, seed.symbol, "1m-raw", date, JSON.stringify(minutes), "Massive/raw");
    }
  }
  const sessions = await store.loadIntradaySurgeSessions("losers", dates, "1m");
  assert.equal(sessions.length, SESSIONS);
  assert.deepEqual([...new Set(sessions.map((session) => session.candidates.length))], [3], "only names whose minutes meet the event definition");
  assert.ok(sessions.every((session) => session.candidates.every((event) => event.observedAt === "09:32" && event.changePct === -12)));
  assert.ok(sessions.every((session) => Object.keys(session.bars).length === 3));
});

test("a provider rate limit waits and retries the stage instead of failing the run", async () => {
  sqlite.exec("UPDATE surge_generation_runs SET status='cancelled' WHERE status='running'");
  const now = new Date().toISOString();
  const job = {
    researchVersion: 3,
    id: crypto.randomUUID(), ownerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", pool: "losers", status: "running",
    stageIndex: 2, createdAt: now, updatedAt: now, from: dates[0], to: dates.at(-1), capitalUsd: 1000, brief: "",
    costUsd: 0, budgetUsd: 8, error: null, attempt: 1, attempts: [], events: [], sessionDates: dates, marketSessions: SESSIONS,
  };
  await store.createSurgeJob(job);
  let calls = 0;
  globalThis.__strategyTestHooks.call = async () => { calls += 1; throw new ClaudeApiError("OpenAI 호출 한도를 잠시 초과했습니다.", 429); };
  const expire = () => sqlite.prepare("UPDATE surge_generation_runs SET payload=json_remove(payload,'$.retryAt') WHERE id=?").run(job.id);

  let after = await workflow.advanceSurgeGeneration(job.id);
  assert.equal(after.status, "running");
  assert.equal(after.stageIndex, 2);
  assert.equal(after.transientRetries.plan, 1);
  assert.ok(Date.parse(after.retryAt) > Date.now());
  assert.match(after.events.at(-1).detail, /60초 후 같은 단계 재시도 \(1\/3\)/);

  // Inside the wait, an advance does nothing — no model call, no event.
  after = await workflow.advanceSurgeGeneration(job.id);
  assert.equal(calls, 1);

  for (const expected of [2, 3]) {
    expire();
    after = await workflow.advanceSurgeGeneration(job.id);
    assert.equal(after.status, "running");
    assert.equal(after.transientRetries.plan, expected);
  }
  expire();
  after = await workflow.advanceSurgeGeneration(job.id);
  assert.equal(after.status, "failed");
  assert.equal(calls, 4);
});

test("spend above the old cap reaches the provider, and an exhausted provider balance pauses the run where it is, and resuming continues the same stage", async () => {
  sqlite.exec("UPDATE surge_generation_runs SET status='cancelled' WHERE status='running'");
  const now = new Date().toISOString();
  const job = {
    researchVersion: 3,
    id: crypto.randomUUID(), ownerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", pool: "losers", status: "running",
    stageIndex: 2, createdAt: now, updatedAt: now, from: dates[0], to: dates.at(-1), capitalUsd: 1000, brief: "",
    costUsd: 100, budgetUsd: 8, error: null, attempt: 1, attempts: [], events: [], sessionDates: dates, marketSessions: SESSIONS,
  };
  await store.createSurgeJob(job);
  let calls = 0;
  globalThis.__strategyTestHooks.call = async () => { calls += 1; throw new ClaudeApiError("OpenAI 크레딧이 소진되었습니다.", 402); };

  const paused = await workflow.advanceSurgeGeneration(job.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseReason, "provider");
  assert.equal(paused.stageIndex, 2);
  assert.equal(paused.budgetUsd, 8);
  assert.equal(paused.costUsd, 100);
  assert.equal(calls, 1, "no retries against an empty balance");

  await store.resumeSurgeGeneration(await store.getSurgeJob(job.id));
  const resumed = await store.getSurgeJob(job.id);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.stageIndex, 2);
  assert.equal(resumed.budgetUsd, undefined, "resuming removes the obsolete spend cap");
});

test("operational activity is durable while a model is pending and cannot overwrite cancellation", async () => {
  sqlite.exec("UPDATE surge_generation_runs SET status='cancelled' WHERE status='running'");
  const now = new Date().toISOString();
  const job = {
    researchVersion: 3,
    id: crypto.randomUUID(), ownerId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", pool: "losers", status: "running",
    stageIndex: 2, createdAt: now, updatedAt: now, from: dates[0], to: dates.at(-1), capitalUsd: 1000,
    brief: "", costUsd: 0, budgetUsd: 8, error: null, events: [], attempt: 2, sessionDates: dates,
  };
  await store.createSurgeJob(job);
  const streamed = [];
  globalThis.__strategyTestHooks.call = async () => {
    const pending = await store.getSurgeJob(job.id);
    assert.match(pending.activities.at(-1).detail, /요청 전송 · 응답 대기/);
    assert.equal(pending.activities.at(-1).kind, "update");
    assert.ok(pending.activities.every((entry) => entry.attempt === 2 && entry.stage === "plan"));
    await store.cancelSurgeJob(pending);
    throw new ClaudeApiError("cancelled in test", 429);
  };
  const result = await workflow.advanceSurgeGeneration(job.id, (_, activity) => { if (activity) streamed.push(activity); });
  assert.ok(streamed.some((entry) => /세션 로드 완료/.test(entry.detail)));
  assert.equal(result.status, "cancelled");
  assert.equal(result.activities.at(-1).kind, "update", "late retry telemetry must not overwrite cancelled snapshot");
  assert.equal(new Set(streamed.map((entry) => entry.id)).size, streamed.length);
});


test("a legacy budget pause resumes without a top-up and retains measured spend", async () => {
  sqlite.exec("UPDATE surge_generation_runs SET status='cancelled' WHERE status='running'");
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(), ownerId: "ffffffff-ffff-4fff-8fff-ffffffffffff", pool: "gainers",
    status: "paused", pauseReason: "budget", stageIndex: 4, createdAt: now, updatedAt: now,
    from: day(1), to: day(251), capitalUsd: 1000, brief: "", costUsd: 7.8, budgetUsd: 8,
    error: "old budget cap", nextAction: "add budget", events: [],
  };
  await store.createSurgeJob(job);
  await store.resumeSurgeGeneration(await store.getSurgeJob(job.id));
  const resumed = await store.getSurgeJob(job.id);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.stageIndex, 4);
  assert.equal(resumed.costUsd, 7.8);
  assert.equal(resumed.budgetUsd, undefined);
  assert.equal(resumed.pauseReason, undefined);
  assert.equal(resumed.nextAction, undefined);
  assert.match(resumed.events.at(-1).detail, /예산 제한 없이/);
});
