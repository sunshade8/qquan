/**
 * Whether a trade was executed the way its rule said.
 *
 * The backtest, the paper dashboard and the live dashboard all call this, so
 * "준수" means one thing everywhere. A rule is a promise about four things — the
 * entry price the execution model assumed, entering within one bar of the
 * decision, never losing more than the stop, and handing the balance back when
 * the slot ends — and each broken promise is named rather than folded into a
 * single score, because "slow fill" and "stop blown through a gap" need
 * different fixes.
 *
 * Pure: imported by the Node test runner.
 */

export type TradeExit = "stop" | "target" | "slot_end" | "shutdown";

/**
 * One bar of a legacy five-minute rule. A fill later than one bar is no longer
 * the fill the backtest modelled; callers pass the rule's own bar through
 * `entryDelayLimitSeconds`.
 */
export const ENTRY_DELAY_LIMIT_SECONDS = 300;
/** Slack for a slot-end exit order to reach the book and fill. */
export const SLOT_END_GRACE_SECONDS = 120;

export type AdherenceInput = {
  stopPct: number;
  targetPct: number | null;
  /**
   * The price the execution model promised: the next bar's open in the
   * backtest, the quote at the moment of the decision in live trading.
   */
  referenceEntryPrice: number;
  entryPrice: number;
  exitPrice: number;
  exit: TradeExit;
  /** Seconds from the decision bar's close to the entry fill. Null when not measured (backtest). */
  entryDelaySeconds?: number | null;
  entryDelayLimitSeconds?: number;
  /** Seconds the position was still open after its slot ended. Null when not measured. */
  heldPastSlotSeconds?: number | null;
  /** Percentage points of slack before a price difference counts as a deviation. */
  tolerancePct: number;
};

export type Adherence = {
  compliant: boolean;
  violations: string[];
  /** Positive means the entry cost more than the model assumed. */
  entrySlippagePct: number;
  /** How far past the planned stop the loss ran, percentage points. Null unless the exit was a stop. */
  stopOvershootPct: number | null;
};

const fixed = (value: number, digits = 2) => (Math.abs(value) < 0.005 ? 0 : value).toFixed(digits);

export function assessTrade(input: AdherenceInput): Adherence {
  const violations: string[] = [];
  const tolerance = Math.max(0, input.tolerancePct);

  const entrySlippagePct = input.referenceEntryPrice > 0 ? (input.entryPrice / input.referenceEntryPrice - 1) * 100 : 0;
  if (entrySlippagePct > tolerance) {
    violations.push(`진입가 괴리 +${fixed(entrySlippagePct)}% (기준가 대비 불리, 허용 ${fixed(tolerance)}%)`);
  }
  if (input.entryDelaySeconds !== null && input.entryDelaySeconds !== undefined && input.entryDelaySeconds > (input.entryDelayLimitSeconds ?? ENTRY_DELAY_LIMIT_SECONDS)) {
    violations.push(`진입 지연 ${Math.round(input.entryDelaySeconds)}초 (한 봉 초과)`);
  }

  const realizedPct = input.entryPrice > 0 ? (input.exitPrice / input.entryPrice - 1) * 100 : 0;
  let stopOvershootPct: number | null = null;
  if (input.exit === "stop") {
    stopOvershootPct = Math.max(0, -realizedPct - input.stopPct);
    if (stopOvershootPct > tolerance) {
      violations.push(`손절 초과: 계획 −${fixed(input.stopPct)}%, 실제 ${fixed(realizedPct)}%`);
    }
  } else if (realizedPct < -(input.stopPct + tolerance)) {
    // The price ran past the stop and the position was closed for some other
    // reason — the stop itself never fired.
    violations.push(`손절 미실행: 계획 −${fixed(input.stopPct)}%, 실제 ${fixed(realizedPct)}%`);
  }

  if (input.heldPastSlotSeconds !== null && input.heldPastSlotSeconds !== undefined && input.heldPastSlotSeconds > SLOT_END_GRACE_SECONDS) {
    violations.push(`슬롯 종료 후 ${Math.round(input.heldPastSlotSeconds)}초 더 보유`);
  }

  return {
    compliant: violations.length === 0,
    violations,
    entrySlippagePct: Number(entrySlippagePct.toFixed(4)),
    stopOvershootPct: stopOvershootPct === null ? null : Number(stopOvershootPct.toFixed(4)),
  };
}

/** Share of closed trades executed as the rule said, or null before any trade. */
export function adherencePct(compliant: number, total: number) {
  return total > 0 ? Number(((compliant / total) * 100).toFixed(2)) : null;
}
