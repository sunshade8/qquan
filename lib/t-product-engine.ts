/** Product-aware event reducer. Simulation, shadow and broker executors consume the same intents and risk effects. */
import {
  ctNativePnl,
  ctRequiredMargin,
  ctFunding,
  ctRiskQuantity,
  ctBorrowStep,
  ctOptionSettlement,
} from "./t-accounting.ts";
import {
  ctInstrumentKey,
  ctInstrumentSchema,
  type CTInstrument,
} from "./t-capabilities.ts";
import type { CTBar } from "./t-engine.ts";
export const CT_ACCOUNTING_ENGINE = "ct-accounting-1";
export type CTProductPosition = {
  id: string;
  owner: string;
  instrument: CTInstrument;
  quantity: number;
  entry: number;
  stop: number;
  target: number | null;
  openedAt: number;
  expiresAt: number;
  margin: number;
  fees: number;
  funding: number;
  interest: number;
  peak: number;
  trailPct: number | null;
  breakevenR: number | null;
  initialRisk: number;
  feesReport: number;
  fundingReport: number;
  interestReport: number;
};
export type CTProductIntent = {
  id: string;
  owner: string;
  instrument: CTInstrument;
  kind: "enter" | "close";
  quantity?: number;
  stop?: number;
  target?: number;
  expiresAt: number;
  riskPct: number;
  maxNotional: number;
  step: string;
  trailPct?: number;
  breakevenR?: number;
  decidedAt?: number;
};
export type CTProductEvent =
  | {
      id: string;
      at: number;
      kind: "bar";
      instrument: CTInstrument;
      bar: CTBar;
      mark?: CTBar;
      reportFx: number;
      maintenanceRate: number | null;
    }
  | {
      id: string;
      at: number;
      kind: "funding";
      instrument: CTInstrument;
      rate: number;
      mark: number;
      reportFx: number;
    }
  | {
      id: string;
      at: number;
      kind: "debt";
      asset: string;
      operation: "borrow" | "repay" | "interest";
      amount: number;
    }
  | {
      id: string;
      at: number;
      kind: "expiry";
      instrument: Extract<CTInstrument, { product: "options" }>;
      underlying: number;
      reportFx: number;
    }
  | { id: string; at: number; kind: "stop" };
export type CTProductEffect = {
  id: string;
  kind: "order_intent" | "rejected" | "closed";
  positionId?: string;
  instrument?: CTInstrument;
  side?: "BUY" | "SELL";
  quantity?: number;
  price?: number;
  reason: string;
  nativePnl?: number;
  nativeCurrency?: string;
  reportPnl?: number;
  reportFx?: number;
  fees?: number;
};
export type CTProductState = {
  owner: string;
  cash: number;
  capital: number;
  peakEquity: number;
  lastAt: number;
  seen: string[];
  stopping: boolean;
  positions: CTProductPosition[];
  debts: Record<string, { principal: number; interest: number }>;
  pending: CTProductIntent[];
  trades: CTProductEffect[];
  dailyLoss: number;
  maxGross: number;
  maxPositions: number;
  maxDrawdownPct: number;
  mode: "replay" | "shadow" | "paper" | "live";
  feePct: number;
  costMultiplier: number;
};
export function ctProductInitial(
  owner: string,
  capital: number,
  mode: CTProductState["mode"] = "replay",
): CTProductState {
  if (!(capital > 0)) throw new Error("초기 자본 오류");
  return {
    owner,
    cash: capital,
    capital,
    peakEquity: capital,
    lastAt: 0,
    seen: [],
    stopping: false,
    positions: [],
    debts: {},
    pending: [],
    trades: [],
    dailyLoss: 0,
    maxGross: capital,
    maxPositions: 1,
    maxDrawdownPct: 0,
    mode,
    feePct: 0.1,
    costMultiplier: 1,
  };
}
const sideOf = (i: CTInstrument) =>
  i.product === "options"
    ? i.contractSide === "buy"
      ? 1
      : -1
    : i.direction === "long"
      ? 1
      : -1;
