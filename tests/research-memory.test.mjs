import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { researchJournal, selectResearchMemory } from "../lib/research-memory.ts";
import { validateDesignBatch, designContext } from "../lib/slot-research-agent.ts";
import { FAMILIES, makeCandidate, SEARCH_VERSION } from "../lib/slot-research.ts";
import { writeJournal } from "../scripts/research/journal.mjs";

const part = { from: "2025-01-01", to: "2025-06-30", metrics: { sessions: 100, totalTrades: 15,
  meanDailyPct: -0.02, maxDrawdownPct: 3, costPaidUsd: 20 }, grossPnlUsd: 5,
  fireRatePct: 15, halves: [-0.01, -0.03], topProfitShare: 0.4, selectionLowerPct: -0.04, targets: [] };
function job(id = "prior") {
  return { id, ownerId: "owner", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z",
    status: "completed", from: "2024-01-01", to: "2025-12-31", universe: ["QQQ", "SPY"],
    capitalUsd: 1000, costUsd: 0.2, brief: "test", calls: [{ secret: "PRIVATE_CALL_SENTINEL" }],
    search: { phase: "done", slots: ["trend"], config: {}, target: null, agent: { batches: [] },
      manifest: { from: "2024-01-01", trainingTo: "2024-12-31", developmentTo: "2025-06-30",
        holdoutFrom: "2025-07-01", dataHash: "data", source: "Massive", sourceMinutes: 5,
        engine: SEARCH_VERSION, symbols: ["QQQ", "SPY"], costs: { fee: 0.1 },
        coverage: [{ slot: "trend", validDates: [], excluded: [] }] },
      trials: FAMILIES.map((family, i) => ({ id: `trial-${i}`, hash: `hash-${i}`, artifact: `hash-${i}`,
        slot: "trend", family, spec: { candidate: makeCandidate(family, 0).candidate, universe: ["QQQ", "SPY"] },
        status: "measured", failure: "cost_drag", reasons: ["cost exceeds gross gains"], change: "seed", deltaPct: null,
        train: part, development: part, diagnostics: { volume: 8 } })),
      final: { trend: { secret: "FINAL_SENTINEL", passed: true } }, combined: { secret: "COMBINED_SENTINEL" },
    } };
}
function current() { const j = job("current"); j.createdAt = "2026-01-02T00:00:00Z"; return j; }

test("memory preserves measured losses and their rules without final results, model calls or owner IDs", () => {
  const memory = selectResearchMemory(current(), [job()]);
  assert.equal(memory.records.length, 4);
  assert.equal(memory.records[0].development.meanDailyPct, -0.02);
  assert.match(memory.records[0].lesson, /비용/);
  const encoded = JSON.stringify(memory);
  for (const forbidden of ["FINAL_SENTINEL", "COMBINED_SENTINEL", "PRIVATE_CALL_SENTINEL", "ownerId"])
    assert.ok(!encoded.includes(forbidden));
  const j = current(); j.search.memory = memory;
  const context = designContext(j, []);
  assert.equal(context.priorExperiments[0].id, "prior/trial-0");
});

test("owner, temporal boundary, engine, costs and capital are enforced before retrieval", () => {
  for (const modify of [j => j.ownerId = "someone-else", j => j.updatedAt = "2026-02-01T00:00:00Z",
    j => j.search.manifest.developmentTo = "2025-07-01", j => j.search.manifest.engine = "another-engine",
    j => j.search.manifest.costs.fee = 0, j => j.capitalUsd = 10000,
    j => j.universe = ["NVDA"], j => j.search.trials.forEach(t => t.development = { ...part, to: "2025-12-31" })]) {
    const prior = job(); modify(prior);
    assert.equal(selectResearchMemory(current(), [prior]).records.length, 0);
  }
});

test("cached reruns do not create independent observations; retrieval is bounded and diverse", () => {
  const originals = Array.from({ length: 20 }, (_, i) => { const j = job(`run-${i}`); j.search.trials.forEach(t => t.hash += `-${i}`); return j; });
  const memory = selectResearchMemory(current(), [...originals, ...originals]);
  assert.equal(memory.records.length, 24);
  assert.equal(memory.eligibleExperiments, 80);
  assert.equal(memory.duplicateExperiments, 80);
  assert.deepEqual(new Set(memory.records.map(r => r.family)), new Set(FAMILIES));
});

test("infrastructure failures remain unmeasured and cannot teach a fake zero-return strategy", () => {
  const prior = job();
  prior.search.trials = [{ ...prior.search.trials[0], status: "data_error", failure: "execution", train: undefined, development: undefined }];
  const record = selectResearchMemory(current(), [prior]).records[0];
  assert.equal(record.development, null);
  assert.match(record.lesson, /미측정/);
});

test("agent must cite available evidence and explain the change or deliberate retest", () => {
  const batch = { summary: "This is a synthetic design for memory contract testing.", designs: FAMILIES.map(family => ({
    family, mechanism: "Test the specific causal mechanism using completed candles.", change: "Change one condition using prior evidence.",
    candidate: makeCandidate(family, 0).candidate,
  })) };
  assert.throws(() => validateDesignBatch(batch, 5, ["trend"], ["prior/trial-0"]), /근거/);
  batch.memoryUse = [{ experimentId: "invented", action: "change", reason: "The previous rule lost money after costs." }];
  assert.throws(() => validateDesignBatch(batch, 5, ["trend"], ["prior/trial-0"]), /제공되지/);
  batch.memoryUse[0].experimentId = "prior/trial-0";
  assert.equal(validateDesignBatch(batch, 5, ["trend"], ["prior/trial-0"]).memoryUse.length, 1);
  const records = selectResearchMemory(current(), [job()]).records.slice(0, 1);
  assert.throws(() => validateDesignBatch(batch, 5, ["trend"], ["prior/trial-0"], records), /동일 재시험/);
  batch.memoryUse[0].action = "retest";
  assert.ok(validateDesignBatch(batch, 5, ["trend"], ["prior/trial-0"], records));
});

test("local journal is idempotent, preserves changed snapshots and separates final results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qquan-journal-"));
  try {
    const j = job(); const journal = researchJournal(j);
    assert.ok(!JSON.stringify(journal).includes("PRIVATE_CALL_SENTINEL"));
    assert.ok(!JSON.stringify(journal).includes("ownerId"));
    const path = await writeJournal(journal, directory);
    await writeJournal(journal, directory);
    assert.equal((await readdir(join(path, "snapshots"))).length, 1);
    const lines = (await readFile(join(path, "experiments.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 4);
    assert.ok(!lines.join("").includes("FINAL_SENTINEL"));
    journal.updatedAt = "2026-01-03T00:00:00Z"; journal.status = "paused";
    await writeJournal(journal, directory);
    await writeJournal(researchJournal(j), directory);
    assert.equal((await readdir(join(path, "snapshots"))).length, 2);
    assert.equal(JSON.parse(await readFile(join(path, "run.json"), "utf8")).status, "paused");
    await assert.rejects(() => writeJournal({ ...journal, id: "../escape" }, directory), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
