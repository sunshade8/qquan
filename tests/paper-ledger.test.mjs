import assert from "node:assert/strict";
import test from "node:test";
import { applyFill, estimateFill, markToMarket, paperPerformance } from "../lib/paper-ledger.ts";

test("a buy crosses the ask and a sell hits the bid", () => {
  const buy = estimateFill("buy", 10, 100, { bid: 99.9, ask: 100.1 }, 5);
  assert.equal(buy.fillPrice, 100.1);
  const sell = estimateFill("sell", 10, 100, { bid: 99.9, ask: 100.1 }, 5);
  assert.equal(sell.fillPrice, 99.9);
});

test("a missing quote still charges an assumed spread rather than filling at the reference", () => {
  const buy = estimateFill("buy", 10, 100, {}, 10);
  assert.ok(buy.fillPrice > 100, "buy without a quote must not fill at or below the reference price");
  const sell = estimateFill("sell", 10, 100, { bid: null, ask: null }, 10);
  assert.ok(sell.fillPrice < 100, "sell without a quote must not fill at or above the reference price");
});

test("cost scales with notional and the strategy's own cost assumption", () => {
  const cheap = estimateFill("buy", 100, 50, { bid: 50, ask: 50 }, 5);
  const dear = estimateFill("buy", 100, 50, { bid: 50, ask: 50 }, 20);
  assert.ok(dear.costUsd > cheap.costUsd);
  assert.equal(cheap.costUsd, Number(((100 * 50 * 5) / 10_000).toFixed(4)));
});

test("buying twice averages the entry price and accrues cost", () => {
  let state = { quantity: 0, averagePrice: 0, realizedPnlUsd: 0 };
  ({ position: state } = applyFill(state, "buy", 10, 100, 1));
  ({ position: state } = applyFill(state, "buy", 10, 120, 1));
  assert.equal(state.quantity, 20);
  assert.equal(state.averagePrice, 110);
  assert.equal(state.realizedPnlUsd, -2);
});

test("selling realises P&L against the average price, net of cost", () => {
  let state = { quantity: 10, averagePrice: 100, realizedPnlUsd: 0 };
  const result = applyFill(state, "sell", 10, 110, 5);
  assert.equal(result.realizedUsd, 95); // 10 * (110 - 100) - 5
  assert.equal(result.position.quantity, 0);
  assert.equal(result.position.averagePrice, 0);
});

test("a long-only ledger closes what is held and ignores the excess", () => {
  const state = { quantity: 4, averagePrice: 100, realizedPnlUsd: 0 };
  const result = applyFill(state, "sell", 10, 110, 0);
  assert.equal(result.position.quantity, 0);
  assert.equal(result.realizedUsd, 40); // only the 4 shares actually held
});

test("markToMarket values open positions and flags any it could not price", () => {
  const marked = markToMarket([
    { symbol: "AAA", quantity: 10, averagePrice: 100, lastPrice: 110 },
    { symbol: "BBB", quantity: 5, averagePrice: 50, lastPrice: null },
  ], 1_000);
  assert.equal(marked.marketValueUsd, 10 * 110 + 5 * 50);
  assert.equal(marked.unrealizedPnlUsd, 100); // BBB held at cost contributes nothing
  assert.equal(marked.equityUsd, 1_000 + 1_350);
  assert.equal(marked.unpricedPositions, 1);
});

test("paperPerformance reports the live record against the benchmark", () => {
  const points = [
    { tradingDate: "2026-09-01", equityUsd: 10_000, benchmarkReturnPct: null },
    { tradingDate: "2026-09-02", equityUsd: 10_200, benchmarkReturnPct: 1 },
    { tradingDate: "2026-09-03", equityUsd: 10_100, benchmarkReturnPct: -0.5 },
  ];
  const result = paperPerformance(points, 10_000);
  assert.equal(result.sessions, 3);
  assert.equal(result.totalReturnPct, 1);
  assert.equal(result.positiveDayRatePct, 50);
  assert.ok(result.maxDrawdownPct < 0);
  assert.ok(result.excessPct !== null);
});

test("paperPerformance stays null rather than inventing a track record from one session", () => {
  const result = paperPerformance([{ tradingDate: "2026-09-01", equityUsd: 10_000, benchmarkReturnPct: null }], 10_000);
  assert.equal(result.totalReturnPct, null);
  assert.equal(result.maxDrawdownPct, null);
});
