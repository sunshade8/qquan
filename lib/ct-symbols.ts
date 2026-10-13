import type { CTMarket } from "./ct-spec.ts";

/** Local one-minute datasets (scripts/data/store.py DATASETS). */
export type LocalDataset = "stock" | "btc" | "eth" | "sol";
export const LOCAL_DATASETS: readonly LocalDataset[] = ["stock", "btc", "eth", "sol"];
/** Binance Spot research symbols CT can study, and the dataset that holds each. */
export const CT_CRYPTO_DATASETS = { BTCUSDT: "btc", ETHUSDT: "eth", SOLUSDT: "sol" } as const;
export const CT_CRYPTO_SYMBOLS = Object.keys(CT_CRYPTO_DATASETS) as Array<keyof typeof CT_CRYPTO_DATASETS>;

export function ctDatasetFor(market: CTMarket, symbol: string): LocalDataset {
  if (market === "stock") return "stock";
  const dataset = (CT_CRYPTO_DATASETS as Record<string, LocalDataset>)[symbol];
  if (!dataset) throw new Error(`로컬 1분봉 저장소에 없는 코인 종목: ${symbol}`);
  return dataset;
}
