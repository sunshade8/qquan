import test from "node:test";
import assert from "node:assert/strict";
import { sessions, spec } from "./helpers/strategy-fixture.mjs";
import { runRelay } from "../lib/relay-engine.ts";
import { compileStrategy } from "../lib/strategy-generation-spec.ts";
import {
  boundaries,
  coverageFor,
  SEARCH_DEFAULTS,
  SEARCH_VERSION,
  targetsFor,
  summarize,
  makeCandidate,
  replayDevelopment,
  propose,
  digest,
  configProblems,
} from "../lib/slot-research.ts";
const fixture = sessions(260);
const manifest = {
  ...boundaries(fixture[0].date, fixture.at(-1).date),
  dataHash: "fixture",
  source: "SYNTHETIC TEST ONLY",
  sourceMinutes: 5,
  engine: SEARCH_VERSION,
  symbols: ["NVDA"],
  dates: fixture.map((d) => d.date),
  coverage: [
    coverageFor(
      fixture,
      ["NVDA"],
      "trend",
      5,
      fixture.map((d) => d.date),
    ),
  ],
  costs: {},
  exposure: "unknown",
  exposureRuns: [],
  provenance: ["synthetic"],
  createdAt: "fixed",
};
test("missing/invalid sessions are excluded, never zero-return sessions", () => {
  const bad = structuredClone(fixture.slice(0, 3));
  bad[0].bars.NVDA = bad[0].bars.NVDA.filter((b) => b.time !== "10:05");
  bad[1].bars.NVDA[8].volume = 0;
  const c = coverageFor(
    bad,
    ["NVDA"],
    "trend",
    5,
    bad.map((d) => d.date),
  );
  assert.equal(c.validDates.length, 1);
  assert.equal(c.excluded.length, 2);
});
test("net daily target denominator includes normal sessions without fills", () => {
  const strategy = compileStrategy(spec),
    scan = strategy.scan;
  strategy.scan = (c) => (c.date === fixture[0].date ? scan(c) : null);
  const r = runRelay([strategy], fixture.slice(0, 5), { capitalUsd: 1000 });
  const s = summarize(r, { dailyTargetPct: 1, slots: 5 }, 16);
  assert.equal(s.metrics.sessions, 5);
  assert.equal(s.metrics.tradingDays, 1);
  assert.equal(s.fireRatePct, 20);
  assert.ok(
    Math.abs(s.metrics.meanDailyPct - s.conditionalMeanPct / 5) < 0.0001,
  );
  assert.ok(s.metrics.costPaidUsd > 0);
  assert.equal(
    s.targets[0].reached,
    s.metrics.meanDailyPct >= s.targets[0].targetPct,
  );
  assert.equal(
    targetsFor(null, null).every(
      (t) => t.reached === null && t.gapPct === null,
    ),
    true,
  );
});
test("final outcomes cannot affect development replay or candidate creation", async () => {
  const a = replayDevelopment(
    spec,
    fixture,
    manifest,
    null,
    SEARCH_DEFAULTS,
    1000,
  );
  const poison = structuredClone(fixture);
  for (const d of poison.filter((d) => d.date >= manifest.holdoutFrom))
    for (const b of d.bars.NVDA) b.close = NaN;
  const b = replayDevelopment(
    spec,
    poison,
    manifest,
    null,
    SEARCH_DEFAULTS,
    1000,
  );
  assert.deepEqual(a, b);
  assert.equal(await digest(a), await digest(b));
});
test("diagnosis changes executable conditions, not just hypothesis text", () => {
  const sparse = makeCandidate("breakout", 1, { failure: "no_trades" }),
    cost = makeCandidate("breakout", 1, { failure: "cost_drag" }),
    regime = makeCandidate("breakout", 1, { failure: "regime" });
  assert.notDeepEqual(sparse.candidate.conditions, cost.candidate.conditions);
  assert.equal(cost.candidate.targetPct, null);
  assert.equal(regime.candidate.rankBy, "relativeVolume");
  const a = replayDevelopment(
    { ...spec, candidate: makeCandidate("breakout", 0).candidate },
    fixture,
    manifest,
    null,
    SEARCH_DEFAULTS,
    1000,
  );
  const b = replayDevelopment(
    { ...spec, candidate: sparse.candidate },
    fixture,
    manifest,
    null,
    SEARCH_DEFAULTS,
    1000,
  );
  assert.ok(b.dev.metrics.totalTrades > a.dev.metrics.totalTrades);
  assert.ok(a.counters["condition1:relativeVolume"] > 0);
});
test("minimum allocation visits each family in every slot before extra trials", () => {
  const search = {
    slots: ["open", "trend"],
    trials: [],
    config: SEARCH_DEFAULTS,
  };
  for (let i = 0; i < 16; i++) {
    const p = propose(search);
    assert.ok(p);
    search.trials.push({
      id: String(i),
      slot: p.slot,
      family: p.family,
      failure: "no_edge",
      deltaPct: null,
    });
  }
  for (const slot of search.slots) {
    assert.equal(search.trials.filter((t) => t.slot === slot).length, 8);
    assert.equal(
      new Set(search.trials.filter((t) => t.slot === slot).map((t) => t.family))
        .size,
      4,
    );
  }
  assert.equal(propose(search), null);
  assert.ok(
    configProblems({ ...SEARCH_DEFAULTS, maxBacktests: 20 }, search.slots),
  );
});

test("a running replay observes its deadline before opening another session", () => {
  let starts = 0;
  assert.throws(
    () =>
      replayDevelopment(spec, fixture, manifest, null, SEARCH_DEFAULTS, 1000, {
        deadlineAt: Date.now() - 1,
        onBacktest: () => {
          starts++;
        },
      }),
    /계산 시간 상한/,
  );
  assert.equal(starts, 1);
});

