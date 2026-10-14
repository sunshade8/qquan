// Synthetic 1-minute markets for the stage-4 control groups (contrast_moves).
//  - volOnly:  per-day volatility regime, directionless returns. Moves worth trading happen in the wild days, so
//              extreme past returns of EITHER sign are over-represented among events when controls ignore volatility.
//  - reversal: the same plus mean reversion (a dip tends to be followed by a rebound): events follow dips, stop-first moments follow rallies.
import { ctRng } from "../../lib/ct-trader-tools.ts";
import { CT_ENGINE, CT_POLICY } from "../../lib/ct-spec.ts";

export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const START = Date.UTC(2025, 0, 1);

export function volMarket({ days = 60, seed = 11, reversal = 0, symbol = "BTCUSDT", start = START } = {}) {
  const rng = ctRng(seed);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const out = [];
  let price = 20000;
  const closes = [];
  for (let d = 0; d < days; d++) {
    // Daily volatility multiplier, 0.5x–3x of 0.03% per minute.
    const mult = 0.5 + 2.5 * rng();
    for (let m = 0; m < 1440; m++) {
      const i = d * 1440 + m;
      const sigma = 0.0003 * mult;
      const past = i >= 30 ? Math.log(closes[i - 1] / closes[i - 30]) : 0;
      const ret = sigma * gauss() - reversal * past * 0.02;
      const open = price;
      const close = price * Math.exp(ret);
      const wick = sigma * 0.5 * rng();
      out.push({ startMs: start + i * MINUTE, endMs: start + (i + 1) * MINUTE, open, close, high: Math.max(open, close) * (1 + wick), low: Math.min(open, close) * (1 - wick), volume: 10 + rng() * 5 });
      closes.push(close);
      price = close;
    }
  }
  return { bars: out, symbol };
}

export function volContract({ days = 100, trainingDays = 70, symbol = "BTCUSDT", start = START } = {}) {
  return {
    market: "crypto", symbols: [symbol], minutes: 1,
    fromMs: start, trainingToMs: start + trainingDays * DAY, developmentToMs: start + (trainingDays + 10) * DAY, toMs: start + days * DAY,
    currency: "USDT", timezone: "UTC", capital: 1000,
    costs: { feePct: 0.1, sellTaxPct: 0, spreadPct: 0, slippagePct: 0, minimumOrder: 5, quantityDecimals: 8 },
    policy: CT_POLICY, engine: CT_ENGINE, createdAt: "2025-04-01T00:00:00Z", selection: "fixture",
  };
}

/**
 * Moves exist only on "wild" days (every second day, minute volatility 0.04% vs 0.01% on calm days): at random minutes (about
 * every 150, at least 100 apart) a 0.9% jump over 15 bars, UP or DOWN with equal probability. An up-jump is a move worth
 * trading (an event), a down-jump is what the stop catches (a loser). Where the jumps fall is independent of the past price, so
 * nothing before a jump predicts it except that the day is wild — a control that ignores volatility sees extreme past
 * returns of EITHER sign over-represented among events (two_tailed), a volatility-matched one sees nothing, and "losers"
 * (same hour, same volatility) sees nothing either.
 * With `dip`, a 30-bar 0.4% move AGAINST the coming jump precedes it (a dip before an up-jump, a rally before a down-jump):
 * a direction signal that volatility matching must keep and the losers control must find.
 */
export function plantedVolMarket({ days = 100, seed = 5, dip = false, symbol = "BTCUSDT", start = START } = {}) {
  const rng = ctRng(seed);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const out = [];
  let price = 20000;
  for (let d = 0; d < days; d++) {
    const wild = d % 2 === 0;
    const sigma = wild ? 0.0004 : 0.0001;
    const drift = new Float64Array(1440);
    if (wild)
      for (let m = 60; m < 1400; ) {
        if (rng() < 1 / 50) {
          const sign = rng() < 0.5 ? 1 : -1;
          if (dip) for (let k = m - 30; k < m; k++) drift[k] = (-sign * 0.004) / 30;
          for (let k = m; k < m + 15; k++) drift[k] = (sign * 0.009) / 15;
          m += 100;
        } else m++;
      }
    for (let m = 0; m < 1440; m++) {
      const i = d * 1440 + m;
      const open = price;
      const close = price * Math.exp(drift[m] + sigma * gauss());
      const wick = sigma * 0.4 * rng();
      out.push({ startMs: start + i * MINUTE, endMs: start + (i + 1) * MINUTE, open, close, high: Math.max(open, close) * (1 + wick), low: Math.min(open, close) * (1 - wick), volume: 10 + rng() * 5 });
      price = close;
    }
  }
  return { bars: out, symbol };
}
