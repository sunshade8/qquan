/**
 * Executable strategies — the rules the 전략 tab actually trades.
 *
 * The one thing that matters here: **`plan()` is the only place a rule decides
 * anything, and both the backtest and the live order path call it.** The Lab's
 * `StrategySpec` engine cannot express these rules (it has no per-day candidate
 * cap, no ranking, no slot sizing), and a rule written twice — once to backtest,
 * once to trade — is two rules that will disagree in the one situation nobody
 * tested. So the replay engine in `lib/trade-strategy-engine.ts` feeds this
 * function historical bars and simulated positions, and the live endpoint feeds
 * it today's bars and real ledger positions. Same code, same decisions.
 *
 * Everything `plan()` reads is closed information: bars up to and including
 * `asOf`, and positions as they stand. It never sees the bar it will trade on.
 */

import type { Bar } from "./quant.ts";
import { roundTripPct } from "./broker-costs.ts";

export type PlannedSide = "buy" | "sell";

/** A position as the ledger holds it, plus how long the rule has owned it. */
export type StrategyPosition = {
  symbol: string;
  quantity: number;
  averagePrice: number;
  /** Session on which the entry filled. */
  entryDate: string;
  /**
   * Sessions this position will have been held **on the session the order being
   * planned now would fill**, not as of today.
   *
   * A plan made after today's close fills on the next session, so a rule reading
   * "hold five sessions" has to compare against the holding period at fill or it
   * exits a session late. Passing the at-fill number instead of the as-of number
   * keeps that adjustment in one place — the caller that knows the fill
   * convention — rather than as a `- 1` inside every rule.
   */
  sessionsAtFill: number;
};

export type PlanContext = {
  /** The last session whose close is final. Nothing after this is visible. */
  asOf: string;
  /** Daily bars per symbol, each already truncated to `asOf`. */
  bars: Record<string, Bar[]>;
  positions: StrategyPosition[];
  capitalUsd: number;
  /**
   * Live quote per symbol when the broker has one. Sizing uses it so the share
   * count matches what the order will actually cost; the backtest passes none
   * and falls back to the close, which is what it fills at.
   */
  quotes?: Record<string, number | undefined>;
};

export type PlannedOrder = {
  symbol: string;
  side: PlannedSide;
  quantity: number;
  /** Price the quantity was computed from — a live quote if there was one, else the close. */
  referencePrice: number;
  notionalUsd: number;
  reason: string;
  /** Which clause of the rule fired, for the ledger and the report. */
  rule: string;
  /** Stop price to rest under a new long, or the level that triggered an exit. */
  stopPrice: number | null;
};

export type StrategyPlan = {
  asOf: string;
  orders: PlannedOrder[];
  /** Entry candidates that were ranked but not taken, so a skipped day is explainable. */
  skipped: Array<{ symbol: string; reason: string; metric: number | null }>;
  notes: string[];
};

export type TradeStrategy = {
  id: string;
  name: string;
  /** One line for the card. */
  summary: string;
  universe: string[];
  benchmark: string;
  /** Sessions of history `plan()` needs before its first valid decision. */
  warmupSessions: number;
  /** Human-readable rule, rendered on the card and into the markdown report. */
  rules: string[];
  /** Where the evidence for this rule lives. */
  evidence: string;
  /** Documented limits — shown before anyone trades it. */
  cautions: string[];
  params: Record<string, number>;
  plan(context: PlanContext): StrategyPlan;
};

/** Per-side cost: half the round trip, charged on both the buy and the sell. */
export const COST_PER_SIDE_PCT = roundTripPct() / 2;

function barsUpTo(bars: Bar[] | undefined, asOf: string) {
  return bars ? bars.filter((bar) => bar.date <= asOf) : [];
}

// ---------------------------------------------------------------- H2

const H2_PARAMS = {
  /** Entry threshold: three-session return at or below this. */
  dropPct: -6,
  lookbackSessions: 3,
  /** Time exit. */
  maxSessions: 5,
  stopLossPct: 6,
  /** New entries per session, deepest drop first. */
  maxEntriesPerDay: 3,
  /** Concurrent positions; also the slot denominator for sizing. */
  maxOpenPositions: 12,
};

