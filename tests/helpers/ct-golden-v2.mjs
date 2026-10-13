/**
 * ct-pattern-2 (and classic-exit ct-pattern-1) regression cases for the ct-pattern-3 work.
 * `goldenV2()` replays seeded markets and digests every field of every result, plus the gate
 * verdict and summary. tests/fixtures/ct-pattern-2-golden.json was produced by the engine as it
 * stood BEFORE ct-pattern-3 (level features, units, entry windows, managed exits, ctExitStep) —
 * run from a clean checkout of that commit — so a bit-for-bit match proves classic rules,
 * their gates and the cost / delay stress runs still judge the same way.
 *
 *   node --experimental-strip-types tests/helpers/ct-golden-v2.mjs   # prints the digests
 */
import { createHash } from "node:crypto";
import { replayCT, ctGate, ctSummary } from "../../lib/ct-engine.ts";
import { ctSpecSchema } from "../../lib/ct-spec.ts";
import { walk, stockWalk, contractFor } from "./ct-golden-cases.mjs";

const DAY0 = Date.UTC(2026, 0, 5),
  DAY = 86_400_000;
const cond = (feature, lookback, op, value, timeframe = 1, offset = 0) => ({ feature, lookback, offset, timeframe, op, value });
const mk = (engine, market, stages, exit, entry = {}) => ({
  version: 1,
  engine,
  name: "digest",
  market,
  symbols: market === "crypto" ? ["BTCUSDT"] : ["NVDA"],
  minutes: 1,
  stages,
  entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2, ...entry },
  exit,
  sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 3, participationPct: 1 },
  sourceIds: ["g"],
  assumptions: ["digest fixture"],
});
export function goldenV2() {
  const out = {};
  const run = (label, spec, data, contract, from, to) => {
    const parsed = ctSpecSchema.parse(spec);
    for (const opt of [{}, { costMultiplier: 2 }, { delayBars: 1 }]) {
      const r = replayCT(parsed, data, contract, from, to, "h", opt);
      out[label + JSON.stringify(opt)] = createHash("sha256").update(JSON.stringify([r, ctGate(r, contract), ctSummary(r)])).digest("hex").slice(0, 16) + ":" + r.trades.length;
    }
  };
  const crypto = { BTCUSDT: walk(5, DAY0, 6 * 1440, 100, 0.0012) };
  const cC = (engine) => ({ ...contractFor("crypto", DAY0, 6), engine });
  for (const engine of ["ct-pattern-1", "ct-pattern-2"]) {
    run(`${engine}/a`, mk(engine, "crypto", [{ label: "drop", maxGapBars: 3, conditions: [cond("return_pct", 5, "lte", -0.12)] }], { stopPct: 0.5, targetPct: 0.6, maxHoldBars: 120, invalidation: "stop" }), crypto, cC(engine), DAY0, DAY0 + 6 * DAY);
    run(`${engine}/b`, mk(engine, "crypto", [{ label: "drop", maxGapBars: 3, conditions: [cond("return_pct", 5, "lte", -0.12), cond("volume_ratio", 5, "gte", 0.8)] }, { label: "bounce", maxGapBars: 4, conditions: [cond("swing_low_distance_pct", 20, "gte", 0.05)] }], { stopPct: 1.5, targetPct: 1.2, maxHoldBars: 200, invalidation: "last_stage_low" }), crypto, cC(engine), DAY0, DAY0 + 6 * DAY);
  }
  const eng = "ct-pattern-2";
  run("v2/higher", mk(eng, "crypto", [{ label: "drop", maxGapBars: 3, conditions: [cond("return_pct", 5, "lte", -0.12)] }, { label: "hourly", maxGapBars: 3, conditions: [cond("sma_distance_pct", 5, "lte", 0.3, 60)] }], { stopPct: 3, targetPct: 5, maxHoldBars: 1440, invalidation: "stop" }, { noEntryBeforeDayEndMinutes: 30 }), crypto, cC(eng), DAY0, DAY0 + 6 * DAY);
  run("v2/daily", mk(eng, "crypto", [{ label: "daily", maxGapBars: 3, conditions: [cond("prior_high_distance_pct", 2, "lte", 0.2, 1440, 1)] }, { label: "drop", maxGapBars: 3, conditions: [cond("return_pct", 5, "lte", -0.1)] }], { stopPct: 2, targetPct: 2, maxHoldBars: 600, invalidation: "stop" }), crypto, cC(eng), DAY0, DAY0 + 6 * DAY);
  const stockData = { NVDA: stockWalk(9, DAY0, 12, 100, 0.0008) };
  for (const engine of ["ct-pattern-1", "ct-pattern-2"]) {
    const sc = { ...contractFor("stock", DAY0, 12), engine };
    run(`${engine}/stock`, mk(engine, "stock", [{ label: "drop", maxGapBars: 3, conditions: [cond("return_pct", 5, "lte", -0.08)] }], { stopPct: 0.6, targetPct: 0.5, maxHoldBars: 390, invalidation: "stop" }), stockData, sc, DAY0, DAY0 + 12 * DAY);
    run(`${engine}/stock2`, mk(engine, "stock", [{ label: "drop", maxGapBars: 3, conditions: [cond("return_pct", 5, "lte", -0.08)] }], { stopPct: 3, targetPct: 3, maxHoldBars: 390, invalidation: "last_stage_low" }), stockData, sc, DAY0, DAY0 + 12 * DAY);
  }
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(goldenV2(), null, 1));
