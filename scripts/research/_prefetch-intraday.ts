/** Warms the Massive 5-minute cache for every symbol the intraday hypotheses need. */
import { loadIntraday } from "./_load.ts";

const FROM = "2024-09-09";
const TO = "2026-09-04";
const SYMBOLS = ["NVDA", "TSLA", "AMD", "COIN", "PLTR", "QQQ", "SPY", "TQQQ"];

for (const symbol of SYMBOLS) {
  try {
    const points = await loadIntraday(symbol, FROM, TO, "5m");
    console.error(`${symbol}: ${points.length} bars ${points[0]?.date}..${points.at(-1)?.date}`);
  } catch (error) {
    console.error(`${symbol}: FAILED ${(error as Error).message}`);
  }
}
