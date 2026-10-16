import { BinanceAPI,binanceKline,binanceSetting } from "./binance-api.ts";
import { ctStockSession } from "./ct-sessions.ts";
import { env } from "cloudflare:workers";
import { fetchTossMinuteCandles } from "@/lib/market-data";
import { queryLocalMarket } from "./local-market-data.ts";
import { parseTossCandle } from "./live-bars.ts";
import { easternParts } from "./market-clock.ts";
import { upbitCandles } from "./upbit.ts";
import { validCTBar, type CTBar } from "./ct-engine.ts";
import { ctDatasetFor } from "./ct-symbols.ts";
import type { CTContract } from "./ct-spec.ts";
/** The immutable snapshot that holds this symbol's bars (one per dataset when several coins are studied). */
export const ctSnapshotFor = (contract: CTContract, symbol: string) =>
  contract.dataSnapshots?.[symbol] ?? contract.dataSnapshot;
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
  const from = ctResearchPageStart(contract, before);
  const result = await queryLocalMarket({
    dataset: ctDatasetFor(contract.market, symbol),
    instrument: symbol,
    venue: contract.market === "stock" ? "US" : "BinanceSpot",
    quoteCurrency: contract.currency,
    from,
    to: before,
    minutes: 1,
    session: contract.market === "stock" ? "regular" : "all",
    snapshot: ctSnapshotFor(contract, symbol),
  });
  return result.bars;
}
// Page by time window so empty weeks and exchange holidays never end history early.
export function ctResearchPageStart(contract: CTContract, before: number) {
  return Math.max(contract.fromMs, before - 7 * 86400000);
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

  if (
    market === "crypto" &&
    minutes === 1 &&
    sorted.some((b) => b.endMs - b.startMs !== 60000)
  )
    return sorted.filter((b) => b.endMs <= nowMs);
  const size = minutes * 60000,
    groups = new Map<number, CTBar[]>();
  for (const b of sorted) {
    if (market === "stock") {
      const et = easternParts(b.startMs);
      const session = ctStockSession(et.date);
      if (!session || et.time < session.open || et.time >= session.close)
        continue;
    }
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
  if (contract.dataSnapshot) {
    const entries: Array<[string, CTBar[]]> = [];
    for (const symbol of contract.symbols) {
      const bars: CTBar[] = [];
      for (
        let from = contract.fromMs;
        from < contract.toMs;
        from += 31 * 86400000
      ) {
        const page = await queryLocalMarket({
          dataset: ctDatasetFor(contract.market, symbol),
          instrument: symbol,
          quoteCurrency: contract.currency,
          from,
          to: Math.min(contract.toMs, from + 31 * 86400000),
          minutes: contract.minutes,
          session: contract.market === "stock" ? "regular" : "all",
          snapshot: ctSnapshotFor(contract, symbol),
        });
        bars.push(...page.bars);
      }
      entries.push([symbol, bars]);
    }
    return Object.fromEntries(entries);
  }
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
        contract.market === "crypto" && !contract.dataSnapshot
          ? 1
          : contract.minutes,
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
  /** Calendar days of local one-minute history behind today's candles (60/240/1440-minute conditions need weeks). */
  warmupDays = 7,
) {
  if(contract.market==="crypto"&&contract.currency==="USDT") {
    const client=new BinanceAPI("spot",binanceSetting("BINANCE_NETWORK")==="testnet"?"testnet":"mainnet"),out:CTBar[]=[];
    const since=nowMs-Math.max(2,warmupDays)*86400000;
    for(let cursor=since;cursor<nowMs;) {
      const response=await client.read("klines",{symbol,interval:"1m",startTime:Math.floor(cursor),endTime:Math.floor(nowMs-1),limit:1000}) as unknown as unknown[][];
      if(!response.length)break;const page=response.map(r=>binanceKline(r));out.push(...page.filter(b=>b.endMs<=nowMs));const next=page.at(-1)!.endMs;if(next<=cursor)throw new Error("Binance 데이터 커서 정체");cursor=next;
    }
    return aggregateCT(out,contract.minutes,contract.market,nowMs);
  }
  let before = nowMs;
  const rows: CTBar[] = [];
  if (contract.market === "stock" && contract.dataSnapshot) {
    const to = Math.min(contract.toMs, Math.floor(nowMs / 86400000) * 86400000);
    if (to > contract.fromMs) {
      const warmup = await queryLocalMarket({
        dataset: "stock",
        instrument: symbol,
        from: Math.max(contract.fromMs, to - warmupDays * 86400000),
        to,
        minutes: 1,
        session: "regular",
        snapshot: ctSnapshotFor(contract, symbol),
      });
      rows.push(...warmup.bars);
    }
  }
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
    if (
      contract.market === "stock" &&
      oldest < Math.floor(nowMs / 86400000) * 86400000
    )
      break;
  }
  return aggregateCT(
    rows,
    contract.market === "crypto" ? 1 : contract.minutes,
    contract.market,
    nowMs,
  );
}
