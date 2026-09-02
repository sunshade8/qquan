/**
 * Paper-trading arithmetic.
 *
 * Without a ledger the loop never closes: a backtest says "pass", signals are
 * computed, and nothing records what actually happened — so the next backtest is
 * the same backtest and the system can never learn from experience. These are
 * the pure calculations; `lib/paper-ledger-store.ts` persists them.
 *
 * Fills are modelled pessimistically on purpose. A backtest executes at the next
 * close with a flat cost in basis points; a real fill crosses the spread and
 * moves the price. Charging the far side of the quoted spread plus the strategy's
 * own cost assumption is what makes live-vs-backtest divergence show up as a
 * number instead of a surprise.
 */

import { mean, round } from "./quant.ts";

export type PaperSide = "buy" | "sell";

export type FillEstimate = {
  fillPrice: number;
  slippageBps: number;
  costUsd: number;
};

/**
 * A buy lifts the ask, a sell hits the bid. When no quote is available the mid
 * is used and half the strategy's cost assumption stands in for the spread, so a
 * missing orderbook never makes a fill look free.
 */
export function estimateFill(
  side: PaperSide,
  quantity: number,
  referencePrice: number,
  quote: { bid?: number | null; ask?: number | null },
  costBps: number,
): FillEstimate {
  const bid = typeof quote.bid === "number" && quote.bid > 0 ? quote.bid : null;
  const ask = typeof quote.ask === "number" && quote.ask > 0 ? quote.ask : null;
  const crossed = side === "buy" ? ask : bid;
  const base = crossed ?? referencePrice;
  const assumedSpreadBps = crossed === null ? costBps / 2 : 0;
  const direction = side === "buy" ? 1 : -1;
  const fillPrice = round(base * (1 + (direction * assumedSpreadBps) / 10_000), 6)!;
  const slippageBps = referencePrice ? round(((fillPrice / referencePrice - 1) * 10_000) * direction, 2)! : 0;
  const costUsd = round((Math.abs(quantity) * fillPrice * costBps) / 10_000, 4)!;
  return { fillPrice, slippageBps, costUsd };
}

export type PositionState = { quantity: number; averagePrice: number; realizedPnlUsd: number };

/**
 * Applies a fill to a position, returning the new state and the P&L this fill
 * realised. Long-only: a sell beyond the held quantity closes what is held and
 * ignores the remainder rather than opening a short the engine cannot model.
 */
export function applyFill(position: PositionState, side: PaperSide, quantity: number, fillPrice: number, costUsd: number): { position: PositionState; realizedUsd: number } {
  const size = Math.abs(quantity);
  if (side === "buy") {
    const total = position.quantity + size;
    const averagePrice = total ? round((position.quantity * position.averagePrice + size * fillPrice) / total, 6)! : 0;
    return {
      position: { quantity: total, averagePrice, realizedPnlUsd: round(position.realizedPnlUsd - costUsd, 4)! },
      realizedUsd: round(-costUsd, 4)!,
    };
  }
  const closing = Math.min(size, position.quantity);
  const realized = round(closing * (fillPrice - position.averagePrice) - costUsd, 4)!;
  const remaining = round(position.quantity - closing, 8)!;
  return {
    position: {
      quantity: remaining,
      averagePrice: remaining ? position.averagePrice : 0,
      realizedPnlUsd: round(position.realizedPnlUsd + realized, 4)!,
    },
    realizedUsd: realized,
  };
}

export type MarkInput = { symbol: string; quantity: number; averagePrice: number; lastPrice: number | null };

/** Equity and unrealised P&L for a set of open positions; a position with no price is held at cost. */
export function markToMarket(positions: MarkInput[], cashUsd: number) {
  let marketValue = 0;
  let unrealized = 0;
  let unpriced = 0;
  for (const position of positions) {
    const price = position.lastPrice ?? position.averagePrice;
    if (position.lastPrice === null) unpriced += 1;
    marketValue += position.quantity * price;
    unrealized += position.quantity * (price - position.averagePrice);
  }
  return {
    equityUsd: round(cashUsd + marketValue, 4)!,
    marketValueUsd: round(marketValue, 4)!,
    unrealizedPnlUsd: round(unrealized, 4)!,
    unpricedPositions: unpriced,
  };
}

export type EquityPoint = { tradingDate: string; equityUsd: number; benchmarkReturnPct: number | null };

/**
 * Live-versus-backtest comparison.
 *
 * This is the number the whole ledger exists to produce. A strategy that
 * backtested at Sharpe 0.9 and papers at 0.3 has not been unlucky — its costs,
 * fills or regime assumptions were wrong, and only a recorded track record can
 * say so.
 */
export function paperPerformance(points: EquityPoint[], startingEquityUsd: number) {
  if (points.length < 2) {
    return { sessions: points.length, totalReturnPct: null, averageDailyPct: null, bestDayPct: null, worstDayPct: null, positiveDayRatePct: null, maxDrawdownPct: null, benchmarkReturnPct: null, excessPct: null };
  }
  const ordered = [...points].sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
  const daily: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1].equityUsd;
    if (previous > 0) daily.push((ordered[index].equityUsd / previous - 1) * 100);
  }
  let peak = ordered[0].equityUsd;
  let drawdown = 0;
  for (const point of ordered) {
    peak = Math.max(peak, point.equityUsd);
    if (peak > 0) drawdown = Math.min(drawdown, (point.equityUsd / peak - 1) * 100);
  }
  const benchmark = ordered.flatMap((point) => point.benchmarkReturnPct === null ? [] : [point.benchmarkReturnPct]);
  const benchmarkTotal = benchmark.length ? (benchmark.reduce((value, item) => value * (1 + item / 100), 1) - 1) * 100 : null;
  const totalReturn = startingEquityUsd > 0 ? (ordered.at(-1)!.equityUsd / startingEquityUsd - 1) * 100 : null;
  return {
    sessions: ordered.length,
    totalReturnPct: round(totalReturn),
    averageDailyPct: round(mean(daily), 4),
    bestDayPct: daily.length ? round(Math.max(...daily)) : null,
    worstDayPct: daily.length ? round(Math.min(...daily)) : null,
    positiveDayRatePct: daily.length ? round((daily.filter((value) => value > 0).length / daily.length) * 100, 1) : null,
    maxDrawdownPct: round(drawdown),
    benchmarkReturnPct: round(benchmarkTotal),
    excessPct: totalReturn !== null && benchmarkTotal !== null ? round(totalReturn - benchmarkTotal) : null,
  };
}
