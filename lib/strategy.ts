/**
 * Top-down strategy specification and deterministic backtest engine.
 *
 * A strategy starts from a hypothesis (thesis → mechanism → prediction →
 * falsification) and only then becomes a mechanical rule. The engine evaluates
 * the rule on real daily bars for a universe of symbols, executing every signal
 * on the *next* close so no bar trades on information it did not have.
 */

import {
  annualizedVolatility, atr, bollinger, cagr, dailyReturns, drawdownSeries, ema, macd, maxDrawdown, mean, round, rsi, sharpe, sma, sortino, standardDeviation,
  type Bar,
} from "./quant.ts";

export type IndicatorKind =
  | "close" | "open" | "high" | "low" | "volume" | "sma" | "ema" | "rsi" | "macd_hist" | "macd_line"
  | "return" | "drawdown" | "volume_ratio" | "bb_pos" | "atr_pct" | "highest_close" | "lowest_close" | "volatility"
  // Calendar operands. These are what let a News finding ("CPI 발표 2일 전") become a
  // mechanical rule; every other indicator is derived from price and cannot express one.
  | "sessions_to_event" | "sessions_since_event" | "event_surprise" | "event_surprise_z";

export const CALENDAR_KINDS = new Set<IndicatorKind>(["sessions_to_event", "sessions_since_event", "event_surprise", "event_surprise_z"]);

export function isCalendarOperand(operand: Operand) {
  return operand.kind !== "value" && CALENDAR_KINDS.has(operand.kind);
}

/** `event` names an `eventRoot` from `lib/market-events.ts` and is required by calendar kinds. */
export type Operand = { kind: IndicatorKind; period?: number; event?: string } | { kind: "value"; value: number };
export type ConditionOp = ">" | "<" | ">=" | "<=" | "cross_above" | "cross_below";
export type Condition = { left: Operand; op: ConditionOp; right: Operand };

export type StrategyHypothesis = {
  thesis: string; // top-down market/macro/structural claim
  mechanism: string; // why the claim should produce excess returns
  prediction: string; // what the rule should show if the thesis is right
  falsification: string; // what result rejects the thesis
};

export type SuccessCriteria = { minSharpe?: number; minExcessCagrPct?: number; maxDrawdownPct?: number; minTrades?: number; minWinRatePct?: number };

/**
 * Minimum bar a strategy must clear, regardless of what its author proposed.
 *
 * `successCriteria` arrives from the same model that wrote the rule, so without
 * a floor the author sets its own passing grade — and because the verdict counts
 * failures against the number of checks that ran, *omitting* a criterion both
 * removed a check and made the remaining failures less likely to reach "fail".
 * These floors can only be tightened by the author, never loosened, and every
 * clamp is recorded in the spec notes so the adjustment is visible rather than
 * silent.
 *
 * `minWinRatePct` is deliberately absent: trend-following rules are expected to
 * win less than half their trades, so a universal win-rate floor would reject
 * sound strategies. It stays optional and is checked only when proposed.
 */
export const CRITERIA_FLOORS = { minSharpe: 0.5, minExcessCagrPct: 0, maxDrawdownPct: 40, minTrades: 10 } as const;

export function applyCriteriaFloors(proposed: SuccessCriteria): { criteria: SuccessCriteria; adjustments: string[] } {
  const criteria: SuccessCriteria = { ...proposed };
  const adjustments: string[] = [];
  const tighten = (key: "minSharpe" | "minExcessCagrPct" | "minTrades", label: string) => {
    const floor = CRITERIA_FLOORS[key];
    const value = criteria[key];
    if (value === undefined) { criteria[key] = floor; return; }
    if (value < floor) { criteria[key] = floor; adjustments.push(`통과 기준 조정: ${label} ${value} → ${floor} (시스템 최소 기준)`); }
  };
  tighten("minSharpe", "최소 샤프");
  tighten("minExcessCagrPct", "최소 초과 CAGR(%p)");
  tighten("minTrades", "최소 거래 수");
  // Drawdown is a cap, so "tighter" means a smaller allowed loss.
  const drawdown = criteria.maxDrawdownPct === undefined ? undefined : Math.abs(criteria.maxDrawdownPct);
  if (drawdown === undefined) criteria.maxDrawdownPct = CRITERIA_FLOORS.maxDrawdownPct;
  else if (drawdown > CRITERIA_FLOORS.maxDrawdownPct) {
    criteria.maxDrawdownPct = CRITERIA_FLOORS.maxDrawdownPct;
    adjustments.push(`통과 기준 조정: 최대 허용 낙폭 ${drawdown}% → ${CRITERIA_FLOORS.maxDrawdownPct}% (시스템 최소 기준)`);
  } else criteria.maxDrawdownPct = drawdown;
  return { criteria, adjustments };
}

