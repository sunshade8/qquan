/**
 * Where the stop and target stood for a trade, for charts and records. Pure, types only from the
 * engine, safe for screens. Classic exits have fixed levels computed from the fill (the same
 * formula ctExit uses); managed exits carry their story in `management` (initial stop, target and
 * every stop move with the bar close after which it applied).
 */
import { ctIsManagedExit, type CTSpec } from "./ct-spec.ts";
import type { CTTrade, CTTradeManagement } from "./ct-engine.ts";

export type CTTradeLevels = { stop: number; target: number | null; moves: CTTradeManagement["moves"] };
export function ctTradeLevels(spec: CTSpec, trade: Pick<CTTrade, "entry" | "signal" | "management">): CTTradeLevels | null {
  if (trade.management) return { stop: trade.management.initialStop, target: trade.management.target, moves: trade.management.moves };
  if (ctIsManagedExit(spec.exit)) return null;
  return {
    stop: Math.max(trade.entry * (1 - spec.exit.stopPct / 100), spec.exit.invalidation === "last_stage_low" ? trade.signal.patternLow : 0),
    target: trade.entry * (1 + spec.exit.targetPct / 100),
    moves: [],
  };
}
/** The stop level standing at `ms` (a move applies from the bar after the one it was decided on). */
export function ctStopAt(levels: CTTradeLevels, ms: number) {
  let stop = levels.stop;
  for (const m of levels.moves) if (m.at <= ms) stop = m.to;
  return stop;
}
export const CT_EXIT_REASON_TEXT: Record<string, string> = {
  stop: "손절",
  breakeven: "본전 손절",
  trail: "트레일 청산",
  target: "목표",
  time_stop: "시간 손절",
  max_hold: "최대 보유",
  time: "시간 청산",
  day_end: "당일 경계 청산",
  session: "장 마감 청산",
  boundary: "구간 경계",
  invalid_stop: "손절 불가",
  slot_end: "시간 청산",
  shutdown: "정지 청산",
};
export const CT_REFERENCE_TEXT: Record<string, string> = {
  vwap: "VWAP",
  prev_day_high: "전일 고가",
  prev_day_low: "전일 저가",
  prev_day_close: "전일 종가",
  day_open: "당일 시가",
  day_high: "당일 고가",
  day_low: "당일 저가",
  opening_range_high: "시가범위 상단",
  opening_range_low: "시가범위 하단",
};
