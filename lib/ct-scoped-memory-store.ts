import { ctDb } from "./ct-data.ts";
import {
  ctAllowedMemory,
  type CTMemoryScope,
  type CTScopedMemory,
} from "./ct-scoped-memory.ts";
import type { CTContract } from "./ct-spec.ts";
import type { GenerationJob } from "./strategy-generation-types.ts";
export const CT_SCOPED_MEMORY_SCHEMA =
  "CREATE TABLE IF NOT EXISTS ct_scoped_memory(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,run_id TEXT NOT NULL,payload TEXT NOT NULL,available_at INTEGER NOT NULL)";
export const ctContractScope = (
  c: CTContract,
  instrument = c.symbols[0],
  minutes = c.minutes,
): CTMemoryScope => ({
  venue: c.market === "stock" ? "toss" : "binance",
  product: c.market === "stock" ? "stock" : "spot",
  instrument,
  direction: "long",
  decisionMinutes: minutes,
  executionMinutes: 1,
  regime: "selected-instrument-chart-v1",
  setupVersion: c.engine,
  riskProfile: "stop-risk-1pct-allocation-25pct-v1",
  costProfile: c.costProfile
    ? `${c.costProfile.id}:${c.costProfile.version}`
    : "unknown",
});
export async function ctScopedMemorySnapshot(owner: string, c: CTContract) {
  await ctDb().prepare(CT_SCOPED_MEMORY_SCHEMA).run();
  const rows = await ctDb()
    .prepare(
      "SELECT payload FROM ct_scoped_memory WHERE owner_id=? AND available_at<=? ORDER BY available_at DESC LIMIT 200",
    )
    .bind(owner, Date.now())
    .all<{ payload: string }>();
  return ctAllowedMemory(
    rows.results.map((r) => JSON.parse(r.payload)),
    {
      owner,
      scope: ctContractScope(c),
      at: Date.now(),
      trainingTo: c.trainingToMs,
    },
  );
}
export async function recordCTScopedMemory(job: GenerationJob) {
  const ct = job.ct;
  if (!ct || (ct.contract.policy.traderTools ?? 0) < 7) return;
  const c = ct.contract,
    now = Date.now();
  await ctDb().prepare(CT_SCOPED_MEMORY_SCHEMA).run();
  const items = [
    ...(ct.screened ?? []).map((t) => ({
      id: t.id,
      spec: t.candidate.spec,
      grade: "rejected_in_scope" as const,
      conclusion: t.reasons.join(" · "),
      evidence: {
        trades: t.training.tradeCount ?? t.training.trades.length,
        netPct: t.training.netReturnPct,
      },
    })),
    ...ct.trials.map((t) => ({
      id: t.id,
      spec: t.spec,
      grade: "validating" as const,
      conclusion: t.hypothesis.mechanism,
      evidence: {
        trades: t.training.tradeCount ?? t.training.trades.length,
        netPct: t.training.netReturnPct,
      },
    })),
  ];
  for (const item of items) {
    const memory: CTScopedMemory = {
      id: `${job.id}:${item.id}`,
      owner: job.ownerId,
      scope: ctContractScope(c, item.spec.symbols[0], item.spec.minutes),
      observedAt: c.trainingToMs,
      recordedAt: now,
      availableAt: now,
      from: c.fromMs,
      to: c.trainingToMs,
      split: "training",
      grade: item.grade,
      conclusion: item.conclusion,
      trainingEvidence: item.evidence,
    };
    await ctDb()
      .prepare("INSERT OR IGNORE INTO ct_scoped_memory VALUES (?,?,?,?,?)")
      .bind(memory.id, job.ownerId, job.id, JSON.stringify(memory), now)
      .run();
  }
}