export type StrategySpec = {
  version: 1;
  name: string;
  hypothesis: StrategyHypothesis;
  universe: string[];
  benchmark: string;
  entry: Condition[]; // all must hold on the signal bar
  exit: Condition[]; // any triggers an exit
  holding: { maxSessions?: number | null; stopLossPct?: number | null; takeProfitPct?: number | null };
  sizing: { mode: "equal_weight"; positionPct?: number | null };
  costBps: number;
  period: { from: string; to: string };
  successCriteria: SuccessCriteria;
  notes?: string[];
};

export type Trade = { symbol: string; entryDate: string; exitDate: string; entryPrice: number; exitPrice: number; returnPct: number; sessions: number; reason: string };

export type SymbolBacktest = {
  symbol: string; sessions: number; from: string; to: string;
  totalReturnPct: number | null; benchmarkReturnPct: number | null; cagrPct: number | null; sharpe: number | null; maxDrawdownPct: number | null;
  trades: number; winRatePct: number | null; exposurePct: number | null; averageTradePct: number | null;
  equity: Array<{ date: string; value: number }>;
  currentSignal: "long" | "flat"; latestClose: number; latestDate: string;
};

export type BacktestMetrics = {
  totalReturnPct: number | null; benchmarkReturnPct: number | null; marketReturnPct: number | null;
  cagrPct: number | null; benchmarkCagrPct: number | null; excessCagrPct: number | null;
  sharpe: number | null; benchmarkSharpe: number | null; sortino: number | null;
  maxDrawdownPct: number | null; benchmarkMaxDrawdownPct: number | null;
  annualizedVolatilityPct: number | null; trades: number; winRatePct: number | null; averageTradePct: number | null; exposurePct: number | null; profitFactor: number | null;
};

export type BacktestResult = {
  spec: StrategySpec;
  period: { from: string; to: string; sessions: number };
  metrics: BacktestMetrics;
  equityCurve: Array<{ date: string; strategy: number; benchmark: number; market: number | null }>;
  perSymbol: SymbolBacktest[];
  trades: Trade[];
  robustness: {
    inSample: { from: string; to: string; cagrPct: number | null; sharpe: number | null; maxDrawdownPct: number | null };
    outOfSample: { from: string; to: string; cagrPct: number | null; sharpe: number | null; maxDrawdownPct: number | null };
    perturbations: Array<{ label: string; cagrPct: number | null; sharpe: number | null; maxDrawdownPct: number | null }>;
    stabilityScore: number | null; // 0..100, share of perturbations that keep positive excess CAGR and Sharpe within 50% of base
  };
  verdict: { status: "pass" | "fail" | "inconclusive"; reasons: string[] };
  missingSymbols: Array<{ symbol: string; reason: string }>;
};

export const INDICATOR_LABELS: Record<IndicatorKind, string> = {
  close: "종가", open: "시가", high: "고가", low: "저가", volume: "거래량", sma: "SMA", ema: "EMA", rsi: "RSI", macd_hist: "MACD 히스토그램", macd_line: "MACD", return: "N일 수익률(%)", drawdown: "고점 대비 낙폭(%)", volume_ratio: "거래량/N일 평균", bb_pos: "볼린저 위치(0~1)", atr_pct: "ATR(%)", highest_close: "N일 최고 종가", lowest_close: "N일 최저 종가", volatility: "N일 변동성(연환산 %)",
  sessions_to_event: "다음 이벤트까지 거래일", sessions_since_event: "직전 이벤트 이후 거래일", event_surprise: "직전 이벤트 서프라이즈", event_surprise_z: "직전 이벤트 서프라이즈 (z)",
};

export function describeOperand(operand: Operand) {
  if (operand.kind === "value") return String(operand.value);
  const label = INDICATOR_LABELS[operand.kind];
  if (CALENDAR_KINDS.has(operand.kind)) return `${label}[${operand.event ?? "이벤트 미지정"}]`;
  return operand.period ? `${label}(${operand.period})` : label;
}

export function describeCondition(condition: Condition) {
  const ops: Record<ConditionOp, string> = { ">": ">", "<": "<", ">=": "≥", "<=": "≤", cross_above: "상향 돌파", cross_below: "하향 돌파" };
  return `${describeOperand(condition.left)} ${ops[condition.op]} ${describeOperand(condition.right)}`;
}

export function describeSpec(spec: StrategySpec) {
  const entry = spec.entry.map(describeCondition).join(" AND ") || "(없음)";
  const exit = spec.exit.map(describeCondition).join(" OR ") || "(없음)";
  const holding = [spec.holding.maxSessions ? `최대 ${spec.holding.maxSessions}거래일` : null, spec.holding.stopLossPct ? `손절 -${spec.holding.stopLossPct}%` : null, spec.holding.takeProfitPct ? `익절 +${spec.holding.takeProfitPct}%` : null].filter(Boolean).join(" · ");
  return { entry, exit, holding: holding || "조건 청산만", universe: spec.universe.join(", "), cost: `${spec.costBps}bps 편도` };
}

/**
 * Calendar facts a rule can read, keyed by `eventRoot`.
 *
 * Dates are calendar dates as published; the engine maps them onto trading
 * sessions itself, because "2 sessions before CPI" is what a rule can actually
 * trade and CPI can land on a holiday.
 */
