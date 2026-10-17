import Decimal from "decimal.js";
import { env } from "cloudflare:workers";
const db = () => (env as unknown as { DB: D1Database }).DB;
/** Shared by relay, surge and CT live books. Lock loss prevents any subsequent write. */
export async function accountLock(broker: "toss" | "upbit" | "binance", owner: string) {
  await db()
    .prepare(
      "CREATE TABLE IF NOT EXISTS trading_account_locks (id TEXT PRIMARY KEY,owner TEXT,until_ms INTEGER)",
    )
    .run();
  await db()
    .prepare("INSERT OR IGNORE INTO trading_account_locks VALUES (?,NULL,NULL)")
    .bind(broker)
    .run();
  const result = await db()
    .prepare(
      "UPDATE trading_account_locks SET owner=?,until_ms=? WHERE id=? AND (owner IS NULL OR until_ms<?)",
    )
    .bind(owner, Date.now() + 180000, broker, Date.now())
    .run();
  return result.meta.changes === 1;
}
export async function releaseAccountLock(
  broker: "toss" | "upbit" | "binance",
  owner: string,
) {
  await db()
    .prepare(
      "UPDATE trading_account_locks SET owner=NULL,until_ms=NULL WHERE id=? AND owner=?",
    )
    .bind(broker, owner)
    .run();
}
export async function accountHasUncertainOrders(excludeId: string) {
  const rows = await db()
    .prepare(
      "SELECT state_payload FROM trading_dashboards WHERE id<>? AND (?='ct-crypto-live')=(id='ct-crypto-live')",
    )
    .bind(excludeId, excludeId)
    .all<{ state_payload: string }>();
  return rows.results.some((r) => {
    const s = JSON.parse(r.state_payload);
    return (
      s.mode === "live" &&
      s.orders?.some((o: { status: string }) => o.status === "submitting")
    );
  });
}

export async function renewAccountLock(
  broker: "toss" | "upbit" | "binance",
  owner: string,
) {
  const now = Date.now();
  const result = await db()
    .prepare(
      "UPDATE trading_account_locks SET until_ms=? WHERE id=? AND owner=? AND until_ms>?",
    )
    .bind(now + 180000, broker, owner, now)
    .run();
  if (result.meta.changes !== 1)
    throw new Error("계좌 실행 잠금 만료 · 주문 차단");
}

/** Additional conservative reservation: the broker may already subtract these amounts. */
export async function otherBookReservations(excludeId: string) {
  const rows = await db()
    .prepare(
      "SELECT state_payload FROM trading_dashboards WHERE id<>? AND (?='ct-crypto-live')=(id='ct-crypto-live')",
    )
    .bind(excludeId, excludeId)
    .all<{ state_payload: string }>();
  let reserved = new Decimal(0);
  for (const row of rows.results) {
    const state = JSON.parse(row.state_payload);
    if (state.mode !== "live") continue;
    for (const order of state.orders ?? []) {
      if (
        order.side !== "buy" ||
        !["submitting", "working", "cancel_requested"].includes(order.status)
      )
        continue;
      const amount = new Decimal(order.quantity)
        .minus(order.filledQuantity)
        .mul(order.limitPrice ?? order.referencePrice)
        .mul("1.01");
      if (!amount.isFinite() || amount.lt(0))
        throw new Error("계좌 예약액 확인 불가");
      reserved = reserved.plus(amount);
    }
  }
  return reserved.toNumber();
}
