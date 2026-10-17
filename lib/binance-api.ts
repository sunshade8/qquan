/** Fixed-host, typed Binance REST adapter. Credentials never cross the local runner boundary. */
import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import type { CTProduct } from "./ct-capabilities.ts";
export const binanceSetting = (name: string) =>
  (env as unknown as Record<string, string | undefined>)[name] ??
  process.env[name];
export class BinanceError extends Error {
  status: number;
  code: number;
  ambiguous: boolean;
  retryAt: number | null;
  constructor(
    status: number,
    code: number,
    ambiguous = false,
    retryAt: number | null = null,
  ) {
    super(
      `Binance HTTP ${status} / code ${code}${ambiguous ? " · 주문 대사 필요" : ""}`,
    );
    this.status = status;
    this.code = code;
    this.ambiguous = ambiguous;
    this.retryAt = retryAt;
  }
}
export async function binanceHmac(secret: string, message: string) {
  const enc = new TextEncoder(),
    key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
type Product = Exclude<CTProduct, "stock">;
const endpoints = {
  spot: {
    host: "https://api.binance.com",
    test: "https://testnet.binance.vision",
    prefix: "/api/v3",
    account: "/api/v3/account",
    commission: "/api/v3/account/commission",
  },
  "margin-cross": {
    host: "https://api.binance.com",
    test: null,
    prefix: "/api/v3",
    account: "/sapi/v1/margin/account",
    commission: "/sapi/v1/asset/tradeFee",
  },
  "margin-isolated": {
    host: "https://api.binance.com",
    test: null,
    prefix: "/api/v3",
    account: "/sapi/v1/margin/isolated/account",
    commission: "/sapi/v1/asset/tradeFee",
  },
  usdm: {
    host: "https://fapi.binance.com",
    test: "https://demo-fapi.binance.com",
    prefix: "/fapi/v1",
    account: "/fapi/v3/account",
    commission: "/fapi/v1/commissionRate",
  },
  coinm: {
    host: "https://dapi.binance.com",
    test: "https://testnet.binancefuture.com",
    prefix: "/dapi/v1",
    account: "/dapi/v1/account",
    commission: "/dapi/v1/commissionRate",
  },
  options: {
    host: "https://eapi.binance.com",
    test: null,
    prefix: "/eapi/v1",
    account: "/eapi/v1/marginAccount",
    commission: "/eapi/v1/commission",
  },
} as const;
export type BinanceRead =
  | "time"
  | "exchangeInfo"
  | "klines"
  | "bookTicker"
  | "account"
  | "commission"
  | "order"
  | "openOrders"
  | "trades"
  | "brackets"
  | "funding"
  | "mark"
  | "permissions"
  | "portfolio"
  | "portfolioPro";
export class BinanceAPI {
  skew = 0;
  blockedUntil = 0;
  readonly product: Product;
  readonly network: "mainnet" | "testnet";
  private fetcher: typeof fetch;
  constructor(
    product: Product = "spot",
    network: "mainnet" | "testnet" = "mainnet",
    fetcher: typeof fetch = fetch,
  ) {
    this.product = product;
    this.network = network;
    this.fetcher = fetcher;
  }
  private credentials() {
    const prefix = this.network === "testnet" ? "BINANCE_TESTNET_" : "BINANCE_";
    const key = binanceSetting(prefix + "API_KEY"),
      secret = binanceSetting(prefix + "API_SECRET");
    if (!key || !secret)
      throw new Error("Binance " + this.network + " 자격증명 없음");
    return { key, secret };
  }
  private async request(
    path: string,
    params: Record<string, string | number | boolean>,
    signed: boolean,
    method = "GET",
  ) {
    if (Date.now() < this.blockedUntil)
      throw new BinanceError(429, -1003, false, this.blockedUntil);
    const ep = endpoints[this.product],
      host = path.startsWith("/papi/")
        ? this.network === "mainnet"
          ? "https://papi.binance.com"
          : null
        : this.network === "testnet"
          ? ep.test
          : ep.host;
    if (!host) throw new Error("이 상품의 test/demo 환경 미설정");
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    const headers: Record<string, string> = {};
    if (signed) {
      const { key, secret } = this.credentials();
      q.set("timestamp", String(Math.round(Date.now() + this.skew)));
      q.set("recvWindow", "5000");
      q.set("signature", await binanceHmac(secret, q.toString()));
      headers["X-MBX-APIKEY"] = key;
    }
    let response: Response;
    try {
      response = await this.fetcher(host + path + "?" + q, {
        method,
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new BinanceError(0, -1007, method !== "GET");
    }
    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new BinanceError(
        response.status,
        -1,
        method !== "GET" && response.status >= 500,
      );
    }
    if (!response.ok) {
      const retry =
        response.status === 429 || response.status === 418
          ? Date.now() +
            Math.max(1, Number(response.headers.get("retry-after") ?? 60)) *
              1000
          : null;
      if (retry) this.blockedUntil = retry;
      throw new BinanceError(
        response.status,
        Number(data.code ?? 0),
        method !== "GET" &&
          (response.status >= 500 || Number(data.code) === -1007),
        retry,
      );
    }
    return data;
  }
  async read(
    op: BinanceRead,
    params: Record<string, string | number | boolean> = {},
  ) {
    const e = endpoints[this.product];
    let path: string,
      signed = true;
    switch (op) {
      case "time":
      case "exchangeInfo":
      case "klines":
        path = e.prefix + "/" + op;
        signed = false;
        break;
      case "bookTicker":
        path = e.prefix + "/ticker/bookTicker";
        signed = false;
        break;
      case "account":
        path = e.account;
        break;
      case "commission":
        path = e.commission;
        break;
      case "permissions":
        path = "/sapi/v1/account/apiRestrictions";
        if (this.product !== "spot")
          throw new Error("Spot wallet 권한 조회만 허용");
        break;
      case "order":
      case "openOrders":
        path = this.product.startsWith("margin")
          ? "/sapi/v1/margin/" + op
          : e.prefix + "/" + op;
        break;
      case "trades":
        path =
          e.prefix + (this.product === "spot" ? "/myTrades" : "/userTrades");
        break;
      case "brackets":
        if (!["usdm", "coinm"].includes(this.product))
          throw new Error("선물 bracket 전용");
        path = e.prefix + "/leverageBracket";
        break;
      case "funding":
      case "mark":
        if (!["usdm", "coinm"].includes(this.product))
          throw new Error("선물 데이터 전용");
        path = e.prefix + (op === "funding" ? "/fundingRate" : "/premiumIndex");
        signed = false;
        break;
      case "portfolio":
        path = "/papi/v1/account";
        break;
      case "portfolioPro":
        path = "/sapi/v1/portfolio/account";
        break;
    }
    return this.request(path, params, signed);
  }
  async syncTime() {
    const started = Date.now(),
      r = await this.read("time");
    this.skew = Number(r.serverTime) - (started + Date.now()) / 2;
    if (!Number.isFinite(this.skew)) throw new Error("서버 시각 오류");
    return this.skew;
  }
  /**
   * POST /api/v3/order/test — validates an order against the exchange's rules and filters; it is never placed and is NOT
   * evidence of a fill. Spot only. Allowed while BINANCE_TRADING_DISABLED because it cannot change the account.
   */
  async testOrder(params: Record<string, string | number | boolean>) {
    if (this.product !== "spot") throw new Error("order/test는 Spot 전용");
    return this.request("/api/v3/order/test", params, true, "POST");
  }
  /** Every financial mutation is locked by default, including configuration and debt changes. */
  async mutate(
    op:
      | "order"
      | "cancel"
      | "algoOrder"
      | "leverage"
      | "marginType"
      | "positionMode"
      | "multiAsset"
      | "borrowRepay",
    params: Record<string, string | number | boolean>,
  ) {
    if (binanceSetting("BINANCE_TRADING_DISABLED") !== "false")
      throw new Error("BINANCE_TRADING_DISABLED · 실주문 잠금");
    if (binanceSetting("QQUAN_RUNTIME") !== "node")
      throw new Error("로컬 실행기만 Binance 재정 변경 가능");
    const e = endpoints[this.product];
    let path: string,
      method = "POST";
    switch (op) {
      case "order":
        path = this.product.startsWith("margin")
          ? "/sapi/v1/margin/order"
          : e.prefix + "/order";
        break;
      case "cancel":
        path = this.product.startsWith("margin")
          ? "/sapi/v1/margin/order"
          : e.prefix + "/order";
        method = "DELETE";
        break;
      case "algoOrder":
        if (this.product !== "usdm") throw new Error("조건부 어댑터 미검증");
        path = "/fapi/v1/algoOrder";
        break;
      case "borrowRepay":
        if (!this.product.startsWith("margin")) throw new Error("Margin 전용");
        path = "/sapi/v1/margin/borrow-repay";
        break;
      default:
        if (!["usdm", "coinm"].includes(this.product))
          throw new Error("선물 설정 전용");
        path =
          e.prefix +
          "/" +
          {
            positionMode: "positionSide/dual",
            multiAsset: "multiAssetsMargin",
            leverage: "leverage",
            marginType: "marginType",
          }[op];
    }
    return this.request(path, params, true, method);
  }
}
export type BinanceFilter = {
  filterType: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  minNotional?: string;
  maxNotional?: string;
};
export function binanceQuantize(
  quantity: string,
  price: string,
  filters: BinanceFilter[],
  maxNotional: number,
) {
  let q = new Decimal(quantity),
    p = new Decimal(price);
  if (!q.gt(0) || !p.gt(0)) throw new Error("수량/가격 오류");
  for (const f of filters) {
    if (f.filterType === "LOT_SIZE" && f.stepSize) {
      q = q.div(f.stepSize).floor().mul(f.stepSize);
      if (q.lt(f.minQty ?? 0) || q.gt(f.maxQty ?? "1e100"))
        throw new Error("LOT_SIZE");
    }
    if (f.filterType === "PRICE_FILTER" && f.tickSize) {
      p = p.div(f.tickSize).floor().mul(f.tickSize);
      if (p.lt(f.minPrice ?? 0) || p.gt(f.maxPrice ?? "1e100"))
        throw new Error("PRICE_FILTER");
    }
  }
  const n = q.mul(p);
  if (n.gt(maxNotional)) throw new Error("명목 위험 한도");
  for (const f of filters)
    if (
      ["NOTIONAL", "MIN_NOTIONAL"].includes(f.filterType) &&
      (n.lt(f.minNotional ?? 0) || n.gt(f.maxNotional ?? "1e100"))
    )
      throw new Error("NOTIONAL");
  if (!q.gt(0)) throw new Error("수량 0");
  return { quantity: q.toFixed(), price: p.toFixed() };
}
export function binancePositionParams(
  mode: "one-way" | "hedge",
  positionSide: "LONG" | "SHORT",
  closing: boolean,
  type: string,
) {
  if (mode === "hedge") return { positionSide };
  return {
    positionSide: "BOTH",
    ...(closing ? { reduceOnly: true } : {}),
    ...(type === "MARKET" ? {} : {}),
  };
}
export function binanceKline(row: unknown[], unit: "ms" | "us" = "ms") {
  const n = (i: number) => Number(row[i]),
    start = n(0) / (unit === "us" ? 1000 : 1);
  return {
    startMs: start,
    endMs: start + 60000,
    open: n(1),
    high: n(2),
    low: n(3),
    close: n(4),
    volume: n(5),
  };
}
/** A gap invalidates local depth. REST reseeding must happen before quote acceptance. */
export function binanceDepthStep(
  last: number,
  event: { first: number; last: number; previous?: number },
) {
  if (event.last <= last) return { last, accepted: false, resync: false };
  if (
    event.previous !== undefined
      ? event.previous !== last
      : event.first > last + 1
  )
    return { last, accepted: false, resync: true };
  return { last: event.last, accepted: true, resync: false };
}
