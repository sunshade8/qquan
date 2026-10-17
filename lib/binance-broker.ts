import {
  BinanceAPI,
  BinanceError,
  binanceSetting,
  binanceKline,
  type BinanceFilter,
} from "./binance-api.ts";
import {
  BrokerRejection,
  type DashboardBroker,
  type BrokerQuote,
} from "./trading-engine.ts";
import type { DashboardOrder } from "./dashboard-types.ts";
import { binanceSpotOrderParams } from "./binance-orders.ts";
import type { CTBar } from "./ct-engine.ts";
const api = () =>
  new BinanceAPI(
    "spot",
    binanceSetting("BINANCE_NETWORK") === "testnet" ? "testnet" : "mainnet",
  );
export async function binanceQuote(symbol: string): Promise<BrokerQuote> {
  if (!["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(symbol))
    throw new Error("선택 Binance 기초자산 밖의 symbol");
  const r = await api().read("bookTicker", { symbol }),
    bid = Number(r.bidPrice),
    ask = Number(r.askPrice);
  if (!(bid > 0 && ask >= bid)) throw new Error("Binance 비정상 호가");
  const at = new Date().toISOString();
  return { price: (bid + ask) / 2, bid, ask, timestamp: at, bookTimestamp: at };
}
/** Public one-minute candles of a pair from `sinceMs` on (paper limit fills judge resting orders against them). */
export async function binanceCandlesSince(symbol: string, sinceMs: number): Promise<CTBar[]> {
  if (!["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(symbol)) throw new Error("선택 Binance 기초자산 밖의 symbol");
  const rows = (await api().read("klines", { symbol, interval: "1m", startTime: Math.floor(sinceMs / 60000) * 60000, limit: 1000 })) as unknown as unknown[][];
  return rows.map((r) => binanceKline(r)).filter((b) => b.endMs <= Date.now());
}
type Account = {
  balances: Array<{ asset: string; free: string }>;
  canTrade: boolean;
};
type Order = {
  orderId: number;
  status: string;
  executedQty: string;
  cummulativeQuoteQty: string;
};
export function binanceSpotBroker(): DashboardBroker & {
  recover: (order: DashboardOrder) => Promise<string | null>;
} {
  const client = api();
  let synced = false;
  const sync = async () => {
    if (!synced) {
      await client.syncTime();
      synced = true;
    }
  };
  return {
    mode: "live",
    quote: binanceQuote,
    async submit(r) {
      await sync();
      // An ambiguous intent is never retransmitted; the engine polls recover() until reconciled.
      const info = (await client.read("exchangeInfo", {
          symbol: r.symbol,
        })) as unknown as {
          symbols: Array<{ symbol: string; filters: BinanceFilter[] }>;
        },
        filters = info.symbols.find((s) => s.symbol === r.symbol)?.filters;
      if (!filters)
        throw new BrokerRejection("Binance instrument 미확인", "instrument");
      // Limit-only (docs/ct.md): entries/targets LIMIT_MAKER, other sells LIMIT GTC, the single emergency exit MARKET.
      const params = binanceSpotOrderParams({
        symbol: r.symbol,
        side: r.side,
        kind: r.orderType ?? "limit",
        quantity: r.quantity,
        price: r.limitPrice ?? r.referencePrice,
        stopPrice: r.stopPrice,
        referencePrice: r.referencePrice,
        clientOrderId: r.clientOrderId,
        filters,
      });
      try {
        const order = await client.mutate("order", params);
        return { brokerOrderId: String(order.orderId) };
      } catch (e) {
        if (
          e instanceof BinanceError &&
          !e.ambiguous &&
          e.status >= 400 &&
          e.status < 500 &&
          ![408, 418, 429].includes(e.status)
        )
          throw new BrokerRejection(e.message, String(e.code));
        throw e;
      }
    },
    async recover(order) {
      await sync();
      try {
        return String(
          (
            await client.read("order", {
              symbol: order.symbol,
              origClientOrderId: order.clientOrderId,
            })
          ).orderId,
        );
      } catch (e) {
        if (e instanceof BinanceError && e.code === -2013) return null;
        throw e;
      }
    },
    async poll(order) {
      await sync();
      const r = (await client.read("order", {
        symbol: order.symbol,
        origClientOrderId: order.clientOrderId,
      })) as unknown as Order;
      const trades = (await client.read("trades", {
        symbol: order.symbol,
        orderId: r.orderId,
      })) as unknown as Array<{ commission: string; commissionAsset: string }>;
      // A commission in BNB/base needs an observed conversion; fail closed rather than mislabel native money USDT.
      if (
        trades.some(
          (t) => t.commissionAsset !== "USDT" && Number(t.commission) > 0,
        )
      )
        throw new Error("수수료 자산 환산·대사 필요");
      const quantity = Number(r.executedQty);
      return {
        status:
          r.status === "FILLED"
            ? "filled"
            : ["CANCELED", "EXPIRED", "EXPIRED_IN_MATCH"].includes(r.status)
              ? "canceled"
              : r.status === "REJECTED"
                ? "rejected"
                : "working",
        filledQuantity: quantity,
        averageFillPrice:
          quantity > 0 ? Number(r.cummulativeQuoteQty) / quantity : null,
        commissionUsd: trades.reduce((s, t) => s + Number(t.commission), 0),
      };
    },
    async cancel(order) {
      await sync();
      await client.mutate("cancel", {
        symbol: order.symbol,
        origClientOrderId: order.clientOrderId,
      });
    },
    async buyingPowerUsd() {
      await sync();
      const r = (await client.read("account")) as unknown as Account;
      return Number(r.balances.find((b) => b.asset === "USDT")?.free ?? 0);
    },
    async sellableQuantity(symbol) {
      await sync();
      const r = (await client.read("account")) as unknown as Account;
      return Number(
        r.balances.find((b) => b.asset === symbol.replace(/USDT$/, ""))?.free ??
          0,
      );
    },
    async entryProblem(symbol) {
      if (binanceSetting("BINANCE_TRADING_DISABLED") !== "false")
        return "Binance 실주문 잠금";
      await sync();
      const [orders, account, commission] = await Promise.all([
        client.read("openOrders", { symbol }),
        client.read("account"),
        client.read("commission", { symbol }),
      ]);
      if ((orders as unknown as unknown[]).length)
        return "Binance 계좌 미체결 주문 대사 필요";
      if (!(account as unknown as Account).canTrade)
        return "Binance 계좌 거래 권한 없음";
      const rates = commission.standardCommission as { taker?: string };
      if (!rates?.taker || Number(rates.taker) > 0.001)
        return "실제 수수료와 계약 비용 재검증 필요";
      return null;
    },
  };
}
