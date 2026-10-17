/**
 * Order parameters for the limit-only execution (docs/prompts/binance-only-limit-orders.md §3.1). Pure: builds the request
 * body, sends nothing. Mandatory parameters per type are from the Spot REST reference (read 2026-10-17):
 *   LIMIT            timeInForce, quantity, price
 *   LIMIT_MAKER      quantity, price            (post-only: rejected instead of taking liquidity; no timeInForce)
 *   STOP_LOSS_LIMIT  timeInForce, quantity, price, stopPrice
 *   MARKET           quantity                   (the single emergency exception)
 * USDⓈ-M: LIMIT + timeInForce GTX (post-only). Conditional orders there use /fapi/v1/algoOrder and are NOT built here.
 * Quantity and prices go through the symbol's LOT_SIZE / PRICE_FILTER / NOTIONAL filters (binanceQuantize), never raw floats.
 */
import Decimal from "decimal.js";
import { binancePositionParams, binanceQuantize, type BinanceFilter } from "./binance-api.ts";

export type OrderKind = "limit_maker" | "limit" | "stop_loss_limit" | "market";

export function binanceSpotOrderParams(input: {
  symbol: string;
  side: "buy" | "sell";
  kind: OrderKind;
  quantity: number;
  /** Limit price (ignored for market). */
  price: number;
  stopPrice?: number;
  clientOrderId: string;
  filters: BinanceFilter[];
  /** For the notional filter of a market order, which has no price of its own. */
  referencePrice?: number;
}) {
  const { symbol, side, kind, clientOrderId, filters } = input;
  const p = binanceQuantize(String(input.quantity), String(kind === "market" ? (input.referencePrice ?? input.price) : input.price), filters, input.quantity * (kind === "market" ? (input.referencePrice ?? input.price) : input.price) + 1);
  const base = { symbol, side: side.toUpperCase(), newClientOrderId: clientOrderId };
  switch (kind) {
    case "limit_maker":
      return { ...base, type: "LIMIT_MAKER", quantity: p.quantity, price: p.price };
    case "limit":
      return { ...base, type: "LIMIT", timeInForce: "GTC", quantity: p.quantity, price: p.price };
    case "stop_loss_limit": {
      if (!(input.stopPrice! > 0)) throw new Error("STOP_LOSS_LIMIT에는 stopPrice 필요");
      const stop = binanceQuantize(String(input.quantity), String(input.stopPrice), filters, input.quantity * input.stopPrice + 1).price;
      // A sell stop-limit's limit may not be above its trigger.
      if (side === "sell" && new Decimal(p.price).gt(stop)) throw new Error("매도 STOP_LOSS_LIMIT의 가격이 stopPrice보다 높음");
      return { ...base, type: "STOP_LOSS_LIMIT", timeInForce: "GTC", quantity: p.quantity, price: p.price, stopPrice: stop };
    }
    case "market":
      return { ...base, type: "MARKET", quantity: p.quantity };
  }
}

/** USDⓈ-M limit order, post-only (GTX). One-way vs hedge position parameters follow binancePositionParams. */
export function binanceUsdmOrderParams(input: {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  clientOrderId: string;
  filters: BinanceFilter[];
  positionMode: "one-way" | "hedge";
  positionSide: "LONG" | "SHORT";
  closing: boolean;
  postOnly?: boolean;
}) {
  const p = binanceQuantize(String(input.quantity), String(input.price), input.filters, input.quantity * input.price + 1);
  return {
    symbol: input.symbol,
    side: input.side.toUpperCase(),
    type: "LIMIT",
    timeInForce: input.postOnly === false ? "GTC" : "GTX",
    quantity: p.quantity,
    price: p.price,
    newClientOrderId: input.clientOrderId,
    ...binancePositionParams(input.positionMode, input.positionSide, input.closing, "LIMIT"),
  };
}
