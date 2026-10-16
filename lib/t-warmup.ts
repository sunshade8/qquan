import { ctAtrWindow, ctExitAtrConfig, ctExitUsesAtr, ctRowsNeeded, type CTSpec } from "./t-spec.ts";
import { higherWarmupMinutes } from "./t-timeframes.ts";

/**
 * Calendar days of history the rules' higher-timeframe windows need (7 when none do): 60/240/1440-minute
 * conditions, ATR normalisers and the exit's ATR on higher timeframes, and the previous day's levels
 * (two sessions; the 7-day floor covers them).
 */
export function ctWarmupDays(specs: CTSpec[]) {
  let sessions = 0;
  const need = (spec: CTSpec, timeframe: number, lookback: number, offset: number) => {
    if (timeframe > 12) sessions = Math.max(sessions, higherWarmupMinutes(spec.market, timeframe, lookback, offset) / (spec.market === "stock" ? 390 : 1440));
  };
  for (const spec of specs) {
    for (const stage of spec.stages)
      for (const c of stage.conditions) {
        need(spec, c.timeframe, ctRowsNeeded(c) - 1, c.offset);
        if (c.unit === "atr") need(spec, ctAtrWindow(c).timeframe, ctAtrWindow(c).rows - 1, 0);
      }
    const atr = ctExitUsesAtr(spec.exit) ? ctExitAtrConfig(spec.exit) : null;
    if (atr) need(spec, atr.timeframe, atr.lookback, 0);
  }
  return Math.max(7, Math.ceil((sessions * 7) / 5) + 3);
}
