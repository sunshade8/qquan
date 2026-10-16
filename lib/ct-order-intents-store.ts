import { ctDb } from "./ct-data.ts";
import { ctHash } from "./ct-spec.ts";
import {
  assertCTCapability,
  ctInstrumentKey,
  type CTCapability,
  type CTInstrument,
} from "./ct-capabilities.ts";
import {
  BinanceAPI,
  BinanceError,
  binancePositionParams,
  binanceQuantize,
  type BinanceFilter,
} from "./binance-api.ts";
export const CT_ORDER_INTENTS_SCHEMA =
  "CREATE TABLE IF NOT EXISTS ct_order_intents(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,account_id TEXT NOT NULL,instrument_key TEXT NOT NULL,position_side TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,payload TEXT NOT NULL,broker_id TEXT,error TEXT,updated_at INTEGER NOT NULL)";
export type CTBrokerIntent = {
  id: string;
  owner: string;
  account: string;
  instrument: CTInstrument;
  positionSide: "LONG" | "SHORT";
  side: "BUY" | "SELL";
  quantity: string;
  price: string;
  closing: boolean;
  type: "LIMIT";
  timeInForce: "GTC" | "IOC" | "FOK";
  maxNotional: number;
  approvalHash: string;
  accountSnapshotHash: string;
};
/** The immutable intent is committed before any transmission. Ambiguous orders can only be reconciled, never resubmitted. */
export async function ctExecuteBrokerIntent(
  intent: CTBrokerIntent,
  context: {
    owner: string;
    mode: "shadow" | "paper" | "live";
    approvedHash: string | null;
    accountSnapshotHash: string;
    capability: CTCapability;
    filters: BinanceFilter[];
    unresolvedOrders: boolean;
  },
) {
  if (intent.owner !== context.owner || context.mode !== "live")
    throw new Error("실전 소유자/모드 확인 필요");
  if (
    !context.approvedHash ||
    intent.approvalHash !== context.approvedHash ||
    intent.accountSnapshotHash !== context.accountSnapshotHash ||
    context.unresolvedOrders
  )
    throw new Error("승인/계좌 snapshot/미확인 주문 검사 실패");
  assertCTCapability(intent.instrument, context.capability, "live");
  if (intent.instrument.product === "stock")
    throw new Error("Toss는 기존 전용 어댑터를 사용합니다");
  const precision = binanceQuantize(
      intent.quantity,
      intent.price,
      context.filters,
      intent.maxNotional,
    ),
    hash = await ctHash(intent),
    clientId = "ct-" + hash.slice(0, 29),
    db = ctDb();
  await db.prepare(CT_ORDER_INTENTS_SCHEMA).run();
  await db
    .prepare(
      "INSERT OR IGNORE INTO ct_order_intents(id,owner_id,account_id,instrument_key,position_side,client_id,status,payload,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      intent.id,
      intent.owner,
      intent.account,
      ctInstrumentKey(intent.instrument),
      intent.positionSide,
      clientId,
      "prepared",
      JSON.stringify(intent),
      Date.now(),
    )
    .run();
  const saved = await db
    .prepare(
      "SELECT payload,status,broker_id FROM ct_order_intents WHERE id=? AND owner_id=? AND account_id=?",
    )
    .bind(intent.id, intent.owner, intent.account)
    .first<{ payload: string; status: string; broker_id: string | null }>();
  if (!saved || (await ctHash(JSON.parse(saved.payload))) !== hash)
    throw new Error("주문 의도 멱등성 충돌");
  if (saved.status !== "prepared")
    return { status: saved.status, brokerId: saved.broker_id };
  const claim = await db
    .prepare(
      "UPDATE ct_order_intents SET status='submitting',updated_at=? WHERE id=? AND status='prepared'",
    )
    .bind(Date.now(), intent.id)
    .run();
  if (!claim.meta.changes) return { status: "submitting", brokerId: null };
  const api = new BinanceAPI(
    intent.instrument.product,
    intent.instrument.network,
  );
  await api.syncTime();
  try {
    const product = intent.instrument.product,
      params = {
        symbol: intent.instrument.instrumentId,
        side: intent.side,
        type: intent.type,
        timeInForce: intent.timeInForce,
        ...precision,
        newClientOrderId: clientId,
        ...(product === "usdm" || product === "coinm"
          ? binancePositionParams(
              intent.instrument.positionMode,
              intent.positionSide,
              intent.closing,
              intent.type,
            )
          : {}),
        ...(product === "margin-isolated" ? { isIsolated: "TRUE" } : {}),
      };
    const r = await api.mutate("order", params),
      brokerId = String(r.orderId);
    await db
      .prepare(
        "UPDATE ct_order_intents SET status='acknowledged',broker_id=?,updated_at=? WHERE id=? AND status='submitting'",
      )
      .bind(brokerId, Date.now(), intent.id)
      .run();
    return { status: "acknowledged", brokerId };
  } catch (e) {
    const status =
      e instanceof BinanceError &&
      !e.ambiguous &&
      e.status >= 400 &&
      e.status < 500 &&
      !["429", "418"].includes(String(e.status))
        ? "rejected"
        : "unknown";
    await db
      .prepare(
        "UPDATE ct_order_intents SET status=?,error=?,updated_at=? WHERE id=?",
      )
      .bind(
        status,
        e instanceof Error ? e.message : "전송 결과 미확정",
        Date.now(),
        intent.id,
      )
      .run();
    throw e;
  }
}
export async function ctReconcileBrokerIntent(
  owner: string,
  account: string,
  id: string,
) {
  const db = ctDb();
  await db.prepare(CT_ORDER_INTENTS_SCHEMA).run();
  const row = await db
    .prepare(
      "SELECT payload,client_id,status FROM ct_order_intents WHERE id=? AND owner_id=? AND account_id=?",
    )
    .bind(id, owner, account)
    .first<{ payload: string; client_id: string; status: string }>();
  if (!row) throw new Error("소유 주문 의도 없음");
  const p = JSON.parse(row.payload) as CTBrokerIntent;
  if (p.instrument.product === "stock") throw new Error("Toss 전용 대사");
  const api = new BinanceAPI(p.instrument.product, p.instrument.network);
  await api.syncTime();
  const order = await api.read("order", {
    symbol: p.instrument.instrumentId,
    origClientOrderId: row.client_id,
    ...(p.instrument.product === "margin-isolated"
      ? { isIsolated: "TRUE" }
      : {}),
  });
  await db
    .prepare(
      "UPDATE ct_order_intents SET status=?,broker_id=?,updated_at=? WHERE id=? AND owner_id=? AND account_id=?",
    )
    .bind(
      String(order.status ?? "acknowledged"),
      String(order.orderId),
      Date.now(),
      id,
      owner,
      account,
    )
    .run();
  return { status: order.status, brokerId: order.orderId };
}
