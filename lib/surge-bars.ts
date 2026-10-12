/** Raw local minute data shared with CT and relay. Legacy SQL rows remain preserved. */
import { localStockPoints, dataRPC } from "./local-market-data.ts";
import type { IntradayBar } from "./relay-engine.ts";
import {
  SURGE_INTERVALS,
  intervalMinutes,
  SURGE_DAY_FROM,
  SURGE_DAY_TO,
  type SurgeInterval,
} from "./surge-spec.ts";
import { rollUp, rollUpComplete } from "./bar-rollup.ts";
export const rawInterval = (interval: SurgeInterval) => `${interval}-raw`;
export type SurgeBarFetch = {
  symbol: string;
  from: string;
  to: string;
  cached: boolean;
  minuteBars: number;
  sessions: number;
};
export async function loadSurgeBars(
  symbol: string,
  from: string,
  to: string,
  onProgress: (message: string) => void = () => undefined,
): Promise<SurgeBarFetch> {
  onProgress(`${symbol} 공유 로컬 Parquet 확인 · 추가 과거 API 호출 없음`);
  const points = await localStockPoints(symbol, from, to, "1m", "all");
  return {
    symbol,
    from,
    to,
    cached: true,
    minuteBars: points.length,
    sessions: new Set(points.map((p) => p.date)).size,
  };
}
export async function readSurgeBars(
  interval: SurgeInterval,
  symbols: string[],
  dates: string[],
) {
  const result: Array<{ symbol: string; date: string; bars: IntradayBar[] }> =
    [];
  for (const symbol of symbols)
    for (const date of dates) {
      const points = await localStockPoints(symbol, date, date, "1m", "all");
      result.push({
        symbol,
        date,
        bars: rollUpComplete(
          points.filter(
            (p) =>
              p.date === date &&
              p.time >= SURGE_DAY_FROM &&
              p.time <= SURGE_DAY_TO,
          ),
          intervalMinutes(interval),
        ),
      });
    }
  return result;
}
export async function surgeBarInventory() {
  const catalog = await dataRPC<
    Array<{ dataset: string; rows: number; coverage: number[][] }>
  >({ action: "status" });
  const stock = catalog.find((d) => d.dataset === "stock");
  if (!stock?.coverage.length) return [];
  return SURGE_INTERVALS.map((interval) => ({
    interval: rawInterval(interval),
    symbols: 1,
    sessions: stock.coverage.length,
    firstDate: new Date(Math.min(...stock.coverage.map((c) => c[0])))
      .toISOString()
      .slice(0, 10),
    lastDate: new Date(Math.max(...stock.coverage.map((c) => c[1])) - 1)
      .toISOString()
      .slice(0, 10),
  }));
}
export { SURGE_INTERVALS, rollUp };
