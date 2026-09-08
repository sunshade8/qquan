/**
 * Replays a `TradeStrategy` over historical bars by calling the same `plan()`
 * the live endpoint calls.
 *
 * Two things the engine does and the rule does not, because they are the
 * broker's job rather than a decision:
 *
 * 1. **Fill convention.** A plan made on `asOf`'s close fills at the *next*
 *    session's close, which is what a market-on-close order submitted after the
 *    signal would get. Nothing fills on the bar that produced it.
 * 2. **Resting stops.** An entry carries a `stopPrice`, and a stop is an order
 *    left at the broker, not a daily decision — so it fills intrabar at the stop
 *    on the first session that trades through it. `plan()` still re-checks the
 *    stop each run as a safety net for the case where no stop order was placed;
 *    that check is a no-op whenever the resting stop already fired.
 *
 * Costs come from `lib/broker-costs.ts` and are charged on both sides.
 */

import type { Bar } from "./quant.ts";
import { COST_PER_SIDE_PCT, type PlannedOrder, type StrategyPosition, type TradeStrategy } from "./trade-strategies.ts";

export type ReplayFill = {
  date: string; symbol: string; side: "buy" | "sell"; quantity: number;
  price: number; costUsd: number; rule: string; reason: string;
};

export type ReplayTrade = {
  symbol: string; entryDate: string; exitDate: string; quantity: number;
  entryPrice: number; exitPrice: number; sessions: number;
  grossPct: number; netPct: number; netUsd: number; exit: string;
};

export type ReplayMetrics = {
  trades: number; winRatePct: number | null; avgNetPct: number | null; medianNetPct: number | null;
  avgWinPct: number | null; avgLossPct: number | null; payoff: number | null;
  totalReturnPct: number | null; maxDrawdownPct: number | null;
  activeDays: number; activeDayPct: number | null; exposurePct: number | null;
  benchmarkReturnPct: number | null; costPaidUsd: number;
};

export type ReplayResult = {
  strategyId: string; strategyName: string;
  from: string; to: string; sessions: number;
  startingCapitalUsd: number; endingEquityUsd: number;
  fills: ReplayFill[]; trades: ReplayTrade[];
  equityCurve: Array<{ date: string; equity: number; benchmark: number | null }>;
  openPositions: Array<{ symbol: string; quantity: number; averagePrice: number; entryDate: string; lastPrice: number; unrealizedUsd: number }>;
  metrics: ReplayMetrics;
  costPerSidePct: number;
  skippedSample: Array<{ date: string; symbol: string; reason: string }>;
};

type Lot = { symbol: string; quantity: number; averagePrice: number; entryDate: string; entryIndex: number; stopPrice: number | null };

function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const round = (value: number, digits = 4) => Number(value.toFixed(digits));

/** Every session any universe symbol traded, ascending. */
export function sessionCalendar(bars: Record<string, Bar[]>) {
  const dates = new Set<string>();
  for (const series of Object.values(bars)) for (const bar of series) dates.add(bar.date);
  return [...dates].sort();
}

/**
 * How many sessions a position will have been held when the next order fills.
 *
 * The ledger stamps a fill with the wall-clock date, which is routinely *not* a
 * session in the loaded bars — an order recorded on a Saturday, or after today's
 * close but before that bar exists. Treating those as "not found" and calling
 * them infinitely old is what makes a rule sell everything it just bought, so
 * each case is resolved explicitly:
 *
 * - entry on a known session -> sessions between it and the fill
 * - entry newer than the last known session -> 0, it has not been held yet
 * - entry on a non-session date inside the window -> the next session after it
 * - entry older than the whole window -> effectively infinite, so a stale
 *   position exits rather than resting forever
 */
export function sessionsHeldAtFill(calendar: string[], openedAt: string, fillIndex: number) {
  if (!calendar.length) return 0;
  if (openedAt > calendar[calendar.length - 1]) return 0;
  if (openedAt < calendar[0]) return Number.MAX_SAFE_INTEGER;
  let index = calendar.indexOf(openedAt);
  if (index < 0) index = calendar.findIndex((date) => date >= openedAt);
  if (index < 0) return 0;
  return Math.max(0, fillIndex - index);
}

