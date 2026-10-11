import { ctFillPrice } from "./market-precision.ts";
import { ctStockSession } from "./ct-sessions.ts";
import Decimal from "decimal.js";
import {
  CT_ENGINE,
  ctSpecSchema,
  type CTCondition,
  type CTContract,
  type CTSpec,
} from "./ct-spec.ts";

export type CTBar = {
  startMs: number;
  endMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type CTSignal = {
  symbol: string;
  decidedAt: number;
  validUntil: number;
  reference: number;
  patternFrom: number;
  patternLow: number;
  resistance: number;
  support: number;
  stages: Array<{ index: number; at: number; values: number[] }>;
  references?: Array<{ feature: string; price: number; observedAt: number }>;
  swings: Array<{
    kind: "high" | "low";
    at: number;
    confirmedAt: number;
    price: number;
  }>;
};
export type CTTrade = {
  symbol: string;
  signal: CTSignal;
  entryAt: number;
  exitAt: number;
  entry: number;
  exit: number;
  quantity: number;
  fees: number;
  executionCost?: number;
  pnl: number;
  reason: string;
  specHash: string;
  compliant: boolean;
};
export type CTResult = {
  engine: string;
  status: "measured" | "no_trades" | "data_error";
  bars: number;
  trades: CTTrade[];
  tradeCount?: number;
  signals: number;
  missed: number;
  costs: number;
  feeCosts?: number;
  spreadSlippageCosts?: number;
  grossReturnPct?: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  payoff: number;
  expectancy: number;
  compliancePct: number;
  daily: Array<{ date: string; equity: number; returnPct: number }>;
  concentrationPct: number;
  maxMonthConcentrationPct: number;
  emptyDays: number;
  diagnostics: string[];
  blocked: Record<string, number>;
};
export function validCTBar(b: CTBar) {
  return (
    [b.startMs, b.endMs, b.open, b.high, b.low, b.close, b.volume].every(
      Number.isFinite,
    ) &&
    b.endMs > b.startMs &&
    b.low > 0 &&
    b.volume > 0 &&
    b.high >= Math.max(b.open, b.close) &&
    b.low <= Math.min(b.open, b.close)
  );
}
export function qualityCT(bars: CTBar[], minutes: number) {
  let invalid = 0,
    duplicate = 0,
    gaps = 0;
  const seen = new Set<number>();
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!validCTBar(b) || b.endMs - b.startMs !== minutes * 60_000) invalid++;
    if (seen.has(b.endMs)) duplicate++;
    seen.add(b.endMs);
    if (i && b.startMs !== bars[i - 1].endMs) gaps++;
  }
  return {
    bars: bars.length,
    invalid,
    duplicate,
    gaps,
    fromMs: bars[0]?.startMs ?? null,
    toMs: bars.at(-1)?.endMs ?? null,
  };
}
export function ctSwings(bars: CTBar[], nowMs: number, width = 2) {
  const result: CTSignal["swings"] = [];
  for (let i = width; i + width < bars.length; i++) {
    const confirmedAt = bars[i + width].endMs;
    if (confirmedAt > nowMs) break;
    const neighbors = bars.slice(i - width, i + width + 1);
    if (neighbors.some((b, j) => j && b.startMs !== neighbors[j - 1].endMs))
      continue;
    if (neighbors.every((b, j) => j === width || b.high < bars[i].high))
      result.push({
        kind: "high",
        at: bars[i].startMs,
        confirmedAt,
        price: bars[i].high,
      });
    if (neighbors.every((b, j) => j === width || b.low > bars[i].low))
      result.push({
        kind: "low",
        at: bars[i].startMs,
        confirmedAt,
        price: bars[i].low,
      });
  }
  return result;
}
function higherBars(bars: CTBar[], factor: number, nowMs: number) {
  if (factor === 1) return bars.filter((b) => b.endMs <= nowMs);
  const size = (bars[0].endMs - bars[0].startMs) * factor;
  const groups = new Map<number, CTBar[]>();
  for (const b of bars) {
    const at = Math.floor(b.startMs / size) * size;
    const rows = groups.get(at) ?? [];
    rows.push(b);
    groups.set(at, rows);
  }
  return [...groups].flatMap(([at, rows]) =>
    rows.length === factor &&
    at + size <= nowMs &&
    rows.every((b, i) => b.startMs === at + i * size)
      ? [
          {
            startMs: at,
            endMs: at + size,
            open: rows[0].open,
            close: rows.at(-1)!.close,
            high: Math.max(...rows.map((b) => b.high)),
            low: Math.min(...rows.map((b) => b.low)),
            volume: rows.reduce((s, b) => s + b.volume, 0),
          },
        ]
      : [],
  );
}
export function ctFeature(
  condition: CTCondition,
  input: CTBar[],
  nowMs: number,
): number | null {
  const full = higherBars(input, condition.timeframe, nowMs);
  const end = full.length - condition.offset;
  const rows = full.slice(Math.max(0, end - condition.lookback - 1), end);
  if (
    rows.length !== condition.lookback + 1 ||
    rows.some(
      (b, i) => !validCTBar(b) || (i > 0 && b.startMs !== rows[i - 1].endMs),
    )
  )
    return null;
  const current = rows.at(-1)!,
    prior = rows.slice(0, -1);
  const high = Math.max(...prior.map((b) => b.high)),
    low = Math.min(...prior.map((b) => b.low));
  const avg = (xs: number[]) => xs.reduce((s, n) => s + n, 0) / xs.length;
  switch (condition.feature) {
    case "return_pct":
      return (current.close / prior[0].close - 1) * 100;
    case "sma_distance_pct":
      return (current.close / avg(prior.map((b) => b.close)) - 1) * 100;
    case "range_pct":
      return (high / low - 1) * 100;
    case "volume_ratio":
      return current.volume / avg(prior.map((b) => b.volume));
    case "contraction_ratio": {
      const cut = Math.floor(prior.length / 2);
      return (
        avg(prior.slice(cut).map((b) => (b.high - b.low) / b.close)) /
        Math.max(
          1e-12,
          avg(prior.slice(0, cut).map((b) => (b.high - b.low) / b.close)),
        )
      );
    }
    case "prior_high_distance_pct":
      return (current.close / high - 1) * 100;
    case "prior_low_distance_pct":
      return (current.close / low - 1) * 100;
    case "range_position":
      return (current.close - low) / Math.max(high - low, 1e-12);
    case "swing_high_distance_pct":
    case "swing_low_distance_pct": {
      const kind =
        condition.feature === "swing_high_distance_pct" ? "high" : "low";
      const swing = ctSwings(rows, current.endMs)
        .filter((s) => s.kind === kind)
        .at(-1);
      return swing ? (current.close / swing.price - 1) * 100 : null;
    }
  }
}
function ctReference(condition: CTCondition, input: CTBar[], now: number) {
  const full = higherBars(input, condition.timeframe, now),
    end = full.length - condition.offset,
    rows = full.slice(Math.max(0, end - condition.lookback - 1), end),
    prior = rows.slice(0, -1);
  if (rows.length !== condition.lookback + 1) return null;
  if (condition.feature === "prior_high_distance_pct")
    return Math.max(...prior.map((b) => b.high));
  if (condition.feature === "prior_low_distance_pct")
    return Math.min(...prior.map((b) => b.low));
  if (condition.feature === "sma_distance_pct")
    return prior.reduce((sum, b) => sum + b.close, 0) / prior.length;
  if (condition.feature.startsWith("swing_")) {
    const kind =
      condition.feature === "swing_high_distance_pct" ? "high" : "low";
    return (
      ctSwings(rows, now)
        .filter((s) => s.kind === kind)
        .at(-1)?.price ?? null
    );
  }
  return null;
}
/** One causal detector shared by historical replay and the trading runner. No models. */
export function detectCT(
  spec: CTSpec,
  symbol: string,
  input: CTBar[],
  nowMs: number,
): CTSignal | null {
  const bars = input.filter((b) => b.endMs <= nowMs).slice(-1800);
  const last = bars.at(-1);
  if (!last || !spec.symbols.includes(symbol) || !validCTBar(last)) return null;
  const matches: CTSignal["stages"] = [];
  let cursor = bars.length - 1;
  for (let phase = spec.stages.length - 1; phase >= 0; phase--) {
    const stage = spec.stages[phase];
    const lower =
      phase === spec.stages.length - 1
        ? cursor
        : Math.max(0, cursor - spec.stages[phase + 1].maxGapBars + 1);
    let found = false;
    for (let i = cursor; i >= lower; i--) {
      const values = stage.conditions.map((c) =>
        ctFeature(c, bars.slice(0, i + 1), bars[i].endMs),
      );
      if (
        values.every(
          (v, j) =>
            v !== null &&
            (stage.conditions[j].op === "gte"
              ? v >= stage.conditions[j].value
              : v <= stage.conditions[j].value),
        )
      ) {
        matches.unshift({
          index: i,
          at: bars[i].endMs,
          values: values as number[],
        });
        cursor = i - 1;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  const pattern = bars.slice(matches[0].index);
  if (pattern.some((b, i) => i && b.startMs !== pattern[i - 1].endMs))
    return null;
  const previous = bars.slice(Math.max(0, bars.length - 21), -1);
  return {
    symbol,
    decidedAt: last.endMs,
    validUntil: last.endMs + spec.minutes * 60_000,
    reference: last.close,
    patternFrom: pattern[0].startMs,
    patternLow: Math.min(...pattern.map((b) => b.low)),
    resistance: Math.max(...previous.map((b) => b.high)),
    support: Math.min(...previous.map((b) => b.low)),
    stages: matches,
    references: matches.flatMap((m, i) =>
      spec.stages[i].conditions.flatMap((c) => {
        const price = ctReference(c, bars.slice(0, m.index + 1), m.at);
        return price === null
          ? []
          : [{ feature: c.feature, price, observedAt: m.at }];
      }),
    ),
    swings: ctSwings(bars.slice(-120), last.endMs),
  };
}
export function ctExit(
  spec: CTSpec,
  signal: CTSignal,
  entry: number,
  entryAt: number,
  bar: CTBar,
) {
  const stop = Math.max(
    entry * (1 - spec.exit.stopPct / 100),
    spec.exit.invalidation === "last_stage_low" ? signal.patternLow : 0,
  );
  const target = entry * (1 + spec.exit.targetPct / 100);
  // A gap through the stop fills at the adverse open. Ambiguous bars are stop-first.
  if (bar.low <= stop)
    return { price: Math.min(stop, bar.open), reason: "stop" };
  if (bar.high >= target)
    return { price: bar.open >= target ? bar.open : target, reason: "target" };
  if (bar.endMs - entryAt >= spec.exit.maxHoldBars * spec.minutes * 60_000)
    return { price: bar.close, reason: "time" };
  return null;
}
export function ctQuantity(
  spec: CTSpec,
  contract: CTContract,
  cash: number,
  equity: number,
  price: number,
  volume: number,
) {
  if (
    ![cash, equity, price, volume].every(Number.isFinite) ||
    cash <= 0 ||
    equity <= 0 ||
    price <= 0 ||
    volume <= 0
  )
    return 0;
  const quantity = Decimal.min(
    new Decimal(cash)
      .mul(0.99)
      .div(
        new Decimal(price).mul(
          new Decimal(1).plus(new Decimal(contract.costs.feePct).div(100)),
        ),
      ),
    new Decimal(equity).mul(spec.sizing.allocationPct).div(100).div(price),
    new Decimal(equity)
      .mul(spec.sizing.riskPct)
      .div(spec.exit.stopPct)
      .div(price),
    new Decimal(volume).mul(spec.sizing.participationPct).div(100),
  ).toDecimalPlaces(contract.costs.quantityDecimals, Decimal.ROUND_DOWN);
  return quantity.mul(price).gte(contract.costs.minimumOrder)
    ? quantity.toNumber()
    : 0;
}
const dateFormats = {
  crypto: new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }),
  stock: new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }),
};
const stockClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function ctDate(ms: number, market: CTContract["market"]) {
  return dateFormats[market].format(new Date(ms));
}
export function ctSessionClosing(ms: number) {
  const session = ctStockSession(ctDate(ms, "stock"));
  if (!session) return true;
  const [hour, minute] = session.close.split(":").map(Number),
    time = stockClock.format(new Date(ms)).split(":").map(Number);
  return time[0] * 60 + time[1] >= hour * 60 + minute - 1;
}
export function replayCT(
  specInput: CTSpec,
  data: Record<string, CTBar[]>,
  contract: CTContract,
  fromMs: number,
  toMs: number,
  hash: string,
  options: {
    costMultiplier?: number;
    delayBars?: number;
    deadline?: number;
  } = {},
): CTResult {
  const spec = ctSpecSchema.parse(specInput),
    multiplier = options.costMultiplier ?? 1;
  const result: CTResult = {
    engine: CT_ENGINE,
    status: "no_trades",
    bars: 0,
    trades: [],
    signals: 0,
    missed: 0,
    costs: 0,
    netReturnPct: 0,
    maxDrawdownPct: 0,
    winRatePct: 0,
    payoff: 0,
    expectancy: 0,
    compliancePct: 100,
    daily: [],
    concentrationPct: 0,
    maxMonthConcentrationPct: 0,
    emptyDays: 0,
    diagnostics: [],
    blocked: {},
  };
  if (
    Object.values(data).some(
      (b) =>
        qualityCT(b, spec.minutes).invalid ||
        qualityCT(b, spec.minutes).duplicate,
    )
  ) {
    result.status = "data_error";
    result.diagnostics.push("비정상·중복 데이터");
    return result;
  }
  let cash = contract.capital,
    peak = cash,
    lastExit = -Infinity,
    day = "",
    dayStart = cash;
  let held: {
    symbol: string;
    signal: CTSignal;
    entry: number;
    at: number;
    quantity: number;
    fee: number;
    entryImpact: number;
    checkedThrough: number;
  } | null = null;
  let pending: { symbol: string; signal: CTSignal; index: number } | null =
    null;
  const times = [
    ...new Set(
      spec.symbols.flatMap((s) =>
        (data[s] ?? [])
          .filter((b) => b.endMs > fromMs && b.endMs <= toMs)
          .map((b) => b.endMs),
      ),
    ),
  ].sort((a, b) => a - b);
  const indexes = Object.fromEntries(
    spec.symbols.map((s) => [
      s,
      new Map((data[s] ?? []).map((b, i) => [b.endMs, i])),
    ]),
  );
  const addBlock = (reason: string) => {
    result.blocked[reason] = (result.blocked[reason] ?? 0) + 1;
  };
  let marked = cash;
  const recordDay = () => {
    if (day)
      result.daily.push({
        date: day,
        equity: marked,
        returnPct: (marked / dayStart - 1) * 100,
      });
  };
  for (const time of times) {
    if (options.deadline && Date.now() > options.deadline)
      throw new Error("CT 계산 시간 상한");
    const date = ctDate(time - 1, contract.market);
    if (date !== day) {
      recordDay();
      day = date;
      dayStart = marked;
    }
    result.bars++;
    if (pending && !held) {
      const i = indexes[pending.symbol].get(time),
        rows = data[pending.symbol],
        bar = i === undefined ? null : rows[i];
      if (bar && i! >= pending.index + 1 + (options.delayBars ?? 0)) {
        const signal = pending.signal;
        if (
          bar.startMs !==
          signal.decidedAt + (options.delayBars ?? 0) * spec.minutes * 60000
        ) {
          result.missed++;
          pending = null;
          addBlock("data_gap");
        } else {
          const impact =
            (contract.costs.spreadPct / 2 + contract.costs.slippagePct) *
            multiplier;
          const price = ctFillPrice(
              bar.open * (1 + impact / 100),
              contract.market,
              "buy",
            ),
            feePct = (contract.costs.feePct * multiplier) / 100;
          const q = ctQuantity(
            spec,
            contract,
            cash,
            cash,
            price,
            Math.min(rows[pending.index].volume, bar.volume),
          );
          if (
            q &&
            (spec.exit.invalidation !== "last_stage_low" ||
              price > signal.patternLow) &&
            Math.abs(price / signal.reference - 1) * 100 <=
              spec.entry.maxDeviationPct &&
            contract.costs.spreadPct * multiplier <= spec.entry.maxSpreadPct
          ) {
            held = {
              symbol: pending.symbol,
              signal,
              entry: price,
              at: bar.startMs,
              quantity: q,
              fee: q * price * feePct,
              entryImpact: q * (price - bar.open),
              checkedThrough: bar.startMs,
            };
            cash -= q * price + held.fee;
          } else {
            result.missed++;
            addBlock("liquidity_or_deviation");
          }
          pending = null;
        }
      }
    }
    if (held) {
      const i = indexes[held.symbol].get(time),
        bar = i === undefined ? null : data[held.symbol][i];
      if (bar) {
        if (bar.startMs !== held.checkedThrough) {
          result.status = "data_error";
          result.diagnostics.push("보유 중 누락 봉 · 청산 검증 불가");
          return result;
        }
        held.checkedThrough = bar.endMs;
        const lowEquity =
          cash +
          held.quantity *
            bar.low *
            (1 -
              ((contract.costs.feePct + contract.costs.sellTaxPct) *
                multiplier) /
                100);
        result.maxDrawdownPct = Math.max(
          result.maxDrawdownPct,
          (1 - lowEquity / peak) * 100,
        );
        const exit =
          ctExit(spec, held.signal, held.entry, held.at, bar) ??
          (contract.market === "stock" && ctSessionClosing(bar.endMs)
            ? { price: bar.close, reason: "session" }
            : null);
        if (exit) {
          const price = ctFillPrice(
            exit.price *
              (1 -
                ((contract.costs.spreadPct / 2 + contract.costs.slippagePct) *
                  multiplier) /
                  100),
            contract.market,
            "sell",
          );
          const fees =
            held.fee +
            (held.quantity *
              price *
              (contract.costs.feePct + contract.costs.sellTaxPct) *
              multiplier) /
              100;
          const pnl = (price - held.entry) * held.quantity - fees;
          cash += held.quantity * price - (fees - held.fee);
          result.trades.push({
            symbol: held.symbol,
            signal: held.signal,
            entryAt: held.at,
            exitAt: bar.endMs,
            entry: held.entry,
            exit: price,
            quantity: held.quantity,
            fees,
            executionCost:
              held.entryImpact + held.quantity * (exit.price - price),
            pnl,
            reason: exit.reason,
            specHash: hash,
            compliant: true,
          });
          lastExit = time;
          held = null;
        }
        marked = held
          ? cash +
            held.quantity *
              bar.close *
              (1 -
                ((contract.costs.feePct + contract.costs.sellTaxPct) *
                  multiplier) /
                  100)
          : cash;
      }
    } else marked = cash;
    peak = Math.max(peak, marked);
    result.maxDrawdownPct = Math.max(
      result.maxDrawdownPct,
      (1 - marked / peak) * 100,
    );
    if (
      !held &&
      !pending &&
      time - lastExit >= spec.sizing.cooldownBars * spec.minutes * 60000 &&
      marked >= dayStart * 0.97 &&
      result.maxDrawdownPct < 15 &&
      !(contract.market === "stock" && ctSessionClosing(time))
    ) {
      for (const symbol of spec.symbols) {
        const i = indexes[symbol].get(time);
        if (i === undefined) continue;
        // Purged split: pattern history and positions never cross the evaluation boundary.
        const rows = data[symbol]
          .slice(Math.max(0, i - 1800), i + 1)
          .filter((b) => b.startMs >= fromMs);
        const signal = detectCT(spec, symbol, rows, time);
        if (signal) {
          result.signals++;
          pending = { symbol, signal, index: i };
          break;
        }
      }
    }
  }
  if (held) {
    result.diagnostics.push(
      "평가 경계의 미청산 포지션: 신규 구간으로 이월하지 않음",
    );
    const price = ctFillPrice(
      data[held.symbol].filter((b) => b.endMs <= toMs).at(-1)!.close *
        (1 -
          ((contract.costs.spreadPct / 2 + contract.costs.slippagePct) *
            multiplier) /
            100),
      contract.market,
      "sell",
    );
    const fees =
      held.fee +
      (held.quantity *
        price *
        (contract.costs.feePct + contract.costs.sellTaxPct) *
        multiplier) /
        100;
    cash += held.quantity * price - (fees - held.fee);
    result.trades.push({
      symbol: held.symbol,
      signal: held.signal,
      entryAt: held.at,
      exitAt: toMs,
      entry: held.entry,
      exit: price,
      quantity: held.quantity,
      fees,
      executionCost:
        held.entryImpact +
        held.quantity *
          (data[held.symbol].filter((b) => b.endMs <= toMs).at(-1)!.close -
            price),
      pnl: (price - held.entry) * held.quantity - fees,
      reason: "boundary",
      specHash: hash,
      compliant: true,
    });
    marked = cash;
  }
  recordDay();
  const wins = result.trades.filter((t) => t.pnl > 0),
    losses = result.trades.filter((t) => t.pnl <= 0);
  result.status = result.trades.length ? "measured" : "no_trades";
  result.netReturnPct = (cash / contract.capital - 1) * 100;
  result.feeCosts = result.trades.reduce((s, t) => s + t.fees, 0);
  result.spreadSlippageCosts = result.trades.reduce(
    (s, t) => s + (t.executionCost ?? 0),
    0,
  );
  result.costs = result.feeCosts + result.spreadSlippageCosts;
  result.grossReturnPct =
    result.netReturnPct + (result.costs / contract.capital) * 100;
  result.winRatePct = (wins.length / Math.max(1, result.trades.length)) * 100;
  result.expectancy =
    result.trades.reduce((s, t) => s + t.pnl, 0) /
    Math.max(1, result.trades.length);
  result.payoff =
    wins.reduce((s, t) => s + t.pnl, 0) /
    Math.max(1, wins.length) /
    Math.max(
      1e-9,
      -losses.reduce((s, t) => s + t.pnl, 0) / Math.max(1, losses.length),
    );
  const contribution = (key: (t: CTTrade) => string) => {
    const map = new Map<string, number>();
    for (const t of result.trades)
      map.set(key(t), (map.get(key(t)) ?? 0) + Math.max(0, t.pnl));
    return (
      (Math.max(0, ...map.values()) /
        Math.max(
          1e-9,
          [...map.values()].reduce((s, v) => s + v, 0),
        )) *
      100
    );
  };
  result.concentrationPct = contribution((t) => t.symbol);
  result.maxMonthConcentrationPct = contribution((t) =>
    ctDate(t.exitAt, contract.market).slice(0, 7),
  );
  result.emptyDays = result.daily.filter(
    (d) =>
      !result.trades.some((t) => ctDate(t.exitAt, contract.market) === d.date),
  ).length;
  if (result.status === "no_trades")
    result.diagnostics.push("신호/거래 표본 부족");
  if (result.costs > result.trades.reduce((s, t) => s + t.pnl + t.fees, 0))
    result.diagnostics.push("비용 잠식");
  if (result.concentrationPct > 80) result.diagnostics.push("종목 수익 집중");
  if (result.netReturnPct <= 0)
    result.diagnostics.push("비용 후 양의 엣지 미확인");
  return result;
}
export function ctGate(result: CTResult, contract: CTContract) {
  return [
    result.status !== "measured" && "측정된 거래 없음",
    (result.tradeCount ?? result.trades.length) < contract.policy.minTrades &&
      "거래 표본 부족",
    result.netReturnPct <= contract.policy.minNetReturnPct &&
      "비용 후 수익 기준 미달",
    result.maxDrawdownPct > contract.policy.maxDrawdownPct && "낙폭 초과",
    result.compliancePct < contract.policy.minCompliancePct && "규칙 준수 미달",
    contract.symbols.length > 1 &&
      result.concentrationPct > contract.policy.maxSymbolConcentrationPct &&
      "종목 집중",
    result.maxMonthConcentrationPct > 80 && "시기 집중",
  ].filter(Boolean) as string[];
}
export function ctSummary(result: CTResult) {
  const { trades, ...summary } = result;
  return { ...summary, tradeCount: result.tradeCount ?? trades.length };
}

/** Small state checkpoint; all executions are persisted separately by the replay tool. */
export function ctCheckpointResult(result: CTResult): CTResult {
  const rows = result.trades;
  const chosen = [
    ...rows.slice(0, 2),
    ...rows.filter((t) => t.pnl < 0).slice(0, 2),
    ...rows.filter((t) => t.pnl >= 0).slice(0, 2),
    ...rows.slice(-2),
  ];
  const trades = [
    ...new Map(chosen.map((t) => [`${t.symbol}:${t.entryAt}`, t])).values(),
  ].sort((a, b) => a.entryAt - b.entryAt);
  return { ...result, tradeCount: result.tradeCount ?? rows.length, trades };
}
