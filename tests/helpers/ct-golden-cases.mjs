/**
 * ct-pattern-1 regression cases. `golden()` replays seeded synthetic one-minute markets
 * through the engine and digests every field of every result. The digests in
 * tests/fixtures/ct-pattern-1-golden.json were produced BEFORE the ct-pattern-2 changes
 * (day-end exits, 60/240/1440 timeframes, cost profiles), so a bit-for-bit match proves
 * registered ct-pattern-1 packages still judge the same way.
 *
 *   node --experimental-strip-types tests/helpers/ct-golden-cases.mjs   # prints the digests
 */
import { createHash } from "node:crypto";
import { replayCT, ctGate, ctSummary } from "../../lib/ct-engine.ts";
import { ctStockSession } from "../../lib/ct-sessions.ts";

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Random-walk minute bars over [startMs, startMs + minutes). Mean-reverting enough to trade. */
export function walk(seed, startMs, minutes, base = 100, vol = 0.0006, skip = () => false) {
  const r = rng(seed);
  const out = [];
  let price = base;
  for (let i = 0; i < minutes; i++) {
    const s = startMs + i * 60000;
    const open = price;
    const drift = (base - price) / base * 0.002;
    const close = open * (1 + drift + (r() - 0.5) * 2 * vol);
    const high = Math.max(open, close) * (1 + r() * vol * 0.8);
    const low = Math.min(open, close) * (1 - r() * vol * 0.8);
    price = close;
    if (skip(s, i)) continue;
    out.push({ startMs: s, endMs: s + 60000, open, high, low, close, volume: 50 + r() * 200 });
  }
  return out;
}
/** Regular-session minutes only, one block per NYSE session in [fromDay, days). */
export function stockWalk(seed, fromMs, days, base = 100, vol = 0.0006) {
  const all = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(fromMs + d * 86400000).toISOString().slice(0, 10);
    const session = ctStockSession(day);
    if (!session) continue;
    const open = Date.parse(`${day}T${session.open.replace(":", ":")}:00-05:00`);
    // January is EST (UTC-5): the fixture window stays inside it.
    const close = Date.parse(`${day}T${session.close}:00-05:00`);
    const minutes = (close - open) / 60000;
    all.push(...walk(seed + d, open, minutes, base * (1 + (d % 5) * 0.001), vol));
  }
  return all;
}
const cond = (feature, lookback, op, value, timeframe = 1, offset = 0) => ({ feature, lookback, offset, timeframe, op, value });
const baseSpec = (over) => ({
  version: 1,
  engine: "ct-pattern-1",
  name: "golden",
  market: "crypto",
  symbols: ["BTCUSDT"],
  minutes: 1,
  stages: [{ label: "stage one", maxGapBars: 1, conditions: [cond("return_pct", 5, "lte", -0.12)] }],
  entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
  exit: { stopPct: 0.5, targetPct: 0.6, maxHoldBars: 120, invalidation: "stop" },
  sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 3, participationPct: 1 },
  sourceIds: ["g"],
  assumptions: ["golden regression fixture"],
  ...over,
});
export const contractFor = (market, fromMs, days) => ({
  market,
  symbols: market === "crypto" ? ["BTCUSDT"] : ["NVDA"],
  minutes: 1,
  fromMs,
  trainingToMs: fromMs + Math.floor(days * 0.6) * 86400000,
  developmentToMs: fromMs + Math.floor(days * 0.8) * 86400000,
  toMs: fromMs + days * 86400000,
  currency: market === "crypto" ? "USDT" : "USD",
  timezone: market === "crypto" ? "UTC" : "America/New_York",
  capital: 1000,
  costs: { feePct: 0.1, sellTaxPct: market === "crypto" ? 0 : 0.0008, spreadPct: 0.05, slippagePct: 0.03, minimumOrder: market === "crypto" ? 5 : 1, quantityDecimals: market === "crypto" ? 8 : 0 },
  policy: { minTrades: 20, maxDrawdownPct: 15, minNetReturnPct: 0, minMeanDailyReturnPct: 0, minCompliancePct: 100, maxSymbolConcentrationPct: 80, maxExperiments: 12, maxCandidates: 6, maxComputeMs: 600000, maxActiveMs: 3600000, stagnation: 3, reserveFraction: 0.35 },
  engine: "ct-pattern-1",
  createdAt: "2026-01-01T00:00:00Z",
  selection: "golden",
});
const FROM_CRYPTO = Date.UTC(2026, 0, 5);
const FROM_STOCK = Date.UTC(2026, 0, 5);
export const goldenCases = () => {
  const gap = (s, i) => i % 1700 === 900; // sparse single-minute holes (may end a replay in data_error)
  const crypto = walk(11, FROM_CRYPTO, 6 * 1440, 100, 0.0007);
  const holey = walk(11, FROM_CRYPTO, 6 * 1440, 100, 0.0007, gap);
  const stock = stockWalk(23, FROM_STOCK, 8, 100, 0.0006);
  return [
    { id: "crypto-reversal", market: "crypto", days: 6, data: crypto, spec: baseSpec({}) },
    {
      id: "crypto-three-minute-two-stage",
      market: "crypto",
      days: 6,
      data: crypto,
      spec: baseSpec({
        stages: [
          { label: "stage a", maxGapBars: 1, conditions: [cond("return_pct", 4, "lte", -0.1, 3)] },
          { label: "stage b", maxGapBars: 6, conditions: [cond("volume_ratio", 6, "gte", 1.0, 1), cond("range_position", 10, "lte", 0.6, 1)] },
        ],
        exit: { stopPct: 0.4, targetPct: 0.5, maxHoldBars: 60, invalidation: "last_stage_low" },
      }),
    },
    {
      id: "crypto-twelve-minute-swing",
      market: "crypto",
      days: 6,
      data: crypto,
      spec: baseSpec({
        stages: [{ label: "stage a", maxGapBars: 1, conditions: [cond("sma_distance_pct", 8, "lte", -0.05, 12), cond("swing_low_distance_pct", 20, "gte", 0, 1)] }],
        exit: { stopPct: 0.6, targetPct: 0.9, maxHoldBars: 390, invalidation: "stop" },
      }),
    },
    { id: "crypto-with-holes", market: "crypto", days: 6, data: holey, spec: baseSpec({ exit: { stopPct: 0.5, targetPct: 0.6, maxHoldBars: 40, invalidation: "stop" } }) },
    { id: "stock-session", market: "stock", days: 8, data: stock, spec: baseSpec({ market: "stock", symbols: ["NVDA"], exit: { stopPct: 0.5, targetPct: 0.7, maxHoldBars: 390, invalidation: "stop" } }) },
    {
      id: "stock-contraction-breakout",
      market: "stock",
      days: 8,
      data: stock,
      spec: baseSpec({
        market: "stock",
        symbols: ["NVDA"],
        stages: [{ label: "stage a", maxGapBars: 2, conditions: [cond("contraction_ratio", 12, "lte", 0.9), cond("prior_high_distance_pct", 12, "gte", -0.05)] }],
        exit: { stopPct: 0.4, targetPct: 0.8, maxHoldBars: 200, invalidation: "stop" },
      }),
    },
  ];
};
export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Replay every case at base cost, doubled cost and a one-bar delay; digest all of it. */
export function golden() {
  const out = {};
  for (const c of goldenCases()) {
    const contract = contractFor(c.market, c.market === "crypto" ? FROM_CRYPTO : FROM_STOCK, c.days);
    const run = (from, to, options) => replayCT(c.spec, { [c.spec.symbols[0]]: c.data }, contract, from, to, "golden-hash", options);
    const train = run(contract.fromMs, contract.trainingToMs);
    const dev = run(contract.trainingToMs, contract.developmentToMs);
    const all = run(contract.fromMs, contract.toMs);
    const stress = run(contract.fromMs, contract.toMs, { costMultiplier: 2 });
    const delayed = run(contract.fromMs, contract.toMs, { delayBars: 1 });
    out[c.id] = {
      trades: all.trades.length,
      net: Number(all.netReturnPct.toFixed(6)),
      digest: digest({ train, dev, all, stress, delayed, gate: ctGate(all, contract), summary: ctSummary(all) }),
    };
  }
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(golden(), null, 2));
