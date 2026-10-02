/** Recompute stored market experiments without using the experiment result cache. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { replayDevelopment, digest, SEARCH_VERSION, costSnapshot } from "../../lib/slot-research.ts";
const file = process.argv[2] ?? "outputs/slot-research/repeated/run.json";
const job = JSON.parse(readFileSync(file, "utf8")),
  dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const paths = readdirSync(dir).filter(
  (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite",
);
if (paths.length !== 1 && !process.env.MARKET_DATA_DB)
  throw new Error("Set MARKET_DATA_DB");
const db = new DatabaseSync(
  process.env.MARKET_DATA_DB ?? `${dir}/${paths[0]}`,
  { readOnly: true },
);
const sessions = db
  .prepare(
    "SELECT payload FROM strategy_generation_data WHERE run_id=? ORDER BY part",
  )
  .all(`${job.id}:empirical`)
  .flatMap((row) => JSON.parse(row.payload).sessions)
  .map((d) => {
    const bars = Object.fromEntries(
      Object.entries(d.bars).map(([symbol, rows]) => [
        symbol,
        rows.map(([time, open, high, low, close, volume]) => ({
          date: d.date,
          time,
          open,
          high,
          low,
          close,
          volume,
        })),
      ]),
    );
    return { date: d.date, bars, barsByStep: { [d.step]: bars } };
  })
  .sort((a, b) => a.date.localeCompare(b.date));
assert.equal(await digest(sessions), job.search.manifest.dataHash);
assert.equal(SEARCH_VERSION, job.search.manifest.engine, "frozen engine version");
assert.deepEqual(costSnapshot(job.universe), job.search.manifest.costs, "frozen costs");
// D1 stores JSON: JavaScript's signed -0 is serialized as 0. Compare the exact
// persistence representation, with no numerical tolerance or rounding added.
const persisted = value => JSON.parse(JSON.stringify(value));
const compact = result => persisted({ ...result, days: result.days.map(day => ({ ...day, slots: day.slots.filter(s => s.strategyId) })) });
const started = Date.now();
let verified = 0;
for (const trial of job.search.trials) {
  const r = replayDevelopment(
    trial.spec,
    sessions,
    job.search.manifest,
    job.search.target,
    job.search.config,
    job.capitalUsd,
  );
  assert.deepEqual(persisted(r.train), trial.train, `${trial.id} training`);
  assert.deepEqual(persisted(r.dev), trial.development, `${trial.id} development`);
  assert.deepEqual(r.counters, trial.diagnostics, `${trial.id} diagnostics`);
  const artifact = JSON.parse(db.prepare("SELECT payload FROM slot_research_artifacts WHERE hash=?").get(trial.artifact).payload);
  assert.deepEqual(compact(r.training), artifact.detail.training, `${trial.id} daily training ledger`);
  assert.deepEqual(compact(r.development), artifact.detail.development, `${trial.id} daily development ledger`);
  verified++;
}
const report = {
  dataHash: job.search.manifest.dataHash,
  candidates: verified,
  uncachedBacktests: verified * 2,
  equal: true,
  equality: "exact persisted JSON including daily equity and trade ledger; JSON normalizes signed zero",
  elapsedMs: Date.now() - started,
  source: "actual stored market snapshots; no synthetic data or LLM fixture",
};
const output = process.argv[3] ?? "outputs/slot-research/reproducibility.json";
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(report, null, 2),
);
console.log(report);
