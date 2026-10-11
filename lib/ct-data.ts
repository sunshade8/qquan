import { ctStockSession } from "./ct-sessions.ts";
import { env } from "cloudflare:workers";
import { fetchTossMinuteCandles } from "@/lib/market-data";
import { parseTossCandle } from "./live-bars.ts";
import { easternParts } from "./market-clock.ts";
import { upbitCandles } from "./upbit.ts";
import { validCTBar, type CTBar } from "./ct-engine.ts";
import type { CTContract } from "./ct-spec.ts";
export const ctDb = () => (env as unknown as { DB: D1Database }).DB;
export async function ctDataPage(
  contract: CTContract,
  symbol: string,
  before: number,
) {
  if (
    !contract.symbols.includes(symbol) ||
    before > contract.toMs ||
    before < contract.fromMs
  )
    throw new Error("데이터 호출 범위 위반");
  if (contract.market === "crypto")
    return upbitCandles(symbol, contract.minutes, before);
  const page = await fetchTossMinuteCandles(symbol, {
    count: 200,
    before: new Date(before).toISOString(),
    adjusted: false,
  });
  return page.candles
    .map(parseTossCandle)
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .map((b) => ({ ...b, startMs: b.endMs - 60000 }));
}
export function aggregateCT(
  rows: CTBar[],
  minutes: number,
  market: CTContract["market"],
  nowMs: number,
) {
  const unique = new Map<number, CTBar>();
  for (const row of rows) {
    const prior = unique.get(row.endMs);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row))
      throw new Error("중복 시각의 가격 충돌");
    unique.set(row.endMs, row);
  }
  const sorted = [...unique.values()].sort((a, b) => a.endMs - b.endMs);
  if (sorted.some((b) => !validCTBar(b))) throw new Error("비정상 시장 데이터");
  if (market === "crypto") return sorted.filter((b) => b.endMs <= nowMs);
  const size = minutes * 60000,
    groups = new Map<number, CTBar[]>();
  for (const b of sorted) {
    const et = easternParts(b.startMs);
    const session = ctStockSession(et.date);
    if (!session || et.time < session.open || et.time >= session.close)
      continue;
    const at = Math.floor(b.startMs / size) * size;
    const group = groups.get(at) ?? [];
    group.push(b);
    groups.set(at, group);
  }
  return [...groups]
    .flatMap(([at, bars]) =>
      bars.length === minutes &&
      bars.every((b, i) => b.startMs === at + i * 60000) &&
      at + size <= nowMs
        ? [
            {
              startMs: at,
              endMs: at + size,
              open: bars[0].open,
              close: bars.at(-1)!.close,
              high: Math.max(...bars.map((b) => b.high)),
              low: Math.min(...bars.map((b) => b.low)),
              volume: bars.reduce((s, b) => s + b.volume, 0),
            },
          ]
        : [],
    )
    .sort((a, b) => a.endMs - b.endMs);
}
export async function loadCTData(runId: string, contract: CTContract) {
  const pages = await ctDb()
    .prepare(
      "SELECT symbol,payload FROM ct_data_pages WHERE run_id=? ORDER BY before_ms",
    )
    .bind(runId)
    .all<{ symbol: string; payload: string }>();
  return Object.fromEntries(
    contract.symbols.map((symbol) => [
      symbol,
      aggregateCT(
        pages.results
          .filter((p) => p.symbol === symbol)
          .flatMap((p) => JSON.parse(p.payload) as CTBar[]),
        contract.minutes,
        contract.market,
        contract.toMs,
      ).filter((b) => b.startMs >= contract.fromMs),
    ]),
  );
}
export async function ctRecentBars(
  contract: CTContract,
  symbol: string,
  nowMs: number,
) {
  let before = nowMs;
  const rows: CTBar[] = [];
  const native = contract.market === "stock" ? 1 : contract.minutes;
  // Current day only for stocks; closed sessions are never joined into a fake continuous candle.
  const count = contract.market === "stock" ? Math.ceil(390 / 200) + 1 : 8;
  for (let i = 0; i < count; i++) {
    const page =
      contract.market === "crypto"
        ? await upbitCandles(symbol, contract.minutes, before)
        : (
            await fetchTossMinuteCandles(symbol, {
              count: 200,
              before: new Date(before).toISOString(),
              adjusted: false,
            })
          ).candles
            .map(parseTossCandle)
            .filter((b): b is NonNullable<typeof b> => b !== null)
            .map((b) => ({ ...b, startMs: b.endMs - native * 60000 }));
    if (!page.length) break;
    rows.push(...page);
    const oldest = Math.min(...page.map((b) => b.startMs));
    if (oldest >= before) throw new Error("데이터 커서 정체");
    before = oldest;
  }
  return aggregateCT(rows, contract.minutes, contract.market, nowMs);
}
