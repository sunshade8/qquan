/** Times the CT designer's training-only tools on the baseline run's frozen BTCUSDT contract. No model, no orders. */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
register("../../tests/helpers/slot-test-loader.mjs", import.meta.url);
globalThis.__strategyTestEnv = {};
const { loadCTData } = await import("../../lib/ct-data.ts");
const { ctCostHurdle, ctQueryReturns } = await import("../../lib/ct-design-tools.ts");
process.env.QQUAN_DENY_MARKET_NETWORK = "1";
const db = new DatabaseSync(`${process.env.QQUAN_DATA_DIR ?? homedir() + "/.qquan"}/state/research.sqlite`, { readOnly: true });
const id = process.argv[2] ?? "9a3c8627-1564-4176-83fd-844f23c030d7";
const contract = JSON.parse(db.prepare("SELECT json_extract(payload,'$.ct.contract') c FROM strategy_generation_runs WHERE id=?").get(id).c);
let t = Date.now();
const data = await loadCTData(id, contract);
console.log("load", Date.now() - t, "ms", Object.values(data)[0].length, "bars");
t = Date.now();
const hurdle = ctCostHurdle(data, contract);
console.log("hurdle", Date.now() - t, "ms", JSON.stringify(hurdle).length, "chars");
console.log(hurdle.conclusion);
console.log(JSON.stringify(hurdle.horizons.map((h) => [h.bars, h.mfePct.p50, h.hit1xPct, h.hit2xPct, h.hit3xPct])));
for (const q of [
  { stages: [{ maxGapBars: 1, conditions: [{ feature: "return_pct", lookback: 30, offset: 0, timeframe: 1, op: "lte", value: -1 }] }], horizons: [15, 60, 240], grid: { stopPcts: [0.5, 1, 2], targetPcts: [0.6, 1, 2, 3] }, cooldownBars: 30 },
  { stages: [{ maxGapBars: 1, conditions: [{ feature: "contraction_ratio", lookback: 24, offset: 0, timeframe: 3, op: "lte", value: 0.6 }, { feature: "range_pct", lookback: 60, offset: 0, timeframe: 1, op: "lte", value: 0.5 }] }, { maxGapBars: 12, conditions: [{ feature: "prior_high_distance_pct", lookback: 60, offset: 0, timeframe: 1, op: "gte", value: 0.05 }, { feature: "volume_ratio", lookback: 30, offset: 0, timeframe: 1, op: "gte", value: 3 }] }], horizons: [30, 120, 390], grid: { stopPcts: [0.5, 1], targetPcts: [1, 2] }, cooldownBars: 60 },
]) {
  t = Date.now();
  const r = ctQueryReturns(q, data, contract);
  console.log("query", Date.now() - t, "ms", JSON.stringify(r).length, "chars", r.events, "events", JSON.stringify(r.horizons.map((h) => [h.bars, h.netMeanPct, h.vsBaselinePct])));
}
const { ctSessionContext, CT_DESIGNER_SYSTEM } = await import("../../lib/ct-research.ts");
const { CT_SESSION_TOOLS } = await import("../../lib/ct-research-store.ts");
const ct = JSON.parse(db.prepare("SELECT json_extract(payload,'$.ct') c FROM strategy_generation_runs WHERE id=?").get(id).c);
const memory = ct.trials.map((t) => ({ id: t.id, market: "crypto", dataHash: ct.dataHash, developmentToMs: contract.developmentToMs, rules: t.spec, diagnostics: t.reasons, netReturnPct: t.development.netReturnPct }));
const context = ctSessionContext({ ...ct, trials: [], memory }, "", hurdle, { index: 0, kind: "design" });
console.log("system", CT_DESIGNER_SYSTEM.length, "tools", JSON.stringify(CT_SESSION_TOOLS).length, "stable", context.stable.length, "history", context.history.length, "task", context.task.length);