const portfolio = (i: CTInstrument) =>
  i.product === "options"
    ? i.marginMode === "portfolio"
    : "collateralMode" in i &&
      ["multi-asset", "portfolio", "portfolio-pro"].includes(i.collateralMode);
/** No external I/O and no access to bars following event.at. Immutable input, stable effect IDs. */
export function ctDecisionStep(
  previous: CTProductState,
  event: CTProductEvent,
  intent?: CTProductIntent,
): { state: CTProductState; effects: CTProductEffect[] } {
  if (previous.seen.includes(event.id)) return { state: previous, effects: [] };
  if (event.at < previous.lastAt)
    throw new Error("역순 시장 이벤트 · 재정렬/대사 필요");
  const s = structuredClone(previous),
    effects: CTProductEffect[] = [];
  s.seen.push(event.id);
  s.lastAt = event.at;
  const reject = (reason: string) =>
    effects.push({
      id: `${event.id}:reject:${intent?.id ?? ""}`,
      kind: "rejected",
      reason,
    });
  if (intent) {
    ctInstrumentSchema.parse(intent.instrument);
    if (intent.owner !== s.owner) reject("다른 소유자의 주문 의도");
    else if (s.stopping) reject("종료 중 신규 진입 금지");
    else if (intent.expiresAt <= event.at) reject("만료 의도");
    else if (portfolio(intent.instrument))
      reject("계좌 전체 haircut/PM 위험 snapshot 필요");
    else if (!s.pending.some((p) => p.id === intent.id))
      s.pending.push({ ...structuredClone(intent), decidedAt: event.at });
  }
  if (event.kind === "stop") {
    s.stopping = true;
    s.pending = [];
    return {
      state: s,
      effects: s.positions.map((p) => ({
        id: `${event.id}:${p.id}:close`,
        kind: "order_intent",
        positionId: p.id,
        instrument: p.instrument,
        side: sideOf(p.instrument) === 1 ? "SELL" : "BUY",
        quantity: p.quantity,
        reason: "CT 소유 포지션 정리 · 실제 체결 확인 필요",
      })),
    };
  }
  if (event.kind === "debt") {
    s.debts[event.asset] = ctBorrowStep(
      s.debts[event.asset] ?? { principal: 0, interest: 0 },
      { kind: event.operation, amount: event.amount },
    );
    return { state: s, effects };
  }
  const key = ctInstrumentKey(event.instrument);
  let positions = s.positions.filter(
    (p) => ctInstrumentKey(p.instrument) === key,
  );
  if (event.kind === "funding") {
    for (const p of positions)
      if (p.openedAt < event.at) {
        const native = ctFunding(
            p.instrument,
            p.quantity,
            event.mark,
            event.rate,
          ),
          stress = native < 0 ? native * s.costMultiplier : native;
        p.funding += stress;
        p.fundingReport += stress * event.reportFx;
        s.cash += stress * event.reportFx;
      }
    return { state: s, effects };
  }
  const close = (
    p: CTProductPosition,
    price: number,
    reason: string,
    fx: number,
    optionUnderlying?: number,
  ) => {
    const native =
      optionUnderlying !== undefined && p.instrument.product === "options"
        ? ctOptionSettlement(
            p.instrument,
            p.quantity,
            p.entry,
            optionUnderlying,
            event.at,
          )
        : ctNativePnl(p.instrument, p.quantity, p.entry, price);
    const exitFee =
      p.instrument.product === "coinm"
        ? ((((p.quantity * p.instrument.contractSize) / price) * s.feePct) /
            100) *
          s.costMultiplier
        : ((p.quantity *
            price *
            (p.instrument.product === "options" ? p.instrument.multiplier : 1) *
            s.feePct) /
            100) *
          s.costMultiplier;
    const pnl = (native - exitFee) * fx;
    s.cash += pnl;
    s.dailyLoss += Math.max(0, -pnl);
    const trade: CTProductEffect = {
      id: `${event.id}:${p.id}:closed`,
      kind: "closed",
      positionId: p.id,
      instrument: p.instrument,
      quantity: p.quantity,
      price,
      reason,
      nativePnl: native - exitFee - p.fees + p.funding - p.interest,
      nativeCurrency: p.instrument.settlement,
      reportPnl:
        (native - exitFee) * fx -
        p.feesReport +
        p.fundingReport -
        p.interestReport,
      reportFx: fx,
      fees: exitFee + p.fees,
    };
    s.trades.push(trade);
    effects.push(trade);
    s.positions = s.positions.filter((x) => x.id !== p.id);
  };
  if (event.kind === "expiry") {
    for (const p of positions) {
      if (p.instrument.product !== "options")
        throw new Error("만기 상품 불일치");
      const intrinsic = Math.max(
        0,
        p.instrument.right === "CALL"
          ? event.underlying - p.instrument.strike
          : p.instrument.strike - event.underlying,
      );
      close(
        p,
        Math.max(Number.MIN_VALUE, intrinsic),
        "expiry",
        event.reportFx,
        event.underlying,
      );
    }
    return { state: s, effects };
  }
  if (
    event.bar.endMs !== event.at ||
    event.bar.startMs >= event.bar.endMs ||
    event.reportFx <= 0
  )
    throw new Error("미완성 봉/환율 오류");
  const derivative =
    event.instrument.product === "usdm" || event.instrument.product === "coinm";
  if (derivative && (!event.mark || event.maintenanceRate === null)) {
    reject("상품 mark 경로/유지증거금 자료 없음 · 평가 불가");
    return { state: s, effects };
  }

  const eligible = (p: CTProductIntent) =>
    ctInstrumentKey(p.instrument) === key &&
    (p.decidedAt ?? 0) <= event.bar.startMs;
  const pending = s.pending.filter(eligible);
  s.pending = s.pending.filter((p) => !eligible(p));
  for (const p of pending) {
    if (p.expiresAt <= event.bar.startMs) {
      reject("실행 가능 시각에 만료");
      continue;
    }
    const held = s.positions.find(
      (x) =>
        x.owner === p.owner &&
        ctInstrumentKey(x.instrument) === key &&
        sideOf(x.instrument) === sideOf(p.instrument),
    );
    if (p.kind === "close") {
      if (held) close(held, event.bar.open, "intent_close", event.reportFx);
      else reject("소유 포지션 없음");
      continue;
    }
    if (
      held ||
      s.positions.length >= s.maxPositions ||
      s.dailyLoss >= s.capital * 0.03 ||
      s.maxDrawdownPct >= 15
    ) {
      reject("동시 포지션/일손실/낙폭 한도");
      continue;
    }
    if (p.stop === undefined) {
      reject("손절 없는 진입 거부");
      continue;
    }
    const used = s.positions.reduce(
        (sum, x) => sum + x.margin * event.reportFx,
        0,
      ),
      qty = ctRiskQuantity(p.instrument, {
        capital: s.cash,
        riskPct: p.riskPct,
        entry: event.bar.open,
        stop: p.stop,
        freeCollateral: Math.max(0, s.cash - used) / event.reportFx,
        maxNotional: Math.min(p.maxNotional, s.maxGross),
        step: p.step,
      });
    if (!(qty > 0)) {
      reject("담보/수량 부족");
      continue;
    }
    const fee =
      p.instrument.product === "coinm"
        ? ((((qty * p.instrument.contractSize) / event.bar.open) * s.feePct) /
            100) *
          s.costMultiplier
        : ((qty *
            event.bar.open *
            (p.instrument.product === "options" ? p.instrument.multiplier : 1) *
            s.feePct) /
            100) *
          s.costMultiplier;
    const position: CTProductPosition = {
      id: p.id,
      owner: p.owner,
      instrument: p.instrument,
      quantity: qty,
      entry: event.bar.open,
      stop: p.stop,
      target: p.target ?? null,
      openedAt: event.bar.startMs,
      expiresAt: p.expiresAt,
      margin: ctRequiredMargin(p.instrument, qty, event.bar.open),
      fees: fee,
      funding: 0,
      interest: 0,
      peak: event.bar.open,
      trailPct: p.trailPct ?? null,
      breakevenR: p.breakevenR ?? null,
      initialRisk: Math.abs(event.bar.open - p.stop),
      feesReport: fee * event.reportFx,
      fundingReport: 0,
      interestReport: 0,
    };
    effects.push({
      id: `${p.id}:order`,
      kind: "order_intent",
      positionId: p.id,
      instrument: p.instrument,
      side: sideOf(p.instrument) === 1 ? "BUY" : "SELL",
      quantity: qty,
      price: event.bar.open,
      reason: "위험 한도 통과 · 실행 의도",
    });
    // Shadow has no broker effects or positions; live positions come from reconciled fills, never an assumed fill.
    if (s.mode === "replay" || s.mode === "paper") {
      s.cash -= fee * event.reportFx;
      s.positions.push(position);
    }
  }
  positions = s.positions.filter((p) => ctInstrumentKey(p.instrument) === key);
  for (const p of positions) {
    const sign = sideOf(p.instrument),
      adverse = sign === 1 ? event.bar.low : event.bar.high;
    const liquidation =
      derivative &&
      p.margin +
        ctNativePnl(
          p.instrument,
          p.quantity,
          p.entry,
          sign === 1 ? event.mark!.low : event.mark!.high,
        ) <=
        p.margin *
          (event.maintenanceRate ?? 0) *
          ("leverage" in p.instrument ? p.instrument.leverage : 1);
    if (liquidation) {
      close(
        p,
        sign === 1 ? event.mark!.low : event.mark!.high,
        "liquidation_adverse_before_stop",
        event.reportFx,
      );
      continue;
    }
    if (sign * (adverse - p.stop) <= 0) {
      close(
        p,
        sign === 1
          ? Math.min(p.stop, event.bar.open)
          : Math.max(p.stop, event.bar.open),
        "stop",
        event.reportFx,
      );
      continue;
    }
    if (
      p.target !== null &&
      sign * ((sign === 1 ? event.bar.high : event.bar.low) - p.target) >= 0
    ) {
      close(
        p,
        sign === 1
          ? Math.max(p.target, event.bar.open)
          : Math.min(p.target, event.bar.open),
        "target",
        event.reportFx,
      );
      continue;
    }
    if (s.stopping || event.at >= p.expiresAt) {
      close(
        p,
        event.bar.close,
        s.stopping ? "stop_requested" : "max_hold",
        event.reportFx,
      );
      continue;
    }
    // A stop moved using this completed bar only takes effect on a subsequent bar.
    p.peak =
      sign === 1
        ? Math.max(p.peak, event.bar.high)
        : Math.min(p.peak, event.bar.low);
    if (
      p.breakevenR !== null &&
      sign * (p.peak - p.entry) >= p.initialRisk * p.breakevenR
    )
      p.stop =
        sign === 1 ? Math.max(p.stop, p.entry) : Math.min(p.stop, p.entry);
    if (p.trailPct !== null) {
      const trail = p.peak * (1 - (sign * p.trailPct) / 100);
      p.stop = sign === 1 ? Math.max(p.stop, trail) : Math.min(p.stop, trail);
    }
  }
  if (s.mode === "shadow")
    return {
      state: s,
      effects: effects.filter((e) => e.kind !== "order_intent"),
    };
  const equity =
    s.cash +
    s.positions
      .filter((p) => ctInstrumentKey(p.instrument) === key)
      .reduce(
        (sum, p) =>
          sum +
          ctNativePnl(p.instrument, p.quantity, p.entry, event.bar.close) *
            event.reportFx,
        0,
      );
  s.peakEquity = Math.max(s.peakEquity, equity);
  s.maxDrawdownPct = Math.max(
    s.maxDrawdownPct,
    (1 - equity / s.peakEquity) * 100,
  );
  return { state: s, effects };
}
