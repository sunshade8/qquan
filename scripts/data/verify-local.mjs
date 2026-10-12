/** Real-engine verification over already downloaded Parquet. No model or orders. */
import assert from "node:assert/strict";
import { register } from "node:module";
// Loader resolves app aliases; ct-data and its common Parquet query are the real modules.
register("../../tests/helpers/slot-test-loader.mjs", import.meta.url);
globalThis.__strategyTestEnv = {};
const { loadCTData } = await import("../../lib/ct-data.ts");
import { queryLocalMarket } from "../../lib/local-market-data.ts";
import { replayCT, qualityCT } from "../../lib/ct-engine.ts";
import { ctHash, CT_ENGINE, CT_POLICY } from "../../lib/ct-spec.ts";
process.env.QQUAN_DENY_MARKET_NETWORK = "1";
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw Error("All network disabled");
};
const ranges = [
  {
    dataset: "stock",
    instrument: "NVDA",
    from: Date.parse("2026-09-28"),
    to: Date.parse("2026-09-29"),
    currency: "USD",
  },
  {
    dataset: "btc",
    instrument: "BTCUSDT",
    from: Date.parse("2025-01-01"),
    to: Date.parse("2025-02-01"),
    currency: "USDT",
  },
];
const report = [];
for (const r of ranges) {
  const market = r.dataset === "stock" ? "stock" : "crypto";
  const data = await queryLocalMarket({
    ...r,
    minutes: 5,
    session: market === "stock" ? "regular" : "all",
  });
  const repeat = await queryLocalMarket({
    ...r,
    minutes: 5,
    snapshot: data.snapshot,
    session: market === "stock" ? "regular" : "all",
  });
  assert.deepEqual(repeat.bars, data.bars);
  assert.equal(data.externalRequestCount, 0);
  for (const minutes of [15, 60]) {
    const rolled = await queryLocalMarket({
      ...r,
      minutes,
      session: market === "stock" ? "regular" : "all",
    });
    assert.ok(rolled.bars.length > 0);
  }
  const contract = {
    market,
    symbols: [r.instrument],
    minutes: 5,
    fromMs: r.from,
    toMs: r.to,
    trainingToMs: r.from + (r.to - r.from) * 0.6,
    developmentToMs: r.from + (r.to - r.from) * 0.8,
    currency: r.currency,
    timezone: market === "stock" ? "America/New_York" : "UTC",
    capital: 10000,
    costs: {
      feePct: 0.1,
      sellTaxPct: market === "stock" ? 0.0008 : 0,
      spreadPct: 0.05,
      slippagePct: 0.03,
      minimumOrder: market === "stock" ? 1 : 5,
      quantityDecimals: market === "stock" ? 0 : 8,
    },
    policy: CT_POLICY,
    engine: CT_ENGINE,
    createdAt: new Date().toISOString(),
    selection: "Measured local verification, not evidence of profitability",
    dataSnapshot: data.snapshot,
  };
  const staged = await loadCTData("verification-no-write", contract);
  assert.deepEqual(staged[r.instrument], data.bars);
  const spec = {
    version: 1,
    engine: CT_ENGINE,
    name: "Local Parquet verification",
    market,
    symbols: [r.instrument],
    minutes: 5,
    stages: [
      {
        label: "Prior high",
        maxGapBars: 1,
        conditions: [
          {
            feature: "prior_high_distance_pct",
            lookback: 3,
            offset: 0,
            timeframe: 1,
            op: "gte",
            value: -0.3,
          },
        ],
      },
    ],
    entry: {
      order: "marketable_limit",
      validBars: 1,
      maxSpreadPct: 0.5,
      maxDeviationPct: 2,
    },
    exit: { stopPct: 1, targetPct: 2, maxHoldBars: 3, invalidation: "stop" },
    sizing: {
      riskPct: 1,
      allocationPct: 25,
      maxPositions: 1,
      cooldownBars: 1,
      participationPct: 1,
    },
    sourceIds: ["verification"],
    assumptions: [
      "This is execution plumbing verification; no investment claim.",
    ],
  };
  const replay = replayCT(
    spec,
    { [r.instrument]: data.bars },
    contract,
    r.from,
    r.to,
    await ctHash(spec),
    { deadline: Date.now() + 120000 },
  );
  report.push({
    instrument: r.instrument,
    range: [new Date(r.from).toISOString(), new Date(r.to).toISOString()],
    bars: data.bars.length,
    quality: qualityCT(data.bars, 5),
    snapshot: data.snapshot,
    localReads: data.localReadCount + repeat.localReadCount,
    externalRequests:
      requests + data.externalRequestCount + repeat.externalRequestCount,
    ctDataStageMatches: true,
    replayStatus: replay.status,
    trades: replay.trades.length,
  });
}
assert.equal(requests, 0);
console.log(JSON.stringify(report, null, 2));