export type EventOccurrence = { date: string; releasedBeforeClose: boolean; surprise: number | null; surpriseZ: number | null };
export type EventContext = Record<string, EventOccurrence[]>;

/**
 * Sessions from each bar to the next occurrence (0 on the event day itself),
 * and from the previous occurrence. Counting in sessions rather than calendar
 * days is what makes `sessions_to_event == 2` mean "two closes from now".
 */
function eventDistanceSeries(rows: Bar[], occurrences: EventOccurrence[], direction: "to" | "since"): Array<number | null> {
  const dates = rows.map((row) => row.date);
  // Index of the first session on or after each event date; events that fall on a
  // holiday therefore attach to the next session the market actually traded.
  const anchors: number[] = [];
  for (const occurrence of occurrences) {
    let index = dates.findIndex((date) => date >= occurrence.date);
    if (index === -1) index = dates.length; // event is beyond the loaded window
    anchors.push(index);
  }
  anchors.sort((left, right) => left - right);
  const values: Array<number | null> = rows.map(() => null);
  if (!anchors.length) return values;
  if (direction === "to") {
    let cursor = 0;
    for (let index = 0; index < rows.length; index += 1) {
      while (cursor < anchors.length && anchors[cursor] < index) cursor += 1;
      values[index] = cursor < anchors.length ? anchors[cursor] - index : null;
    }
    return values;
  }
  let cursor = -1;
  for (let index = 0; index < rows.length; index += 1) {
    while (cursor + 1 < anchors.length && anchors[cursor + 1] <= index) cursor += 1;
    values[index] = cursor >= 0 ? index - anchors[cursor] : null;
  }
  return values;
}

/**
 * The surprise of the most recent release a bar could already know.
 *
 * A release before 16:00 ET is in that day's close; anything later is not
 * readable until the next session. Getting this wrong is look-ahead of exactly
 * one bar, which is enough to manufacture an edge out of nothing.
 */
function eventSurpriseSeries(rows: Bar[], occurrences: EventOccurrence[], field: "surprise" | "surpriseZ"): Array<number | null> {
  const values: Array<number | null> = rows.map(() => null);
  const known = occurrences
    .filter((occurrence) => occurrence[field] !== null)
    .map((occurrence) => ({ ...occurrence, value: occurrence[field]! }))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (!known.length) return values;
  let cursor = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const date = rows[index].date;
    while (
      cursor + 1 < known.length &&
      (known[cursor + 1].releasedBeforeClose ? known[cursor + 1].date <= date : known[cursor + 1].date < date)
    ) cursor += 1;
    values[index] = cursor >= 0 ? known[cursor].value : null;
  }
  return values;
}