const H2_UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "JPM", "LLY",
  "V", "XOM", "UNH", "MA", "COST", "HD", "PG", "JNJ", "WMT", "NFLX",
  "ABBV", "BAC", "CRM", "ORCL", "CVX", "KO", "AMD", "PEP", "MRK", "ADBE",
  "CSCO", "INTC", "QCOM", "TXN", "AMAT", "MU", "INTU", "PANW", "LRCX", "KLAC",
  "SNPS", "CDNS", "MRVL", "ADI", "CRWD", "ABNB", "WDAY", "DDOG", "ZS", "MDB",
  "NET", "SNOW", "PLTR", "SHOP", "UBER", "MELI", "ASML",
];

/**
 * H2 — three-session plunge, held five sessions.
 *
 * Validated in `docs/research/results-2026-09.md`: +0.852% net per trade over
 * eleven years with a date-clustered t of 4.6, and still positive with the
 * commission doubled. Two design choices look wrong and are deliberate. There is
 * no SMA200 trend filter because adding it lowered every cell of the sweep. And
 * the daily cap is three names rather than "every signal", because a market-wide
 * selloff fires forty signals at once and taking all of them is one position in
 * forty pieces.
 */
export const h2Reversal: TradeStrategy = {
  id: "h2-3day-reversal",
  name: "H2 · 3일 급락 반전",
  summary: "3거래일 −6% 이상 밀린 대형주를 낙폭 순으로 하루 3종목까지 매수해 5거래일 보유, 손절 −6%.",
  universe: H2_UNIVERSE,
  benchmark: "SPY",
  warmupSessions: 20,
  rules: [
    "진입: 3거래일 수익률 ≤ −6% (SMA200 등 추세 필터 없음 — 붙이면 성적이 낮아졌다)",
    "선별: 낙폭이 큰 순으로 정렬해 하루 최대 3종목",
    "사이즈: 총자본의 1/12 (동시 보유 12건 상한)",
    "청산: 진입 후 5거래일째 종가, 또는 −6% 손절 도달 (손절은 진입과 함께 거는 상시 스탑 주문)",
    "익절 없음 (+3/+4/+6% 익절은 모두 성적을 낮췄다)",
  ],
  evidence: "docs/research/results-2026-09.md · H2 — 3,144거래 / 11년 / 승률 49.5% / 손익비 1.40 / 날짜 클러스터 t 4.64 / OOS +1.40%",
  cautions: [
    "국면 의존: 2020–2022 구간에서는 날짜 클러스터 t가 −0.70으로 효과가 사라졌다.",
    "같은 날 3종목이 함께 진입하므로 내부 상관이 사실상 1이다. 슬롯 6개(1/6)로 굴리면 MDD 63.5%.",
    "하루 3종목 상한을 늘리지 말 것. 거래당 수익은 올라가지만 동시 노출이 커진다.",
  ],
  params: H2_PARAMS,

  plan(context) {
    const { asOf, positions, capitalUsd } = context;
    const orders: PlannedOrder[] = [];
    const skipped: StrategyPlan["skipped"] = [];
    const notes: string[] = [];
    const held = new Set(positions.map((position) => position.symbol));

    // --- exits first: they free slots the entries below may use.
    for (const position of positions) {
      const series = barsUpTo(context.bars[position.symbol], asOf);
      const latest = series.at(-1);
      if (!latest) {
        skipped.push({ symbol: position.symbol, reason: "일봉이 없어 청산 판정을 못 했습니다", metric: null });
        continue;
      }
      const stopPrice = position.averagePrice * (1 - H2_PARAMS.stopLossPct / 100);
      const price = context.quotes?.[position.symbol] ?? latest.close;
      // The stop is a level, not a close: an intrabar break counts, which is what
      // a resting stop order would have done between two of these daily runs.
      const stopped = latest.low <= stopPrice;
      const timedOut = position.sessionsAtFill >= H2_PARAMS.maxSessions;
      if (!stopped && !timedOut) continue;
      orders.push({
        symbol: position.symbol, side: "sell", quantity: position.quantity,
        referencePrice: price, notionalUsd: Math.round(position.quantity * price * 100) / 100,
        reason: stopped ? `손절 −${H2_PARAMS.stopLossPct}% 도달 (저가 ${latest.low} ≤ ${stopPrice.toFixed(2)})` : `${H2_PARAMS.maxSessions}거래일 시간 청산 (체결 시점 보유 ${position.sessionsAtFill}일)`,
        rule: stopped ? "stop" : "time_exit",
        stopPrice: stopped ? Math.round(stopPrice * 100) / 100 : null,
      });
      // `held` deliberately keeps the symbol. A name being sold today is not a
      // candidate today: selling and re-buying the same name at the same close
      // pays the round trip twice to end up in the same position, and after a
      // stop it re-enters the trade the stop just ended.
    }

    // --- entries: rank every qualifying drop, then take the deepest few.
    const openAfterExits = positions.length - orders.filter((order) => order.side === "sell").length;
    let slotsFree = H2_PARAMS.maxOpenPositions - openAfterExits;
    const slotNotional = capitalUsd / H2_PARAMS.maxOpenPositions;

    const ranked: Array<{ symbol: string; dropPct: number; close: number }> = [];
    // Ranked over the bars actually supplied, not over the declared universe: a
    // symbol whose data failed to load must not be treated as a silent zero, and
    // the caller is the one that decides which universe it loaded.
    for (const symbol of Object.keys(context.bars).sort()) {
      if (held.has(symbol)) continue;
      const series = barsUpTo(context.bars[symbol], asOf);
      if (series.length <= H2_PARAMS.lookbackSessions) continue;
      const latest = series.at(-1)!;
      const reference = series[series.length - 1 - H2_PARAMS.lookbackSessions];
      if (!reference || !(reference.close > 0)) continue;
      const dropPct = (latest.close / reference.close - 1) * 100;
      if (dropPct > H2_PARAMS.dropPct) continue;
      ranked.push({ symbol, dropPct, close: latest.close });
    }
    // Deepest drop first; the symbol breaks ties so the same input always ranks
    // the same way and two runs of the same session place the same orders.
    ranked.sort((left, right) => left.dropPct - right.dropPct || left.symbol.localeCompare(right.symbol));

    if (slotsFree <= 0 && ranked.length) notes.push(`동시 보유 상한 ${H2_PARAMS.maxOpenPositions}건에 걸려 신규 진입을 건너뜁니다.`);

    for (const [index, candidate] of ranked.entries()) {
      if (index >= H2_PARAMS.maxEntriesPerDay) {
        skipped.push({ symbol: candidate.symbol, reason: `하루 ${H2_PARAMS.maxEntriesPerDay}종목 상한 초과 (낙폭 ${index + 1}위)`, metric: Number(candidate.dropPct.toFixed(2)) });
        continue;
      }
      if (slotsFree <= 0) {
        skipped.push({ symbol: candidate.symbol, reason: "동시 보유 슬롯 없음", metric: Number(candidate.dropPct.toFixed(2)) });
        continue;
      }
      const price = context.quotes?.[candidate.symbol] ?? candidate.close;
      const quantity = Math.floor(slotNotional / price);
      if (quantity < 1) {
        skipped.push({ symbol: candidate.symbol, reason: `슬롯 예산 $${slotNotional.toFixed(0)}로 1주도 못 삽니다 (주가 $${price.toFixed(2)})`, metric: Number(candidate.dropPct.toFixed(2)) });
        continue;
      }
      slotsFree -= 1;
      orders.push({
        symbol: candidate.symbol, side: "buy", quantity,
        referencePrice: price, notionalUsd: Math.round(quantity * price * 100) / 100,
        reason: `3거래일 ${candidate.dropPct.toFixed(2)}% (낙폭 ${index + 1}위)`,
        rule: "entry",
        stopPrice: Math.round(price * (1 - H2_PARAMS.stopLossPct / 100) * 100) / 100,
      });
    }

    if (!orders.length) notes.push(`${asOf} 종가 기준 조건을 만족한 종목이 없습니다.`);
    return { asOf, orders, skipped, notes };
  },
};

export const TRADE_STRATEGIES: TradeStrategy[] = [h2Reversal];

export function tradeStrategyById(id: string) {
  return TRADE_STRATEGIES.find((strategy) => strategy.id === id) ?? null;
}