export function replayStrategy(
  strategy: TradeStrategy,
  bars: Record<string, Bar[]>,
  options: { from: string; to: string; capitalUsd: number; benchmark?: Bar[] | null },
): ReplayResult {
  const calendar = sessionCalendar(bars).filter((date) => date <= options.to);
  const byDate: Record<string, Map<string, Bar>> = {};
  for (const [symbol, series] of Object.entries(bars)) {
    for (const bar of series) (byDate[symbol] ??= new Map()).set(bar.date, bar);
  }
  const barAt = (symbol: string, date: string) => byDate[symbol]?.get(date) ?? null;

  // A moving cutoff per symbol: rebuilding the visible history with a filter on
  // every session is O(sessions x symbols x bars), which is fine for a 60-day
  // window and not fine for eleven years inside a Worker's CPU budget.
  const cutoff: Record<string, number> = {};
  for (const symbol of Object.keys(bars)) cutoff[symbol] = 0;

  const startIndex = Math.max(strategy.warmupSessions, calendar.findIndex((date) => date >= options.from));
  const lots: Lot[] = [];
  const fills: ReplayFill[] = [];
  const trades: ReplayTrade[] = [];
  const equityCurve: ReplayResult["equityCurve"] = [];
  const skippedSample: ReplayResult["skippedSample"] = [];
  const entryDates = new Set<string>();
  let cash = options.capitalUsd;
  let costPaid = 0;
  let exposedSessions = 0;

  const benchmarkBase = options.benchmark?.find((bar) => bar.date >= options.from)?.close ?? null;

  function sell(lot: Lot, date: string, price: number, exit: string, reason: string) {
    const gross = lot.quantity * price;
    const cost = (gross * COST_PER_SIDE_PCT) / 100;
    cash += gross - cost;
    costPaid += cost;
    fills.push({ date, symbol: lot.symbol, side: "sell", quantity: lot.quantity, price: round(price, 6), costUsd: round(cost, 4), rule: exit, reason });
    const entryCost = (lot.quantity * lot.averagePrice * COST_PER_SIDE_PCT) / 100;
    const netUsd = gross - cost - (lot.quantity * lot.averagePrice + entryCost);
    const grossPct = (price / lot.averagePrice - 1) * 100;
    trades.push({
      symbol: lot.symbol, entryDate: lot.entryDate, exitDate: date, quantity: lot.quantity,
      entryPrice: round(lot.averagePrice, 6), exitPrice: round(price, 6),
      sessions: calendar.indexOf(date) - lot.entryIndex,
      grossPct: round(grossPct, 4), netPct: round(grossPct - COST_PER_SIDE_PCT * 2, 4),
      netUsd: round(netUsd, 2), exit,
    });
  }

  for (let index = startIndex; index < calendar.length; index += 1) {
    const asOf = calendar[index];
    const fillDate = calendar[index + 1] ?? null;

    // 1. Resting stops fill first, intrabar, on this session.
    for (let position = lots.length - 1; position >= 0; position -= 1) {
      const lot = lots[position];
      if (lot.stopPrice === null || lot.entryIndex >= index) continue;
      const bar = barAt(lot.symbol, asOf);
      if (!bar || bar.low > lot.stopPrice) continue;
      // A gap straight through the stop fills at the open, not at the stop.
      const price = Math.min(lot.stopPrice, bar.open);
      sell(lot, asOf, price, "stop", `상시 스탑 체결 (저가 ${bar.low} ≤ ${lot.stopPrice})`);
      lots.splice(position, 1);
    }

    if (lots.length) exposedSessions += 1;

    // 2. Mark to market for the equity curve.
    const marked = lots.reduce((sum, lot) => sum + lot.quantity * (barAt(lot.symbol, asOf)?.close ?? lot.averagePrice), 0);
    const benchmarkBar = options.benchmark?.find((bar) => bar.date === asOf);
    equityCurve.push({
      date: asOf, equity: round(cash + marked, 2),
      benchmark: benchmarkBase && benchmarkBar ? round((benchmarkBar.close / benchmarkBase) * options.capitalUsd, 2) : null,
    });

    if (!fillDate) break;

    // 3. The rule decides, seeing only bars up to `asOf`.
    const visible: Record<string, Bar[]> = {};
    for (const [symbol, series] of Object.entries(bars)) {
      let end = cutoff[symbol];
      while (end < series.length && series[end].date <= asOf) end += 1;
      cutoff[symbol] = end;
      visible[symbol] = series.slice(0, end);
    }
    const positions: StrategyPosition[] = lots.map((lot) => ({
      symbol: lot.symbol, quantity: lot.quantity, averagePrice: lot.averagePrice,
      entryDate: lot.entryDate, sessionsAtFill: calendar.indexOf(fillDate) - lot.entryIndex,
    }));
    const plan = strategy.plan({ asOf, bars: visible, positions, capitalUsd: cash + marked });
    for (const item of plan.skipped.slice(0, 2)) skippedSample.push({ date: asOf, symbol: item.symbol, reason: item.reason });

    // 4. Fill at the next session's close.
    for (const order of plan.orders as PlannedOrder[]) {
      const bar = barAt(order.symbol, fillDate);
      if (!bar) continue;
      if (order.side === "sell") {
        const position = lots.findIndex((lot) => lot.symbol === order.symbol);
        if (position < 0) continue;
        sell(lots[position], fillDate, bar.close, order.rule, order.reason);
        lots.splice(position, 1);
        continue;
      }
      // Re-price on the fill bar: the plan sized from `asOf`'s close, but the
      // cash actually leaving the account is this bar's close.
      const quantity = Math.min(order.quantity, Math.floor(cash / (bar.close * (1 + COST_PER_SIDE_PCT / 100))));
      if (quantity < 1) continue;
      const gross = quantity * bar.close;
      const cost = (gross * COST_PER_SIDE_PCT) / 100;
      cash -= gross + cost;
      costPaid += cost;
      entryDates.add(fillDate);
      fills.push({ date: fillDate, symbol: order.symbol, side: "buy", quantity, price: round(bar.close, 6), costUsd: round(cost, 4), rule: order.rule, reason: order.reason });
      lots.push({
        symbol: order.symbol, quantity, averagePrice: bar.close, entryDate: fillDate,
        entryIndex: calendar.indexOf(fillDate),
        // The plan's stop was a fraction of its own reference price; keep that
        // fraction against the price actually paid.
        stopPrice: order.stopPrice === null ? null : round(bar.close * (order.stopPrice / order.referencePrice), 6),
      });
    }
  }

  const lastDate = calendar.at(-1) ?? options.to;
  const openPositions = lots.map((lot) => {
    const lastPrice = barAt(lot.symbol, lastDate)?.close ?? lot.averagePrice;
    return {
      symbol: lot.symbol, quantity: lot.quantity, averagePrice: round(lot.averagePrice, 4), entryDate: lot.entryDate,
      lastPrice: round(lastPrice, 4), unrealizedUsd: round(lot.quantity * (lastPrice - lot.averagePrice), 2),
    };
  });
  const endingEquity = cash + openPositions.reduce((sum, position) => sum + position.quantity * position.lastPrice, 0);

  const nets = trades.map((trade) => trade.netPct);
  const wins = nets.filter((value) => value > 0);
  const losses = nets.filter((value) => value <= 0);
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  let peak = -Infinity, maxDrawdown = 0;
  for (const point of equityCurve) { peak = Math.max(peak, point.equity); maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak); }
  const benchmarkLast = options.benchmark?.filter((bar) => bar.date <= lastDate).at(-1)?.close ?? null;

  const sessions = equityCurve.length;
  return {
    strategyId: strategy.id, strategyName: strategy.name,
    from: equityCurve[0]?.date ?? options.from, to: lastDate, sessions,
    startingCapitalUsd: options.capitalUsd, endingEquityUsd: round(endingEquity, 2),
    fills, trades, equityCurve, openPositions,
    costPerSidePct: round(COST_PER_SIDE_PCT, 4),
    skippedSample: skippedSample.slice(0, 12),
    metrics: {
      trades: trades.length,
      winRatePct: trades.length ? round((wins.length / trades.length) * 100, 2) : null,
      avgNetPct: nets.length ? round(mean(nets)!, 4) : null,
      medianNetPct: nets.length ? round(median(nets)!, 4) : null,
      avgWinPct: avgWin === null ? null : round(avgWin, 4),
      avgLossPct: avgLoss === null ? null : round(avgLoss, 4),
      payoff: avgWin !== null && avgLoss !== null && avgLoss < 0 ? round(avgWin / Math.abs(avgLoss), 3) : null,
      totalReturnPct: round((endingEquity / options.capitalUsd - 1) * 100, 4),
      maxDrawdownPct: sessions ? round(maxDrawdown * 100, 3) : null,
      activeDays: entryDates.size,
      activeDayPct: sessions ? round((entryDates.size / sessions) * 100, 2) : null,
      exposurePct: sessions ? round((exposedSessions / sessions) * 100, 2) : null,
      benchmarkReturnPct: benchmarkBase && benchmarkLast ? round((benchmarkLast / benchmarkBase - 1) * 100, 4) : null,
      costPaidUsd: round(costPaid, 2),
    },
  };
}
