import type {
  DashboardTrade,
  DashboardState,
  DashboardMode,
} from "./dashboard-types.ts";
import type { CTBar } from "./t-engine.ts";
import { ctDb } from "./t-data.ts";
import { ctHash, executableCT } from "./t-spec.ts";
export type CTTradeEvidence = {
  book: "ct-stock" | "ct-crypto";
  mode: DashboardMode;
  trade: DashboardTrade;
  rule: NonNullable<DashboardState["ctRules"]>[number];
  bars: CTBar[];
  savedAt: number;
};
/** Only bars observed by the runner by savedAt; preserve entry observations after they leave the data cache. */
export function mergeCTTradeBars(
  previous: CTBar[],
  incoming: CTBar[],
  from: number,
  now: number,
) {
  const rows = new Map<number, CTBar>();
  for (const b of [...previous, ...incoming])
    if (b.startMs >= from && b.endMs <= now) {
      const old = rows.get(b.startMs);
      if (old && JSON.stringify(old) !== JSON.stringify(b))
        throw new Error("운용 차트 과거 봉 변경 · 원본 보존");
      rows.set(b.startMs, b);
    }
  return [...rows.values()].sort((a, b) => a.startMs - b.startMs).slice(0, 480);
}
export async function getCTTradeEvidence(
  book: CTTradeEvidence["book"],
  mode: DashboardMode,
  id: string,
) {
  const row = await ctDb()
    .prepare(
      "SELECT payload FROM t_trade_charts WHERE book=? AND mode=? AND trade_id=?",
    )
    .bind(book, mode, id)
    .first<{ payload: string }>();
  if (!row) return null;
  const packet = JSON.parse(row.payload) as CTTradeEvidence;
  if (
    packet.trade.ctHash !== packet.rule.hash ||
    (await ctHash(executableCT(packet.rule.spec))) !== packet.rule.hash
  )
    throw new Error("거래 차트 승인 해시 불일치");
  return packet;
}
export async function saveCTTradeEvidence(
  book: CTTradeEvidence["book"],
  mode: DashboardMode,
  trade: DashboardTrade,
  rule: CTTradeEvidence["rule"],
  bars: CTBar[],
  now: number,
) {
  if (
    !trade.ctSignal ||
    trade.ctHash !== rule.hash ||
    (await ctHash(executableCT(rule.spec))) !== rule.hash
  )
    throw new Error("운용 차트 신호/해시 누락");
  const old = await getCTTradeEvidence(book, mode, trade.id);
  const packet: CTTradeEvidence = {
    book,
    mode,
    trade,
    rule,
    bars: mergeCTTradeBars(
      old?.bars ?? [],
      bars,
      trade.ctSignal.patternFrom - 10 * rule.spec.minutes * 60000,
      now,
    ),
    savedAt: now,
  };
  await ctDb()
    .prepare(
      "INSERT INTO t_trade_charts VALUES (?,?,?,?) ON CONFLICT(book,mode,trade_id) DO UPDATE SET payload=excluded.payload",
    )
    .bind(book, mode, trade.id, JSON.stringify(packet))
    .run();
}
