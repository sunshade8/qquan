import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { sessions } from "./helpers/strategy-fixture.mjs";
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
    return sqlite
      .prepare(this.sql)
      .all(...this.values)
      .map((row) => Object.values(row));
  }
}
globalThis.__strategyTestEnv = {
  DB: {
    prepare: (s) => new Statement(s),
    async batch(statements) {
      return Promise.all(statements.map((s) => s.run()));
    },
  },
};
globalThis.__strategyTestHooks = {
  sessions: sessions(260, 5),
  call: () => {
    throw new Error("Unexpected paid call in native 5m development");
  },
};
const empirical = await import("../lib/slot-research-store.ts");
const store = await import("../lib/strategy-generation-store.ts");
const flow = await import("../lib/strategy-generation.ts");
const loader = await import("../lib/relay-data.ts");
await empirical.ensureSearchSchema();
function seed(days, symbol = "NVDA") {
  const insert = sqlite.prepare(
    "INSERT OR REPLACE INTO intraday_bar_days (id,symbol,interval,trading_date,provider,payload) VALUES (?,?,?,?,?,?)",
  );
  for (const d of days)
    insert.run(
      `${symbol}|5m|${d.date}`,
      symbol,
      "5m",
      d.date,
      "Massive",
      JSON.stringify(
        d.bars.NVDA.map((b) => [
          b.time,
          b.open,
          b.high,
          b.low,
          b.close,
          b.volume,
        ]),
      ),
    );
}
const days = sessions(260);
seed(days);
const owner = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const create = () =>
  empirical.createSlotResearch(owner, {
    requestId: crypto.randomUUID(),
    universe: ["NVDA"],
    slots: ["trend"],
    sourceMinutes: 5,
    designMode: "local",
    target: null,
    config: { maxPerSlot: 8 },
  });
test("historical native cache bypasses current provider retention AND missing credentials", async () => {
  const d = {
    ...days[0],
    date: "2020-01-02",
    bars: {
      NVDA: days[0].bars.NVDA.map((b) => ({ ...b, date: "2020-01-02" })),
    },
  };
  seed([d], "OLD");
  sqlite
    .prepare(
      "INSERT INTO intraday_bar_coverage (id,symbol,interval,month,from_date,to_date,complete,fetched_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      "OLD|5m|2020-01",
      "OLD",
      "5m",
      "2020-01",
      "2020-01-01",
      "2020-01-31",
      1,
      0,
    );
  const r = await loader.loadRelaySessions(
    ["OLD"],
    "2020-01-02",
    "2020-01-02",
    0,
    () => {},
    5,
    5,
  );
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sources[0].fetchedMonths, 0);
  assert.equal(r.sources[0].provider, "Massive");
  await assert.rejects(
    () =>
      loader.loadRelaySessions(
        ["OLD"],
        "2020-01-02",
        "2020-01-02",
        0,
        () => {},
        1,
        5,
      ),
    /5분봉/,
  );
  sqlite
    .prepare(
      "UPDATE intraday_bar_days SET provider='unknown' WHERE symbol='OLD'",
    )
    .run();
  await assert.rejects(
    () =>
      loader.loadRelaySessions(
        ["OLD"],
        "2020-01-02",
        "2020-01-02",
        0,
        () => {},
        5,
        5,
      ),
    /출처/,
  );
});
test("durable search, manual stop/resume, bounded calls, and deduplicated replay", async () => {
  let job = await create();
  job = await flow.advanceGeneration(job.id);
  assert.equal(job.search.phase, "search", job.error);
  const dataHash = job.search.manifest.dataHash;
  job = await flow.advanceGeneration(job.id);
  assert.equal(job.search.trials.length, 1);
  await store.pauseGenerationJob(job);
  const paused = await flow.advanceGeneration(job.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.search.trials.length, 1);
  await store.resumeGenerationFailure(await store.getGenerationJob(job.id));
  for (let n = 0; n < 20; n++) {
    job = await flow.advanceGeneration(job.id);
    if (job.status !== "running") break;
  }
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.search.trials.length, 8);
  assert.equal(job.search.backtests, 16);
  assert.equal(job.costUsd, 0);
  assert.equal(job.search.manifest.dataHash, dataHash);
  assert.deepEqual(job.search.final, {});
  const first = job;
  job = await create();
  for (let n = 0; n < 20; n++) {
    job = await flow.advanceGeneration(job.id);
    if (job.status !== "running") break;
  }
  assert.equal(job.search.cacheHits, 8);
  assert.equal(job.search.backtests, 0);
  assert.deepEqual(job.search.trials, first.search.trials);
  assert.equal(job.search.manifest.exposure, "previously_seen");
});
test("data-only failures cannot be called evaluated research completion", async () => {
  const broken = structuredClone(days);
  for (const d of broken) d.bars.NVDA = [];
  seed(broken, "BAD");
  let job = await empirical.createSlotResearch(owner, {
    requestId: crypto.randomUUID(),
    universe: ["BAD"],
    slots: ["trend"],
    sourceMinutes: 5,
    designMode: "local",
    config: { maxPerSlot: 8 },
  });
  for (let n = 0; n < 20; n++) {
    job = await flow.advanceGeneration(job.id);
    if (job.status !== "running") break;
  }
  assert.equal(job.status, "failed", job.error);
  assert.equal(
    job.search.trials.every((t) => t.status === "data_error"),
    true,
  );
  assert.equal(
    job.search.trials.every((t) => !t.development),
    true,
  );
  assert.equal(job.search.backtests, 0);
});
test("compute ceiling ends exploration without consuming holdout or money", async () => {
  let job = await create();
  job = await flow.advanceGeneration(job.id);
  job.search.computeMs = job.search.config.maxComputeMs;
  assert.ok(await store.claimGenerationJob(job.id, "budget-test"));
  await store.saveGenerationJob(job, "budget-test");
  job = await flow.advanceGeneration(job.id);
  assert.equal(job.search.phase, "freeze");
  job = await flow.advanceGeneration(job.id);
  assert.equal(job.status, "failed", job.error);
  assert.match(job.search.endReason, /계산 시간 상한/);
  assert.deepEqual(job.search.final, {});
  assert.equal(job.costUsd, 0);
});