test("agent design inputs cannot read final data or final verdicts", async () => {
  const { designContext, designPrompt } = await import("../lib/slot-research-agent.ts");
  const search = { slots: ["trend"], manifest, config: SEARCH_DEFAULTS, target: null, trials: [], final: {}, selected: {} };
  const job = { search, brief: "USER_BRIEF", universe: ["NVDA"], capitalUsd: 1000 };
  const a = designContext(job, fixture);
  const poisoned = structuredClone(fixture);
  for (const day of poisoned.filter(d => d.date > manifest.trainingTo)) {
    for (const bar of day.bars.NVDA) { bar.close = 987654321; bar.volume = 987654321; }
  }
  job.search.final = { trend: { secret: "FINAL_RESULT_MUST_NOT_LEAK" } };
  job.search.combined = { secret: "COMBINED_MUST_NOT_LEAK" };
  const b = designContext(job, poisoned);
  assert.deepEqual(a, b);
  assert.doesNotMatch(designPrompt(b, true), /FINAL_RESULT_MUST_NOT_LEAK|COMBINED_MUST_NOT_LEAK|987654321/);
});

test("agent batch enforces native interval, family diversity and feasible slot timing", async () => {
  const { validateDesignBatch } = await import("../lib/slot-research-agent.ts");
  const { FAMILIES } = await import("../lib/slot-research.ts");
  const batch = { summary: "This synthetic batch tests executable contract validation only.", designs: FAMILIES.map(family => ({
    family, mechanism: "Distinct family mechanism for this synthetic fixture.", change: "Initial synthetic rule for testing", candidate: makeCandidate(family, 0).candidate,
  })) };
  assert.ok(validateDesignBatch(batch, 5, ["open"]));
  const wrongInterval = structuredClone(batch);
  wrongInterval.designs[0].candidate.barInterval = "1m";
  assert.throws(() => validateDesignBatch(wrongInterval, 5, ["open"]), /주기/);
  const late = structuredClone(batch);
  late.designs[0].candidate.minMinutesAfterOpen = 120;
  assert.throws(() => validateDesignBatch(late, 5, ["open"]), /실행 불가능/);
  const duplicate = structuredClone(batch);
  duplicate.designs[1].family = duplicate.designs[0].family;
  assert.throws(() => validateDesignBatch(duplicate, 5, ["open"]), /네 계열/);
});

test("a local revision inherits the actual agent-authored parent", async () => {
  const { agentCandidate } = await import("../lib/slot-research-agent.ts");
  const seed = { ...makeCandidate("breakout", 0).candidate, minBarDollarVolume: 7654321, stopPct: 2.5 };
  const search = { agent: { mode: "agent", batches: [{ outputHash: "batch-one", designs: [{ family: "breakout", candidate: seed, change: "fixture design" }] }] } };
  const revised = agentCandidate(search, "breakout", 1, { failure: "cost_drag", spec: { candidate: seed } });
  assert.equal(revised.candidate.minBarDollarVolume, 7654321);
  assert.equal(revised.candidate.stopPct, 2.5);
  assert.equal(revised.candidate.targetPct, null);
  assert.equal(revised.designHash, "batch-one");
});

test("full-slot reflection compresses long prose and target scenarios", async () => {
  const { designContext, designPrompt } = await import("../lib/slot-research-agent.ts");
  const { SLOTS, FAMILIES } = await import("../lib/slot-research.ts");
  const result = replayDevelopment(spec, fixture, manifest, null, SEARCH_DEFAULTS, 1000);
  const trials = SLOTS.flatMap(slot => FAMILIES.flatMap(family => [0, 1].map(round => ({
    id: `${slot.id}-${family}-${round}`, slot: slot.id, family, status: "measured",
    spec: { ...spec, candidate: { ...makeCandidate(family, round).candidate, hypothesis: "X".repeat(1600), cautions: Array(8).fill("Y".repeat(500)) } },
    reasons: result.reasons, diagnostics: result.counters, failure: result.failure, train: result.train, development: result.dev,
  }))));
  const job = { brief: "batch", universe: ["NVDA"], capitalUsd: 1000, search: {
    slots: SLOTS.map(s => s.id), config: SEARCH_DEFAULTS, target: null, trials,
    manifest: { ...manifest, coverage: SLOTS.map(s => ({ ...manifest.coverage[0], slot: s.id })) },
  } };
  const prompt = designPrompt(designContext(job, fixture), true);
  assert.ok(prompt.length < 100000, `compressed diagnostics: ${prompt.length} chars`);
  assert.doesNotMatch(prompt, /X{100}|Y{100}/);
  assert.match(prompt, /currentRule/);
  assert.match(prompt, /targetGapRangePct/);
});

test("low-activity revisions relax both floors and ceilings without reversing signs", () => {
  const parent = { failure: "no_trades", spec: { candidate: { ...makeCandidate("compression", 0).candidate,
    conditions: [
      { feature: "rangePct", lookback: 6, operator: "lte", value: 0.3 },
      { feature: "relativeVolume", lookback: 6, operator: "lte", value: 1.2 },
      { feature: "vwapDistancePct", lookback: 6, operator: "gte", value: -0.1 },
    ],
  } } };
  const revised = makeCandidate("compression", 1, parent).candidate;
  assert.ok(revised.conditions[0].value > 0.3);
  assert.ok(revised.conditions[1].value > 1.2);
  assert.ok(revised.conditions[2].value < -0.1);
});
