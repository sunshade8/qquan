import { localDailyRows } from './local-market-data.ts';
import type { PriceRow } from './market-data.ts';
export type PriceLoad = {
  rows: PriceRow[];
  origin: "yahoo" | "google-finance" | "cache" | "cache-stale";
  reason: string | null;
};

/** Legacy SQL caches are preserved for migration; new daily research uses raw Parquet. */
export async function loadDailyRows(symbol:string,from:string,to:string):Promise<PriceLoad>{
 const rows=await localDailyRows(symbol,from,to);
 return {rows,origin:'cache',reason:'공유 로컬 Parquet · Massive unadjusted 원봉 집계'};
}
