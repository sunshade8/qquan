import Decimal from "decimal.js";
import type { CTInstrument } from "./ct-capabilities.ts";
const D = (x: Decimal.Value) => new Decimal(x);
/** Native settlement money. Never multiply a price return by leverage. */
export function ctNativePnl(
  i: CTInstrument,
  qty: number,
  entry: number,
  exit: number,
) {
  if (!(qty > 0 && entry > 0 && exit > 0)) throw new Error("잘못된 회계 입력");
  if (i.product === "coinm")
    return D(qty)
      .mul(i.contractSize)
      .mul(D(1).div(entry).minus(D(1).div(exit)))
      .mul(i.direction === "long" ? 1 : -1)
      .toNumber();
  if (i.product === "options")
    return D(exit)
      .minus(entry)
      .mul(qty)
      .mul(i.multiplier)
      .mul(i.contractSide === "buy" ? 1 : -1)
      .toNumber();
  return D(exit)
    .minus(entry)
    .mul(qty)
    .mul("direction" in i && i.direction === "short" ? -1 : 1)
    .toNumber();
}
export function ctRequiredMargin(i: CTInstrument, qty: number, price: number) {
  if (i.product === "options") {
    if (i.contractSide === "sell")
      throw new Error("옵션 매도는 계좌 전체 증거금 모델 필요");
    return D(qty).mul(price).mul(i.multiplier).toNumber();
  }
  if (i.product === "coinm")
    return D(qty).mul(i.contractSize).div(price).div(i.leverage).toNumber();
  return D(qty).mul(price).div(i.leverage).toNumber();
}
export function ctRiskQuantity(
  i: CTInstrument,
  input: {
    capital: number;
    riskPct: number;
    entry: number;
    stop: number;
    freeCollateral: number;
    maxNotional: number;
    step: string;
  },
) {
  const { capital, riskPct, entry, stop, freeCollateral, maxNotional, step } =
    input;
  if (
    !(
      capital > 0 &&
      riskPct > 0 &&
      riskPct <= 1 &&
      entry > 0 &&
      stop > 0 &&
      freeCollateral >= 0 &&
      maxNotional > 0 &&
      D(step).gt(0)
    )
  )
    throw new Error("위험 입력 오류");
  if (
    "direction" in i &&
    (i.direction === "long" ? stop >= entry : stop <= entry)
  )
    throw new Error("손절 방향 오류");
  const loss = Math.abs(ctNativePnl(i, 1, entry, stop));
  if (!loss) throw new Error("손절 위험 없음");
  const budget =
    i.product === "coinm"
      ? (capital * riskPct) / 100 / entry
      : (capital * riskPct) / 100;
  const unitMargin = ctRequiredMargin(i, 1, entry),
    unitNotional =
      i.product === "coinm"
        ? i.contractSize
        : i.product === "options"
          ? entry * i.multiplier
          : entry;
  return D(
    Math.min(
      budget / loss,
      freeCollateral / unitMargin,
      maxNotional / unitNotional,
    ),
  )
    .div(step)
    .floor()
    .mul(step)
    .toNumber();
}
export function ctFunding(
  i: CTInstrument,
  qty: number,
  mark: number,
  rate: number,
) {
  if (i.product !== "usdm" && i.product !== "coinm")
    throw new Error("펀딩 비대상 상품");
  return D(qty)
    .mul(i.contractSize)
    .mul(i.product === "coinm" ? D(1).div(mark) : mark)
    .mul(rate)
    .mul(i.direction === "long" ? -1 : 1)
    .toNumber();
}
export function ctBorrowStep(
  debt: { principal: number; interest: number },
  event: { kind: "borrow" | "interest" | "repay"; amount: number },
) {
  if (!Number.isFinite(event.amount) || event.amount < 0)
    throw new Error("부채 금액 오류");
  if (event.kind === "borrow")
    return {
      ...debt,
      principal: D(debt.principal).plus(event.amount).toNumber(),
    };
  if (event.kind === "interest")
    return {
      ...debt,
      interest: D(debt.interest).plus(event.amount).toNumber(),
    };
  const paidInterest = Math.min(debt.interest, event.amount);
  return {
    interest: D(debt.interest).minus(paidInterest).toNumber(),
    principal: Decimal.max(
      0,
      D(debt.principal).minus(event.amount - paidInterest),
    ).toNumber(),
  };
}
export function ctOptionSettlement(
  i: Extract<CTInstrument, { product: "options" }>,
  qty: number,
  premium: number,
  underlying: number,
  at: number,
) {
  if (at < i.expiry) throw new Error("만기 이전 행사");
  const intrinsic = Math.max(
    0,
    i.right === "CALL" ? underlying - i.strike : i.strike - underlying,
  );
  return ctNativePnl(i, qty, premium, intrinsic || Number.MIN_VALUE);
}
/** Haircuts and both hedge legs remain in gross exposure; no assumed offset. */
export function ctAccountRisk(input: {
  equity: number;
  positions: Array<{ notional: number; margin: number; worstLoss: number }>;
  debts: number;
  dailyLoss: number;
  maxGross: number;
  maxMargin: number;
  maxLoss: number;
  dailyLossLimit: number;
}) {
  const gross = input.positions.reduce((s, p) => s + Math.abs(p.notional), 0),
    margin = input.positions.reduce((s, p) => s + p.margin, 0),
    worst = input.positions.reduce((s, p) => s + p.worstLoss, 0) + input.debts;
  return {
    gross,
    margin,
    worst,
    accepted:
      input.equity > 0 &&
      gross <= input.maxGross &&
      margin <= Math.min(input.maxMargin, input.equity) &&
      worst <= input.maxLoss &&
      input.dailyLoss < input.dailyLossLimit,
  };
}
