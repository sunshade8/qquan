import { CT_ENGINE, CT_POLICY } from "../../lib/ct-spec.ts";
export const condition = {
  feature: "prior_high_distance_pct",
  lookback: 3,
  offset: 0,
  timeframe: 1,
  op: "gte",
  value: -0.3,
};
export const spec = (market = "crypto") => ({
  version: 1,
  engine: CT_ENGINE,
  name: "Fixture pattern",
  market,
  symbols: market === "crypto" ? ["KRW-BTC"] : ["SPY"],
  minutes: 5,
  stages: [
    { label: "breakout", maxGapBars: 1, conditions: [{ ...condition }] },
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
  sourceIds: ["verified"],
  assumptions: [
    "Public approach approximated in numeric completed-bar conditions.",
  ],
});
export const contract = (market = "crypto") => ({
  market,
  symbols: market === "crypto" ? ["KRW-BTC"] : ["SPY"],
  minutes: 5,
  fromMs: Date.UTC(2025, 0, 1),
  trainingToMs: Date.UTC(2025, 0, 2),
  developmentToMs: Date.UTC(2025, 0, 3),
  toMs: Date.UTC(2025, 0, 4),
  currency: market === "crypto" ? "KRW" : "USD",
  timezone: market === "crypto" ? "Asia/Seoul" : "America/New_York",
  capital: market === "crypto" ? 1000000 : 1000,
  costs: {
    feePct: 0.1,
    sellTaxPct: 0,
    spreadPct: 0.05,
    slippagePct: 0.03,
    minimumOrder: market === "crypto" ? 5000 : 1,
    quantityDecimals: market === "crypto" ? 8 : 0,
  },
  policy: CT_POLICY,
  engine: CT_ENGINE,
  createdAt: "2025-01-05T00:00:00Z",
  selection: "fixture",
});
export function bars(count = 80, start = Date.UTC(2025, 0, 1)) {
  return Array.from({ length: count }, (_, i) => ({
    startMs: start + i * 300000,
    endMs: start + (i + 1) * 300000,
    open: 100 + i * 0.1,
    high: 100.4 + i * 0.1,
    low: 99.8 + i * 0.1,
    close: 100.2 + i * 0.1,
    volume: 100000,
  }));
}
export const ctState = (market = "crypto") => ({
  version: 1,
  phase: "design",
  contract: contract(market),
  dataCursor: { symbol: 0, before: contract(market).toMs, pages: 0 },
  dataHash: "fixture-data",
  sources: [
    {
      id: "verified",
      url: "https://example.com/verified",
      title: "Fixture source",
      text: "Actual verified source text, this is a regression fixture.",
      hash: "source",
      fetchedAt: "2025-01-05",
      publishedAt: null,
    },
  ],
  trials: [],
  tools: [],
  memory: [],
  computeMs: 0,
  activeMs: 0,
  backtests: 0,
  duplicateCount: 0,
});
export const candidate = (market = "crypto") => ({
  spec: spec(market),
  hypothesis: {
    phenomenon: "Observe a measurable upward breakout.",
    mechanism: "Trend persistence is a falsifiable hypothesis.",
    falsification: "Development costs erase positive returns.",
    failureRegimes: ["range"],
  },
  mapping: [
    {
      stage: 0,
      condition: 0,
      feature: condition.feature,
      sourceId: "verified",
      implementationAssumption:
        "Convert discretionary breakout to numeric prior highs.",
    },
  ],
  parentId: null,
  observedProblem: "",
  changes: [],
  expectedEffect: "",
  memoryIds: [],
});
