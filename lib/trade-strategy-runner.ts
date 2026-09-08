/**
 * Ties a coded strategy to real data: loads the bars, replays the rule for a
 * backtest, or builds today's order plan from the live ledger.
 *
 * Both entry points call `strategy.plan()`. The only difference between them is
 * where the positions come from — simulated lots in the replay, the paper ledger
 * in the live path — and that is the point: a rule that behaves differently in
 * the two is a rule whose backtest proves nothing.
 */

import { loadDailyRows } from "@/lib/price-cache";
import type { Bar } from "@/lib/quant";
import { openPositions } from "@/lib/paper-ledger-store";
import { replayStrategy, sessionCalendar, sessionsHeldAtFill, type ReplayResult } from "@/lib/trade-strategy-engine";
import { type PlanContext, type StrategyPlan, type StrategyPosition, type TradeStrategy } from "@/lib/trade-strategies";
import { brokerSnapshotFor } from "@/lib/trading";
import { tossHoldings, tossPrimaryAccount } from "@/lib/toss-orders";

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export type LoadedBars = { bars: Record<string, Bar[]>; benchmark: Bar[] | null; missing: string[] };

/**
 * Universe bars over a window. A symbol that fails to load is reported rather
 * than silently dropped: a universe that quietly shrinks changes the rule's
 * candidate ranking, which is the one thing the daily cap depends on.
 */
export async function loadStrategyBars(strategy: TradeStrategy, from: string, to: string): Promise<LoadedBars> {
  const bars: Record<string, Bar[]> = {};
  const missing: string[] = [];
  for (const symbol of strategy.universe) {
    try {
      const load = await loadDailyRows(symbol, from, to);
      if (load.rows.length > strategy.warmupSessions) bars[symbol] = load.rows;
      else missing.push(symbol);
    } catch {
      missing.push(symbol);
    }
  }
  let benchmark: Bar[] | null = null;
  try {
    const load = await loadDailyRows(strategy.benchmark, from, to);
    benchmark = load.rows.length ? load.rows : null;
  } catch {
    benchmark = null;
  }
  return { bars, benchmark, missing };
}

/**
 * Backtest over the last `sessions` trading days. Extra calendar days are loaded
 * for the rule's warm-up and for weekends, then the window is cut on the session
 * calendar so "60일" means sixty sessions rather than sixty dates.
 */
export async function backtestRecent(strategy: TradeStrategy, options: { sessions: number; capitalUsd: number; today?: string }): Promise<ReplayResult & { missing: string[] }> {
  const to = options.today ?? new Date().toISOString().slice(0, 10);
  const calendarDays = Math.ceil((options.sessions + strategy.warmupSessions + 10) * 1.5);
  const from = shiftDate(to, -calendarDays);
  const { bars, benchmark, missing } = await loadStrategyBars(strategy, from, to);
  if (!Object.keys(bars).length) throw new Error("유니버스 일봉을 하나도 불러오지 못했습니다.");
  const calendar = sessionCalendar(bars);
  const start = calendar[Math.max(0, calendar.length - options.sessions)] ?? from;
  const result = replayStrategy(strategy, bars, { from: start, to, capitalUsd: options.capitalUsd, benchmark });
  return { ...result, missing };
}

export type LiveQuote = { price: number; bid: number | null; ask: number | null; session: string | null };

export type LivePlan = {
  plan: StrategyPlan;
  positions: StrategyPosition[];
  /** Holdings the rule deliberately left alone, and why. */
  untouched: Array<{ symbol: string; quantity: number; reason: string }>;
  /** Set when positions came from the broker rather than the local ledger. */
  accountSeq: number | null;
  positionSource: "ledger" | "broker";
  missing: string[];
  /** Broker quotes for the symbols the plan touches, used for sizing and fill estimates. */
  quotes: Record<string, LiveQuote>;
};

/**
 * Today's plan: the rule reading the latest closed bars and the ledger's real
 * positions. Live quotes are fetched only for the symbols the rule could act on
 * — the universe is 57 names and the plan needs a price for at most a handful.
 */
/**
 * Positions the rule is allowed to act on, when orders go to the real broker.
 *
 * The account holds whatever its owner bought, and most of it has nothing to do
 * with this strategy. Two conditions therefore have to hold before a holding is
 * handed to `plan()`, and a holding that fails either is reported as untouched
 * rather than quietly managed:
 *
 * 1. the symbol is in this strategy's universe, and
 * 2. this strategy's own ledger says it opened the position — which is also the
 *    only place an entry date exists, and the holding period is what the exit
 *    rule runs on.
 *
 * The quantity is the smaller of the two. If the owner sold half of it by hand,
 * the rule must not try to sell more than is there.
 */