test("independent review reservation preserves the total user budget", async () => {
  let job = await create();
  job = await flow.advanceGeneration(job.id);
  job.search.phase = "review";
  job.budgetUsd = 0.000001; // fixture only: force the real reservation path to deny a call
  assert.ok(await store.claimGenerationJob(job.id, "reserve-test"));
  await store.saveGenerationJob(job, "reserve-test");
  job = await flow.advanceGeneration(job.id);
  assert.equal(job.status, "paused");
  assert.equal(job.pauseReason, "budget");
  assert.equal(job.costUsd, 0);
  assert.equal(job.calls.length, 0);
  assert.deepEqual(job.search.final, {});
  await store.cancelGenerationJob(job);
});

test("program agent designs batches, uses measured failures, and resumes its saved design", async () => {
  for (const row of sqlite.prepare("SELECT payload FROM strategy_generation_runs WHERE status='paused'").all())
    await store.cancelGenerationJob(JSON.parse(row.payload));
  const { FAMILIES, makeCandidate } = await import("../lib/slot-research.ts");
  const prompts = [];
  globalThis.__strategyTestHooks.call = (role, prompt) => {
    assert.equal(role, "designer");
    prompts.push(prompt);
    return { summary: "합성 테스트 응답: 한 번의 설계 호출로 네 계열을 로컬 비교합니다.",
      designs: FAMILIES.map(family => ({ family,
        mechanism: `${family} 계열의 원인과 완성 봉 신호를 시험하는 합성 테스트 가설입니다.`,
        change: prompts.length === 1 ? "학습 자료 기반의 첫 배치 설계" : "실측 실패 진단을 반영해 관측 길이와 진입 기준 수정",
        candidate: { ...makeCandidate(family, 0).candidate, stopPct: prompts.length === 1 ? 0.9 : 1.3 },
      })) };
  };
  let job = await empirical.createSlotResearch(owner, {
    requestId: crypto.randomUUID(), universe: ["NVDA"], slots: ["trend"],
    brief: "사용자 메모를 실제 설계에 반영", sourceMinutes: 5,
  });
  job = await flow.advanceGeneration(job.id);
  assert.equal(job.search.phase, "design");
  assert.equal(job.search.trials.length, 0);
  job = await flow.advanceGeneration(job.id);
  assert.equal(job.search.agent.batches.length, 1);
  assert.match(prompts[0], /사용자 메모를 실제 설계에 반영/);
  await store.pauseGenerationJob(job);
  await store.resumeGenerationFailure(await store.getGenerationJob(job.id));
  job = await store.getGenerationJob(job.id);
  for (let n = 0; n < 40 && job.status === "running"; n++) job = await flow.advanceGeneration(job.id);
  assert.equal(job.status, "completed", job.error);
  assert.equal(prompts.length, 2, "not one LLM call per candidate");
  assert.equal(job.search.agent.batches[1].basedOnTrialIds.length, 8);
  assert.ok(job.search.trials.length >= 10);
  assert.ok(job.search.trials.some(t => t.designHash === job.search.agent.batches[1].outputHash));
  assert.ok(job.search.trials.some(t => t.parentId && t.deltaPct !== null));
  assert.match(prompts[1], /"failure":/);
  assert.match(prompts[1], /"counters":/);
  assert.equal(job.calls.filter(c => c.role === "designer").length, 2);
  assert.equal(job.costUsd, 0.02);
  assert.deepEqual(job.search.final, {});
  assert.equal(job.search.evaluation, "measured");
});

test("unavailable download cannot discard usable historical native rows", async () => {
  const old = days.map((d, index) => {
    const date = new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
    return { date, bars: { NVDA: d.bars.NVDA.map(b => ({ ...b, date })) } };
  });
  seed(old, "HISTORY");
  let job = await empirical.createSlotResearch(owner, {
    requestId: crypto.randomUUID(), universe: ["HISTORY"], slots: ["trend"], designMode: "local", sourceMinutes: 5,
  });
  job = await flow.advanceGeneration(job.id);
  assert.equal(job.search.phase, "search", job.error);
  assert.ok(job.search.manifest.acquisitionWarnings.length > 0);
  assert.equal(job.from, "2020-01-01");
  assert.ok(job.search.manifest.coverage[0].validDates.length > 200);
  job = await flow.advanceGeneration(job.id);
  assert.equal(job.search.trials[0].status, "measured");
  await store.cancelGenerationJob(job);
});
