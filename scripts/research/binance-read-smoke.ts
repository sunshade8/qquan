/** Read-only. Never prints balances, positions, keys, signed URLs or exchange error bodies. */
import { ctRecordReadCapabilities } from "../../lib/ct-capability-store.ts";
import { writeFileSync } from "node:fs";
import {
  BinanceAPI,
  BinanceError,
  binanceSetting,
  type BinanceRead,
} from "../../lib/binance-api.ts";
const checks: Array<{product:string;op:string;status:string}&Record<string, unknown>> = [];
for (const product of [
  "spot",
  "margin-cross",
  "margin-isolated",
  "usdm",
  "coinm",
  "options",
] as const) {
  const api = new BinanceAPI(product, "mainnet");
  for (const op of [
    "time",
    "exchangeInfo",
    "account",
    "commission",
    ...(["usdm", "coinm"].includes(product)
      ? ["brackets", "mark", "funding"]
      : []),
    ...(product === "spot" ? ["permissions", "portfolio", "portfolioPro"] : []),
  ] as BinanceRead[]) {
    try {
      if (op === "account") await api.syncTime();
      const params: Record<string, string> =
        op === "account" && product === "margin-isolated"
          ? { symbols: "BTCUSDT" }
          : ["commission", "brackets", "mark", "funding"].includes(op)
            ? { symbol: product === "coinm" ? "BTCUSD_PERP" : "BTCUSDT" }
            : {};
      const r = await api.read(op, params);
      checks.push({
        product,
        op,
        status: "ok",
        ...(op === "permissions"
          ? {
              enableReading: r.enableReading,
              enableSpotAndMarginTrading: r.enableSpotAndMarginTrading,
              enableFutures: r.enableFutures,
              enableMargin: r.enableMargin,
              enablePortfolioMarginTrading: r.enablePortfolioMarginTrading,
            }
          : {}),
        ...(op === "exchangeInfo"
          ? { symbols: Array.isArray(r.symbols) ? r.symbols.length : null }
          : {}),
      });
    } catch (e) {
      checks.push({
        product,
        op,
        status: e instanceof BinanceError ? `http_${e.status}` : "error",
        code: e instanceof BinanceError ? e.code : null,
        reason:
          e instanceof BinanceError
            ? e.message
            : "조회 실패/자격증명 확인 필요",
      });
    }
  }
}
const report = {
  at: new Date().toISOString(),
  financialMutations: 0,
  liveLocked: binanceSetting("BINANCE_TRADING_DISABLED") !== "false",
  testnetCredentialPresent: Boolean(
    binanceSetting("BINANCE_TESTNET_API_KEY") &&
      binanceSetting("BINANCE_TESTNET_API_SECRET"),
  ),
  checks,
};
writeFileSync(
  "docs/research/ct-binance-read-2026-10-16.json",
  JSON.stringify(report, null, 2) + "\n",
);
await ctRecordReadCapabilities(report);
console.log(JSON.stringify(report));
