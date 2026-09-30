import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db/ensure";
import { shiftDate } from "./market-clock.ts";
import { fetchGroupedDaily } from "./surge-market.ts";
import { expandMarket, type CompactMarketRow, type MarketRow } from "./surge-universe.ts";
import { paceMassive } from "./massive-pacer.ts";
import { isExcludedInstrument } from "./trade-slots.ts";
import type { GenerationJob, StrategyResearch } from "./strategy-generation-types.ts";

/** Discovery sees an actual historical market snapshot strictly before all test dates. */
export async function discoverResearchUniverse(job: GenerationJob, progress: (message: string) => void): Promise<NonNullable<StrategyResearch["discovery"]>> {
  await ensureSchema();
  const db = (env as unknown as { DB: D1Database }).DB;
  const research = job.research!;
  const cached = await db.prepare("SELECT trading_date, payload FROM surge_market_days WHERE basis='raw-events-v2' AND trading_date BETWEEN ? AND ? ORDER BY trading_date DESC LIMIT 1")
    .bind(shiftDate(research.trainingTo, -14), research.trainingTo).first<{ trading_date: string; payload: string }>();
  let asOf = cached?.trading_date ?? research.trainingTo;
  let rows: MarketRow[] = cached ? expandMarket(JSON.parse(cached.payload) as CompactMarketRow[]) : [];
  if (!cached) {
    for (let offset = 0; offset < 8; offset++) {
      asOf = shiftDate(research.trainingTo, -offset);
      progress(`연구용 시장 데이터 확인 · ${asOf}`);
      await paceMassive("전략 탐색용 전체 시장 일봉", progress);
      rows = await fetchGroupedDaily(asOf, true);
      if (rows.length) break;
    }
  }
  if (!rows.length) throw new Error("탐색에 필요한 과거 시장 데이터를 확보하지 못했습니다.");
  const inventory = await db.prepare("SELECT symbol, COUNT(DISTINCT trading_date) sessions FROM intraday_bar_days WHERE provider='Massive' AND interval='1m' AND trading_date BETWEEN ? AND ? GROUP BY symbol")
    .bind(job.from, research.trainingTo).all<{ symbol: string; sessions: number }>();
  const coverage = new Map(inventory.results.map(row => [row.symbol, row.sessions]));
  const candidates = rows.filter(row => /^[A-Z][A-Z0-9.-]{0,14}$/.test(row.symbol) && !isExcludedInstrument(row.symbol) &&
    row.close >= 1 && row.close <= job.capitalUsd * 0.98 && row.dollarVolume >= 5_000_000 &&
    (!research.constraints.universe || research.constraints.universe.includes(row.symbol)))
    .sort((a, b) => b.dollarVolume - a.dollarVolume || a.symbol.localeCompare(b.symbol))
    .slice(0, 24)
    .map(row => ({ symbol: row.symbol, price: row.close, dollarVolume: Math.round(row.dollarVolume),
      rangePct: Math.round(((row.high ?? row.close) - (row.low ?? row.close)) / row.close * 10000) / 100,
      cachedSessions: coverage.get(row.symbol) ?? 0 }));
  if (!candidates.length) throw new Error("지정 범위에서 가격·거래대금 조건을 충족하는 연구 종목이 없습니다. 종목 제한을 조정해 주세요.");
  return { asOf, source: "Massive · 학습 구간 전체 시장 일봉", candidates };
}
