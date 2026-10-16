// A synthetic 1-minute market with a planted, labelled move: every 200 minutes a 20-bar
// contraction (almost no range) is followed by a +0.9% jump over 15 bars; elsewhere price
// jitters. Used by the stage-3 trader tools tests (labels, contrast, charts, diagnosis).
import { CT_ENGINE, CT_POLICY_V6 as CT_POLICY } from "../../lib/ct-spec.ts";
import { ctRng } from "../../lib/ct-trader-tools.ts";

export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const START = Date.UTC(2025, 0, 1);

/** Planted events start (contraction) at minute 200·k + 50 of the series; the jump starts 20 bars later. */
export function plantedMarket({ days = 12, seed = 7, start = START, symbol = "BTCUSDT" } = {}) {
  const rng = ctRng(seed);
  const n = days * 1440;
  const out = [];
  let price = 20000;
  const planted = [];
  for (let i = 0; i < n; i++) {
    const phase = i % 200;
    let drift = 0;
    let jitter = (rng() - 0.5) * 0.0004; // ±0.02% per minute
    let wick = 0.0002;
    if (phase >= 50 && phase < 70) {
      jitter = (rng() - 0.5) * 0.00002; // contraction
      wick = 0.00001;
      if (phase === 50) planted.push(start + i * MINUTE);
    } else if (phase >= 70 && phase < 85) {
      drift = 0.009 / 15; // +0.9% over 15 bars
      jitter = (rng() - 0.5) * 0.0001;
      wick = 0.00005;
    }
    const open = price;
    const close = price * (1 + drift + jitter);
    out.push({
      startMs: start + i * MINUTE,
      endMs: start + (i + 1) * MINUTE,
      open,
      close,
      high: Math.max(open, close) * (1 + wick * (0.5 + rng())),
      low: Math.min(open, close) * (1 - wick * (0.5 + rng())),
      volume: 10 + rng() * 5,
    });
    price = close;
  }
  return { bars: out, planted, symbol };
}

export function plantedContract({ days = 12, trainingDays = 8, symbol = "BTCUSDT", start = START } = {}) {
  return {
    market: "crypto",
    symbols: [symbol],
    minutes: 1,
    fromMs: start,
    trainingToMs: start + trainingDays * DAY,
    developmentToMs: start + (trainingDays + 2) * DAY,
    toMs: start + days * DAY,
    currency: "USDT",
    timezone: "UTC",
    capital: 1000,
    costs: { feePct: 0.1, sellTaxPct: 0, spreadPct: 0, slippagePct: 0, minimumOrder: 5, quantityDecimals: 8 },
    policy: CT_POLICY,
    engine: CT_ENGINE,
    createdAt: "2025-02-01T00:00:00Z",
    selection: "fixture",
  };
}
