/**
 * The fees this Binance account actually pays, read-only (GET only; no order, no setting changed).
 *   Spot     GET /api/v3/account/commission?symbol=…   standardCommission + taxCommission (+ discount fields, reported not applied)
 *   USDⓈ-M   GET /fapi/v1/commissionRate?symbol=…      makerCommissionRate / takerCommissionRate
 * A contract freezes max(official fee table, this reading) — see ctFreezeFees. A BNB discount is never assumed: the reading
 * is the standard rate and the discount flags are only reported. Failure (no keys, IP not allowed, network) is NOT an error
 * for a research start: the official table alone is frozen and the contract says the account could not be read. An
 * IP-restricted key failing is an IP problem before it is a credential problem (docs/toss-api.md has the same lesson for Toss).
 */
import { BinanceAPI, BinanceError, binanceSetting } from "./binance-api.ts";
import type { CTFeeProvenance } from "./ct-limit-execution.ts";

export type CTAccountFeeReading = { fees: CTFeeProvenance["account"]; note: string | null; discount?: { enabledForAccount: boolean; enabledForSymbol: boolean } };

const pct = (fraction: unknown) => Number(fraction) * 100;
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: CTAccountFeeReading }>();

/** Parse the two response shapes. Exported for tests (fixtures, no network). */
export function parseCommission(product: "spot" | "usdm", body: Record<string, unknown>, readAt: string): CTAccountFeeReading {
  if (product === "usdm") {
    const maker = pct(body.makerCommissionRate),
      taker = pct(body.takerCommissionRate);
    if (!Number.isFinite(maker) || !Number.isFinite(taker)) return { fees: null, note: "선물 수수료 응답 형식 오류" };
    return { fees: { makerPct: maker, takerPct: taker, readAt, endpoint: "GET /fapi/v1/commissionRate" }, note: null };
  }
  const standard = (body.standardCommission ?? {}) as Record<string, unknown>,
    tax = (body.taxCommission ?? {}) as Record<string, unknown>,
    discount = (body.discount ?? {}) as Record<string, unknown>;
  const maker = pct(standard.maker) + pct(tax.maker || 0),
    taker = pct(standard.taker) + pct(tax.taker || 0);
  if (!Number.isFinite(maker) || !Number.isFinite(taker)) return { fees: null, note: "현물 수수료 응답 형식 오류" };
  return {
    fees: { makerPct: maker, takerPct: taker, readAt, endpoint: "GET /api/v3/account/commission" },
    note: null,
    discount: { enabledForAccount: discount.enabledForAccount === true, enabledForSymbol: discount.enabledForSymbol === true },
  };
}

export async function ctReadAccountFees(product: "spot" | "usdm", symbol: string, now = () => Date.now()): Promise<CTAccountFeeReading> {
  const key = `${product}:${symbol}`,
    hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_MS) return hit.value;
  let value: CTAccountFeeReading;
  try {
    if (!binanceSetting("BINANCE_API_KEY") || !binanceSetting("BINANCE_API_SECRET")) value = { fees: null, note: "Binance 자격증명 없음" };
    else {
      const api = new BinanceAPI(product, binanceSetting("BINANCE_NETWORK") === "testnet" ? "testnet" : "mainnet");
      const body = await Promise.race([
        (async () => {
          await api.syncTime();
          return api.read("commission", { symbol });
        })(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("수수료 조회 시간 초과")), 8000)),
      ]);
      value = parseCommission(product, body as Record<string, unknown>, new Date(now()).toISOString());
    }
  } catch (e) {
    value = { fees: null, note: e instanceof BinanceError ? `Binance ${e.status}/${e.code} — 허용 IP 확인` : e instanceof Error ? e.message : "조회 실패" };
  }
  cache.set(key, { at: now(), value });
  return value;
}