function seriesFor(rows: Bar[], operand: Operand, cache: Map<string, Array<number | null>>, events: EventContext = {}): Array<number | null> {
  if (operand.kind === "value") return rows.map(() => operand.value);
  const key = `${operand.kind}:${operand.period ?? ""}:${operand.event ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (CALENDAR_KINDS.has(operand.kind)) {
    // An unknown or missing event root yields nulls rather than zeros, so a
    // typo'd root makes the condition never fire instead of always firing.
    const occurrences = operand.event ? events[operand.event] ?? [] : [];
    const calendar = operand.kind === "sessions_to_event" ? eventDistanceSeries(rows, occurrences, "to")
      : operand.kind === "sessions_since_event" ? eventDistanceSeries(rows, occurrences, "since")
      : eventSurpriseSeries(rows, occurrences, operand.kind === "event_surprise" ? "surprise" : "surpriseZ");
    cache.set(key, calendar);
    return calendar;
  }
  const closes = rows.map((row) => row.close);
  const period = Math.max(1, Math.round(operand.period ?? defaultPeriod(operand.kind)));
  let values: Array<number | null>;
  switch (operand.kind) {
    case "close": values = closes; break;
    case "open": values = rows.map((row) => row.open); break;
    case "high": values = rows.map((row) => row.high); break;
    case "low": values = rows.map((row) => row.low); break;
    case "volume": values = rows.map((row) => row.volume); break;
    case "sma": values = sma(closes, period); break;
    case "ema": values = ema(closes, period); break;
    case "rsi": values = rsi(closes, period); break;
    case "macd_hist": values = macd(closes).histogram; break;
    case "macd_line": values = macd(closes).line; break;
    case "return": values = closes.map((close, index) => index >= period ? (close / closes[index - period] - 1) * 100 : null); break;
    case "drawdown": values = drawdownSeries(closes); break;
    case "volume_ratio": { const average = sma(rows.map((row) => row.volume), period); values = rows.map((row, index) => average[index] ? row.volume / average[index]! : null); break; }
    case "bb_pos": { const band = bollinger(closes, period, 2); values = closes.map((close, index) => band.upper[index] !== null && band.lower[index] !== null && band.upper[index]! !== band.lower[index]! ? (close - band.lower[index]!) / (band.upper[index]! - band.lower[index]!) : null); break; }
    case "atr_pct": { const range = atr(rows, period); values = rows.map((row, index) => range[index] !== null ? (range[index]! / row.close) * 100 : null); break; }
    case "highest_close": values = closes.map((_, index) => index >= period ? Math.max(...closes.slice(index - period, index)) : null); break;
    case "lowest_close": values = closes.map((_, index) => index >= period ? Math.min(...closes.slice(index - period, index)) : null); break;
    case "volatility": {
      const returns = closes.map((close, index) => index ? close / closes[index - 1] - 1 : null);
      values = closes.map((_, index) => {
        if (index < period) return null;
        const window = returns.slice(index - period + 1, index + 1).filter((value): value is number => value !== null);
        const deviation = standardDeviation(window);
        return deviation === null ? null : deviation * Math.sqrt(252) * 100;
      });
      break;
    }
    default: values = closes;
  }
  cache.set(key, values);
  return values;
}

function defaultPeriod(kind: IndicatorKind) {
  if (kind === "rsi") return 14;
  if (kind === "volume_ratio" || kind === "bb_pos" || kind === "volatility" || kind === "highest_close" || kind === "lowest_close") return 20;
  if (kind === "atr_pct") return 14;
  if (kind === "return") return 5;
  return 20;
}

function evaluate(condition: Condition, index: number, left: Array<number | null>, right: Array<number | null>) {
  const a = left[index];
  const b = right[index];
  if (a === null || b === null || a === undefined || b === undefined) return false;
  switch (condition.op) {
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case "cross_above": { const pa = left[index - 1]; const pb = right[index - 1]; return pa !== null && pb !== null && pa !== undefined && pb !== undefined && pa <= pb && a > b; }
    case "cross_below": { const pa = left[index - 1]; const pb = right[index - 1]; return pa !== null && pb !== null && pa !== undefined && pb !== undefined && pa >= pb && a < b; }
    default: return false;
  }
}

/** Signal state per bar for one symbol: true = the rule wants to be long after this close. */
export function signalSeries(rows: Bar[], spec: StrategySpec, events: EventContext = {}) {
  const cache = new Map<string, Array<number | null>>();
  const entry = spec.entry.map((condition) => ({ condition, left: seriesFor(rows, condition.left, cache, events), right: seriesFor(rows, condition.right, cache, events) }));
  const exit = spec.exit.map((condition) => ({ condition, left: seriesFor(rows, condition.left, cache, events), right: seriesFor(rows, condition.right, cache, events) }));
  const signals: boolean[] = rows.map(() => false);
  const reasons: string[] = rows.map(() => "");
  let holding = false;
  let entryIndex = -1;
  let entryPrice = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (!holding) {
      const enter = entry.length > 0 && entry.every((item) => evaluate(item.condition, index, item.left, item.right));
      if (enter) { holding = true; entryIndex = index; entryPrice = rows[index].close; }
    } else {
      const held = index - entryIndex;
      const move = (rows[index].close / entryPrice - 1) * 100;
      let reason = "";
      if (exit.some((item) => evaluate(item.condition, index, item.left, item.right))) reason = "청산 조건";
      else if (spec.holding.maxSessions && held >= spec.holding.maxSessions) reason = "보유기간 만료";
      else if (spec.holding.stopLossPct && move <= -Math.abs(spec.holding.stopLossPct)) reason = "손절";
      else if (spec.holding.takeProfitPct && move >= Math.abs(spec.holding.takeProfitPct)) reason = "익절";
      if (reason) { holding = false; reasons[index] = reason; }
    }
    signals[index] = holding;
  }
  return { signals, reasons };
}

function symbolBacktest(symbol: string, rows: Bar[], spec: StrategySpec, from: string, events: EventContext = {}): SymbolBacktest & { dailyReturns: Array<{ date: string; value: number }>; tradesDetail: Trade[] } {
  const { signals, reasons } = signalSeries(rows, spec, events);
  const startIndex = Math.max(1, rows.findIndex((row) => row.date >= from));
  const cost = spec.costBps / 10_000;
  let equity = 1;
  let benchmark = 1;
  let position = Boolean(signals[startIndex - 1]);
  let entryPrice = position ? rows[startIndex - 1].close : 0;
  let entryDate = position ? rows[startIndex - 1].date : "";
  let held = 0;
  const equityPath: Array<{ date: string; value: number }> = [{ date: rows[startIndex - 1].date, value: 100 }];
  const daily: Array<{ date: string; value: number }> = [];
  const trades: Trade[] = [];
  let exposed = 0;
  for (let index = startIndex; index < rows.length; index += 1) {
    const dailyReturn = rows[index].close / rows[index - 1].close - 1;
    benchmark *= 1 + dailyReturn;
    let periodReturn = position ? dailyReturn : 0;
    const target = signals[index - 1];
    if (target !== position) {
      periodReturn -= cost;
      if (target) { entryPrice = rows[index].close; entryDate = rows[index].date; held = 0; }
      else trades.push({ symbol, entryDate, exitDate: rows[index].date, entryPrice: round(entryPrice, 4)!, exitPrice: round(rows[index].close, 4)!, returnPct: round((rows[index].close / entryPrice - 1) * 100)!, sessions: held, reason: reasons[index - 1] || "신호 소멸" });
      position = target;
    }
    if (position) { held += 1; exposed += 1; }
    equity *= 1 + periodReturn;
    daily.push({ date: rows[index].date, value: periodReturn });
    equityPath.push({ date: rows[index].date, value: round(equity * 100, 3)! });
  }
  if (position) trades.push({ symbol, entryDate, exitDate: rows.at(-1)!.date, entryPrice: round(entryPrice, 4)!, exitPrice: round(rows.at(-1)!.close, 4)!, returnPct: round((rows.at(-1)!.close / entryPrice - 1) * 100)!, sessions: held, reason: "보유 중" });
  const sessions = rows.length - startIndex;
  const returns = daily.map((item) => item.value);
  const wins = trades.filter((trade) => trade.returnPct > 0);
  return {
    symbol, sessions, from: rows[startIndex]?.date ?? from, to: rows.at(-1)!.date,
    totalReturnPct: round((equity - 1) * 100), benchmarkReturnPct: round((benchmark - 1) * 100), cagrPct: round(cagr(1, equity, sessions)), sharpe: round(sharpe(returns), 2),
    maxDrawdownPct: round(maxDrawdown(equityPath.map((point) => point.value))), trades: trades.length, winRatePct: trades.length ? round((wins.length / trades.length) * 100, 1) : null,
    exposurePct: sessions ? round((exposed / sessions) * 100, 1) : null, averageTradePct: round(mean(trades.map((trade) => trade.returnPct))),
    equity: equityPath, currentSignal: signals.at(-1) ? "long" : "flat", latestClose: round(rows.at(-1)!.close, 4)!, latestDate: rows.at(-1)!.date,
    dailyReturns: daily, tradesDetail: trades,
  };
}

function portfolioMetrics(dates: string[], strategyDaily: number[], benchmarkDaily: number[], trades: Trade[], exposurePct: number | null): BacktestMetrics {
  const equity = strategyDaily.reduce((value, item) => value * (1 + item), 1);
  const benchmark = benchmarkDaily.reduce((value, item) => value * (1 + item), 1);
  const sessions = dates.length;
  const strategyCurve = strategyDaily.reduce<number[]>((curve, item) => { curve.push((curve.at(-1) ?? 1) * (1 + item)); return curve; }, []);
  const benchmarkCurve = benchmarkDaily.reduce<number[]>((curve, item) => { curve.push((curve.at(-1) ?? 1) * (1 + item)); return curve; }, []);
  const wins = trades.filter((trade) => trade.returnPct > 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.returnPct, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.returnPct <= 0).reduce((sum, trade) => sum + trade.returnPct, 0));
  const strategyCagr = cagr(1, equity, sessions);
  const benchmarkCagr = cagr(1, benchmark, sessions);
  return {
    totalReturnPct: round((equity - 1) * 100), benchmarkReturnPct: round((benchmark - 1) * 100), marketReturnPct: null,
    cagrPct: round(strategyCagr), benchmarkCagrPct: round(benchmarkCagr), excessCagrPct: strategyCagr !== null && benchmarkCagr !== null ? round(strategyCagr - benchmarkCagr) : null,
    sharpe: round(sharpe(strategyDaily), 2), benchmarkSharpe: round(sharpe(benchmarkDaily), 2), sortino: round(sortino(strategyDaily), 2),
    maxDrawdownPct: round(maxDrawdown(strategyCurve)), benchmarkMaxDrawdownPct: round(maxDrawdown(benchmarkCurve)),
    annualizedVolatilityPct: round(annualizedVolatility(strategyDaily)), trades: trades.length, winRatePct: trades.length ? round((wins.length / trades.length) * 100, 1) : null,
    averageTradePct: round(mean(trades.map((trade) => trade.returnPct))), exposurePct, profitFactor: grossLoss ? round(grossWin / grossLoss, 2) : trades.length ? null : null,
  };
}

function combine(perSymbol: Array<ReturnType<typeof symbolBacktest>>) {
  const dateSet = new Set<string>();
  for (const item of perSymbol) for (const day of item.dailyReturns) dateSet.add(day.date);
  const dates = [...dateSet].sort();
  const maps = perSymbol.map((item) => new Map(item.dailyReturns.map((day) => [day.date, day.value])));
  const strategyDaily = dates.map((date) => { const values = maps.map((map) => map.get(date)).filter((value): value is number => value !== undefined); return values.length ? values.reduce((sum, value) => sum + value, 0) / perSymbol.length : 0; });
  return { dates, strategyDaily };
}

function slice(rows: Bar[], from: string, to: string) {
  return rows.filter((row) => row.date >= from && row.date <= to);
}

function perturbSpec(spec: StrategySpec, factor: number): StrategySpec {
  const scale = (operand: Operand): Operand => operand.kind === "value" || !operand.period || CALENDAR_KINDS.has(operand.kind) ? operand : { ...operand, period: Math.max(2, Math.round(operand.period * factor)) };
  const scaleCondition = (condition: Condition): Condition => ({ ...condition, left: scale(condition.left), right: scale(condition.right) });
  return { ...spec, entry: spec.entry.map(scaleCondition), exit: spec.exit.map(scaleCondition) };
}

function quickMetrics(spec: StrategySpec, data: Record<string, Bar[]>, from: string, to: string, events: EventContext = {}) {
  const usable = Object.entries(data).flatMap(([symbol, rows]) => { const bounded = rows.filter((row) => row.date <= to); return bounded.length > 30 ? [symbolBacktest(symbol, bounded, spec, from, events)] : []; });
  if (!usable.length) return { cagrPct: null, sharpe: null, maxDrawdownPct: null };
  const { strategyDaily } = combine(usable);
  const equity = strategyDaily.reduce((value, item) => value * (1 + item), 1);
  const curve = strategyDaily.reduce<number[]>((acc, item) => { acc.push((acc.at(-1) ?? 1) * (1 + item)); return acc; }, []);
  return { cagrPct: round(cagr(1, equity, strategyDaily.length)), sharpe: round(sharpe(strategyDaily), 2), maxDrawdownPct: round(maxDrawdown(curve)) };
}

/**
 * Runs the spec over pre-loaded bars. `data` must include warm-up bars before
 * `spec.period.from` so indicators are defined on the first tradable session.
 */
export function runStrategyBacktest(spec: StrategySpec, data: Record<string, Bar[]>, marketRows: Bar[] | null, missingSymbols: Array<{ symbol: string; reason: string }> = [], events: EventContext = {}): BacktestResult | null {
  const { from, to } = spec.period;
  const usable = Object.entries(data).flatMap(([symbol, rows]) => { const bounded = rows.filter((row) => row.date <= to); return bounded.filter((row) => row.date >= from).length >= 30 ? [symbolBacktest(symbol, bounded, spec, from, events)] : []; });
  if (!usable.length) return null;
  const { dates, strategyDaily } = combine(usable);
  const benchmarkMaps = usable.map((item) => { const rows = data[item.symbol].filter((row) => row.date <= to); return new Map(rows.slice(1).map((row, index) => [row.date, row.close / rows[index].close - 1])); });
  const benchmarkDaily = dates.map((date) => { const values = benchmarkMaps.map((map) => map.get(date)).filter((value): value is number => value !== undefined); return values.length ? values.reduce((sum, value) => sum + value, 0) / usable.length : 0; });
  const trades = usable.flatMap((item) => item.tradesDetail).sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const exposurePct = round(mean(usable.flatMap((item) => item.exposurePct === null ? [] : [item.exposurePct])), 1);
  const metrics = portfolioMetrics(dates, strategyDaily, benchmarkDaily, trades, exposurePct);
  let marketCurve: Map<string, number> | null = null;
  if (marketRows?.length) {
    const inside = slice(marketRows, dates[0], to);
    if (inside.length > 1) { const base = inside[0].close; marketCurve = new Map(inside.map((row) => [row.date, round((row.close / base) * 100, 3)!])); metrics.marketReturnPct = round((inside.at(-1)!.close / base - 1) * 100); }
  }
  let strategyEquity = 1;
  let benchmarkEquity = 1;
  const equityCurve = dates.map((date, index) => { strategyEquity *= 1 + strategyDaily[index]; benchmarkEquity *= 1 + benchmarkDaily[index]; return { date, strategy: round(strategyEquity * 100, 3)!, benchmark: round(benchmarkEquity * 100, 3)!, market: marketCurve?.get(date) ?? null }; });

  const splitIndex = Math.floor(dates.length * 0.7);
  const splitDate = dates[splitIndex] ?? to;
  const inSample = { from: dates[0], to: dates[Math.max(0, splitIndex - 1)], ...quickMetrics(spec, data, from, dates[Math.max(0, splitIndex - 1)], events) };
  const outOfSample = { from: splitDate, to, ...quickMetrics(spec, data, splitDate, to, events) };
  const perturbations = [0.8, 1.2].map((factor) => ({ label: `지표 기간 ×${factor}`, ...quickMetrics(perturbSpec(spec, factor), data, from, to, events) }))
    .concat([{ label: `비용 ${spec.costBps * 2}bps`, ...quickMetrics({ ...spec, costBps: spec.costBps * 2 }, data, from, to, events) }]);
  const baseSharpe = metrics.sharpe ?? 0;
  const stable = perturbations.filter((item) => item.cagrPct !== null && item.cagrPct > (metrics.benchmarkCagrPct ?? 0) && item.sharpe !== null && Math.abs(item.sharpe - baseSharpe) <= Math.max(0.3, Math.abs(baseSharpe) * 0.5)).length;
  const stabilityScore = perturbations.length ? round((stable / perturbations.length) * 100, 0) : null;

  const reasons: string[] = [];
  const criteria = spec.successCriteria ?? {};
  let fails = 0;
  let checks = 0;
  const check = (label: string, ok: boolean | null) => { if (ok === null) return; checks += 1; if (!ok) { fails += 1; reasons.push(`✗ ${label}`); } else reasons.push(`✓ ${label}`); };
  check(`샤프 ≥ ${criteria.minSharpe ?? 0.5} (실제 ${metrics.sharpe ?? "—"})`, metrics.sharpe === null ? null : metrics.sharpe >= (criteria.minSharpe ?? 0.5));
  check(`벤치마크 대비 초과 CAGR ≥ ${criteria.minExcessCagrPct ?? 0}%p (실제 ${metrics.excessCagrPct ?? "—"})`, metrics.excessCagrPct === null ? null : metrics.excessCagrPct >= (criteria.minExcessCagrPct ?? 0));
  if (criteria.maxDrawdownPct !== undefined) check(`최대낙폭 ≥ -${Math.abs(criteria.maxDrawdownPct)}% (실제 ${metrics.maxDrawdownPct ?? "—"})`, metrics.maxDrawdownPct === null ? null : metrics.maxDrawdownPct >= -Math.abs(criteria.maxDrawdownPct));
  check(`거래 수 ≥ ${criteria.minTrades ?? 10} (실제 ${metrics.trades})`, metrics.trades >= (criteria.minTrades ?? 10));
  if (criteria.minWinRatePct !== undefined) check(`승률 ≥ ${criteria.minWinRatePct}% (실제 ${metrics.winRatePct ?? "—"})`, metrics.winRatePct === null ? null : metrics.winRatePct >= criteria.minWinRatePct);
  check(`아웃오브샘플 CAGR > 0 (실제 ${outOfSample.cagrPct ?? "—"})`, outOfSample.cagrPct === null ? null : outOfSample.cagrPct > 0);
  const status: BacktestResult["verdict"]["status"] = checks === 0 ? "inconclusive" : fails === 0 ? "pass" : fails >= Math.ceil(checks / 2) ? "fail" : "inconclusive";

  return {
    spec, period: { from: dates[0], to: dates.at(-1)!, sessions: dates.length }, metrics, equityCurve,
    perSymbol: usable.map((item) => { const { dailyReturns: daily, tradesDetail: detail, ...rest } = item; void daily; void detail; return rest; }),
    trades: trades.slice(-60), robustness: { inSample, outOfSample, perturbations, stabilityScore }, verdict: { status, reasons }, missingSymbols,
  };
}

/** Presets map the simple rule names the Lab agent already knows onto full specs. */
export function presetConditions(strategy: string, params: Record<string, number | undefined> = {}): Pick<StrategySpec, "entry" | "exit"> {
  switch (strategy) {
    case "momentum": return { entry: [{ left: { kind: "close" }, op: ">", right: { kind: "sma", period: params.period ?? 200 } }], exit: [{ left: { kind: "close" }, op: "<", right: { kind: "sma", period: params.period ?? 200 } }] };
    case "rsi_reversal": return { entry: [{ left: { kind: "rsi", period: params.period ?? 14 }, op: "<", right: { kind: "value", value: params.entry ?? 30 } }], exit: [{ left: { kind: "rsi", period: params.period ?? 14 }, op: ">", right: { kind: "value", value: params.exit ?? 55 } }] };
    case "breakout": return { entry: [{ left: { kind: "close" }, op: ">", right: { kind: "highest_close", period: params.lookback ?? 55 } }], exit: [{ left: { kind: "close" }, op: "<", right: { kind: "lowest_close", period: params.exitLookback ?? 20 } }] };
    case "buy_and_hold": return { entry: [{ left: { kind: "close" }, op: ">", right: { kind: "value", value: 0 } }], exit: [] };
    default: return { entry: [{ left: { kind: "sma", period: params.fast ?? 50 }, op: ">", right: { kind: "sma", period: params.slow ?? 200 } }], exit: [{ left: { kind: "sma", period: params.fast ?? 50 }, op: "<", right: { kind: "sma", period: params.slow ?? 200 } }] };
  }
}

const INDICATOR_KINDS = new Set<IndicatorKind>(["close", "open", "high", "low", "volume", "sma", "ema", "rsi", "macd_hist", "macd_line", "return", "drawdown", "volume_ratio", "bb_pos", "atr_pct", "highest_close", "lowest_close", "volatility", "sessions_to_event", "sessions_since_event", "event_surprise", "event_surprise_z"]);
const OPS = new Set<ConditionOp>([">", "<", ">=", "<=", "cross_above", "cross_below"]);

/**
 * A calendar operand without an `event` root is rejected rather than defaulted.
 * Silently dropping the root would leave a rule whose condition can never be
 * true, and a rule that never fires backtests as a flat line that passes some
 * checks by vacuity.
 */
function normalizeOperand(value: unknown): Operand | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.kind === "value") return Number.isFinite(Number(item.value)) ? { kind: "value", value: Number(item.value) } : null;
  if (!INDICATOR_KINDS.has(item.kind as IndicatorKind)) return null;
  const kind = item.kind as IndicatorKind;
  if (CALENDAR_KINDS.has(kind)) {
    const event = typeof item.event === "string" ? item.event.trim().toLowerCase() : "";
    return event ? { kind, event } : null;
  }
  const period = item.period === undefined || item.period === null ? undefined : Number(item.period);
  return { kind, ...(period !== undefined && Number.isFinite(period) ? { period: Math.max(1, Math.round(period)) } : {}) };
}

/** Every event root a spec depends on, so callers know which events to load. */
export function specEventRoots(spec: StrategySpec): string[] {
  const roots = [...spec.entry, ...spec.exit]
    .flatMap((condition) => [condition.left, condition.right])
    .flatMap((operand) => operand.kind !== "value" && CALENDAR_KINDS.has(operand.kind) && operand.event ? [operand.event] : []);
  return [...new Set(roots)];
}

function normalizeCondition(value: unknown): Condition | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const left = normalizeOperand(item.left);
  const right = normalizeOperand(item.right);
  if (!left || !right || !OPS.has(item.op as ConditionOp)) return null;
  return { left, op: item.op as ConditionOp, right };
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalNumber(value: unknown) {
  const number = Number(value);
  return value === undefined || value === null || value === "" || !Number.isFinite(number) ? null : number;
}

/** Validates and normalises an untrusted spec (from the LLM or the UI). Returns errors instead of throwing. */
export function normalizeSpec(input: unknown, today: string): { spec: StrategySpec | null; errors: string[] } {
  const errors: string[] = [];
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const hypothesisRaw = (raw.hypothesis && typeof raw.hypothesis === "object" ? raw.hypothesis : {}) as Record<string, unknown>;
  const hypothesis: StrategyHypothesis = { thesis: text(hypothesisRaw.thesis), mechanism: text(hypothesisRaw.mechanism), prediction: text(hypothesisRaw.prediction), falsification: text(hypothesisRaw.falsification) };
  if (!hypothesis.thesis) errors.push("hypothesis.thesis(탑다운 논제)가 필요합니다.");
  if (!hypothesis.falsification) errors.push("hypothesis.falsification(반증 조건)이 필요합니다.");
  const universe = (Array.isArray(raw.universe) ? raw.universe : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 12);
  if (!universe.length) errors.push("universe(종목 1개 이상)가 필요합니다.");
  const entry = (Array.isArray(raw.entry) ? raw.entry : []).map(normalizeCondition).filter((item): item is Condition => item !== null);
  const exit = (Array.isArray(raw.exit) ? raw.exit : []).map(normalizeCondition).filter((item): item is Condition => item !== null);
  if (!entry.length) errors.push("entry 조건이 1개 이상 필요합니다.");
  const holdingRaw = (raw.holding && typeof raw.holding === "object" ? raw.holding : {}) as Record<string, unknown>;
  const periodRaw = (raw.period && typeof raw.period === "object" ? raw.period : {}) as Record<string, unknown>;
  const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const to = isDate(periodRaw.to) && periodRaw.to <= today ? periodRaw.to : today;
  const defaultFrom = new Date(`${to}T00:00:00Z`);
  defaultFrom.setUTCFullYear(defaultFrom.getUTCFullYear() - 5);
  const from = isDate(periodRaw.from) && periodRaw.from < to ? periodRaw.from : defaultFrom.toISOString().slice(0, 10);
  const criteriaRaw = (raw.successCriteria && typeof raw.successCriteria === "object" ? raw.successCriteria : {}) as Record<string, unknown>;
  const proposed: SuccessCriteria = {};
  for (const key of ["minSharpe", "minExcessCagrPct", "maxDrawdownPct", "minTrades", "minWinRatePct"] as const) { const value = optionalNumber(criteriaRaw[key]); if (value !== null) proposed[key] = value; }
  const { criteria, adjustments } = applyCriteriaFloors(proposed);
  const spec: StrategySpec = {
    version: 1, name: text(raw.name, "이름 없는 전략").slice(0, 80), hypothesis, universe, benchmark: text(raw.benchmark, "SPY").toUpperCase(),
    entry, exit, holding: { maxSessions: optionalNumber(holdingRaw.maxSessions), stopLossPct: optionalNumber(holdingRaw.stopLossPct), takeProfitPct: optionalNumber(holdingRaw.takeProfitPct) },
    sizing: { mode: "equal_weight", positionPct: optionalNumber((raw.sizing as Record<string, unknown> | undefined)?.positionPct) },
    costBps: Math.max(0, optionalNumber(raw.costBps) ?? 5), period: { from, to }, successCriteria: criteria,
    notes: [...(Array.isArray(raw.notes) ? raw.notes.map(String).slice(0, 8) : []), ...adjustments],
  };
  return { spec: errors.length ? null : spec, errors };
}

export function warmupDays(spec: StrategySpec) {
  const periods = [...spec.entry, ...spec.exit].flatMap((condition) => [condition.left, condition.right]).map((operand) => operand.kind === "value" || CALENDAR_KINDS.has(operand.kind) ? 0 : operand.period ?? defaultPeriod(operand.kind));
  return Math.max(60, Math.ceil(Math.max(0, ...periods) * 1.6) + 30);
}

export { dailyReturns };