async function brokerPositions(
  strategy: TradeStrategy,
  ledger: Array<{ symbol: string; quantity: number; averagePrice: number; openedAt: string }>,
  calendar: string[],
  fillIndex: number,
): Promise<{ positions: StrategyPosition[]; untouched: Array<{ symbol: string; quantity: number; reason: string }>; accountSeq: number | null }> {
  const account = await tossPrimaryAccount();
  if (!account) throw new Error("토스 계좌를 찾지 못해 실제 보유 수량을 확인할 수 없습니다.");
  const { items } = await tossHoldings(account.accountSeq);
  const universe = new Set(strategy.universe);
  const byLedger = new Map(ledger.map((position) => [position.symbol, position]));

  const positions: StrategyPosition[] = [];
  const untouched: Array<{ symbol: string; quantity: number; reason: string }> = [];
  for (const item of items) {
    const quantity = Number(item.quantity) || 0;
    if (quantity <= 0) continue;
    if (!universe.has(item.symbol)) { untouched.push({ symbol: item.symbol, quantity, reason: "이 전략의 유니버스가 아님" }); continue; }
    const owned = byLedger.get(item.symbol);
    if (!owned) { untouched.push({ symbol: item.symbol, quantity, reason: "이 전략이 매수한 기록이 없음" }); continue; }
    positions.push({
      symbol: item.symbol,
      quantity: Math.min(quantity, owned.quantity),
      averagePrice: Number(item.averagePurchasePrice) || owned.averagePrice,
      entryDate: owned.openedAt,
      sessionsAtFill: sessionsHeldAtFill(calendar, owned.openedAt, fillIndex),
    });
  }
  // A ledger row with no matching holding means the position is gone at the
  // broker — sold by hand, or the buy never filled. Dropping it is right; saying
  // so is what stops the ledger drifting from the account silently.
  for (const position of ledger) {
    if (!items.some((item) => item.symbol === position.symbol && Number(item.quantity) > 0)) {
      untouched.push({ symbol: position.symbol, quantity: position.quantity, reason: "원장에는 있으나 토스 보유에 없음 (수동 매도 또는 미체결)" });
    }
  }
  return { positions, untouched, accountSeq: account.accountSeq };
}

export async function planLive(strategy: TradeStrategy, ownerId: string, instanceId: string, capitalUsd: number, options: { source?: "ledger" | "broker" } = {}): Promise<LivePlan> {
  const to = new Date().toISOString().slice(0, 10);
  const from = shiftDate(to, -Math.ceil((strategy.warmupSessions + 15) * 1.7));
  const { bars, missing } = await loadStrategyBars(strategy, from, to);
  if (!Object.keys(bars).length) throw new Error("유니버스 일봉을 하나도 불러오지 못했습니다.");

  const calendar = sessionCalendar(bars);
  const asOf = calendar.at(-1)!;
  // Orders planned after this close fill on the next session; the rule needs to
  // know the holding period as of that session, not as of today.
  const fillIndex = calendar.length; // one past the last known session
  const held = (await openPositions(ownerId, instanceId)).filter((position) => position.quantity > 0);
  let positions: StrategyPosition[];
  let untouched: Array<{ symbol: string; quantity: number; reason: string }> = [];
  let accountSeq: number | null = null;
  if (options.source === "broker") {
    const resolved = await brokerPositions(strategy, held, calendar, fillIndex);
    positions = resolved.positions;
    untouched = resolved.untouched;
    accountSeq = resolved.accountSeq;
  } else {
    positions = held.map((position) => ({
      symbol: position.symbol, quantity: position.quantity, averagePrice: position.averagePrice,
      entryDate: position.openedAt,
      sessionsAtFill: sessionsHeldAtFill(calendar, position.openedAt, fillIndex),
    }));
  }

  // A first pass with closes only tells us which symbols matter; quotes then
  // re-price just those, and the plan is rebuilt so sizing uses the live price.
  const dryContext: PlanContext = { asOf, bars, positions, capitalUsd };
  const provisional = strategy.plan(dryContext);
  const interesting = [...new Set(provisional.orders.map((order) => order.symbol))];
  const quotes: Record<string, LiveQuote> = {};
  for (const symbol of interesting) {
    try {
      const snapshot = await brokerSnapshotFor(symbol);
      if (snapshot.available && typeof snapshot.price === "number" && snapshot.price > 0) {
        quotes[symbol] = { price: snapshot.price, bid: snapshot.bid ?? null, ask: snapshot.ask ?? null, session: snapshot.session?.label ?? null };
      }
    } catch {
      // A missing quote is not an error: the rule falls back to the close, which
      // is what the backtest fills at anyway.
    }
  }
  const priced = Object.fromEntries(Object.entries(quotes).map(([symbol, quote]) => [symbol, quote.price]));
  const plan = Object.keys(priced).length ? strategy.plan({ ...dryContext, quotes: priced }) : provisional;
  return { plan, positions, untouched, accountSeq, positionSource: options.source === "broker" ? "broker" : "ledger", missing, quotes };
}
