/**
 * Persistence for the 전략 board: which rules are running, and the markdown
 * record of every backtest and every trade run.
 *
 * The rule itself is never stored — `strategyKey` points at a definition in
 * `lib/trade-strategies.ts`. A rule that lives in a database row is a rule
 * nobody reviews, and this one places orders.
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { paperDailyPnl, paperFills, paperPositions, tradeStrategyInstances, tradeStrategyReports } from "@/db/schema";

export type TradeStrategyInstance = {
  id: string;
  strategyKey: string;
  name: string;
  capitalUsd: number;
  gateway: "dry_run" | "toss";
  createdAt: string;
  updatedAt: string;
  lastBacktestAt: string | null;
  lastTradeAt: string | null;
};

export type ReportKind = "backtest" | "trade";

export type StrategyReport = {
  id: string;
  instanceId: string;
  strategyKey: string;
  kind: ReportKind;
  title: string;
  filename: string;
  markdown: string;
  summary: Record<string, unknown>;
  createdAt: string;
};

function parse(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

function toInstance(row: typeof tradeStrategyInstances.$inferSelect): TradeStrategyInstance {
  return {
    id: row.id, strategyKey: row.strategyKey, name: row.name, capitalUsd: row.capitalUsd,
    gateway: row.gateway === "toss" ? "toss" : "dry_run",
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    lastBacktestAt: row.lastBacktestAt ? row.lastBacktestAt.toISOString() : null,
    lastTradeAt: row.lastTradeAt ? row.lastTradeAt.toISOString() : null,
  };
}

function toReport(row: typeof tradeStrategyReports.$inferSelect): StrategyReport {
  return {
    id: row.id, instanceId: row.instanceId, strategyKey: row.strategyKey,
    kind: row.kind === "trade" ? "trade" : "backtest",
    title: row.title, filename: row.filename, markdown: row.markdown,
    summary: parse(row.summaryPayload), createdAt: row.createdAt.toISOString(),
  };
}

export async function listInstances(ownerId: string): Promise<TradeStrategyInstance[]> {
  await ensureSchema();
  const rows = await getDb().select().from(tradeStrategyInstances)
    .where(eq(tradeStrategyInstances.ownerId, ownerId))
    .orderBy(tradeStrategyInstances.createdAt);
  return rows.map(toInstance);
}

export async function getInstance(ownerId: string, id: string): Promise<TradeStrategyInstance | null> {
  await ensureSchema();
  const [row] = await getDb().select().from(tradeStrategyInstances)
    .where(and(eq(tradeStrategyInstances.ownerId, ownerId), eq(tradeStrategyInstances.id, id)))
    .limit(1);
  return row ? toInstance(row) : null;
}

export async function getInstanceByKey(ownerId: string, strategyKey: string): Promise<TradeStrategyInstance | null> {
  await ensureSchema();
  const [row] = await getDb().select().from(tradeStrategyInstances)
    .where(and(eq(tradeStrategyInstances.ownerId, ownerId), eq(tradeStrategyInstances.strategyKey, strategyKey)))
    .limit(1);
  return row ? toInstance(row) : null;
}

/**
 * The settings row for a coded strategy, created on first use.
 *
 * The board is the code registry, not this table — a strategy exists because
 * `lib/trade-strategies.ts` defines it, and a row here only remembers what the
 * owner chose for it. Making the row a precondition is what left a freshly
 * deployed board empty: the rule was in the bundle, the row was in some other
 * database, and the page had nothing to draw.
 */
export async function ensureInstance(ownerId: string, input: { strategyKey: string; name: string; capitalUsd: number; gateway: "dry_run" | "toss" }): Promise<TradeStrategyInstance> {
  const existing = await getInstanceByKey(ownerId, input.strategyKey);
  if (existing) return existing;
  const id = await createInstance(ownerId, input);
  return (await getInstance(ownerId, id))!;
}

export async function createInstance(ownerId: string, input: { strategyKey: string; name: string; capitalUsd: number; gateway: "dry_run" | "toss" }) {
  await ensureSchema();
  const now = new Date();
  const id = crypto.randomUUID();
  await getDb().insert(tradeStrategyInstances).values({
    id, ownerId, strategyKey: input.strategyKey, name: input.name,
    capitalUsd: input.capitalUsd, gateway: input.gateway,
    lastBacktestAt: null, lastTradeAt: null, createdAt: now, updatedAt: now,
  });
  return id;
}

export async function updateInstance(ownerId: string, id: string, patch: Partial<{ capitalUsd: number; gateway: "dry_run" | "toss"; lastBacktestAt: Date; lastTradeAt: Date }>) {
  await ensureSchema();
  await getDb().update(tradeStrategyInstances)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(tradeStrategyInstances.ownerId, ownerId), eq(tradeStrategyInstances.id, id)));
}

/**
 * Removing a card removes its ledger too. The instance id is the `strategyId`
 * every fill and position is keyed by, so leaving those behind would orphan open
 * positions that no rule is watching any more — and a new card would get a fresh
 * id and never see them.
 */
export async function deleteInstance(ownerId: string, id: string) {
  await ensureSchema();
  const db = getDb();
  await db.delete(tradeStrategyReports).where(and(eq(tradeStrategyReports.ownerId, ownerId), eq(tradeStrategyReports.instanceId, id)));
  await db.delete(paperFills).where(and(eq(paperFills.ownerId, ownerId), eq(paperFills.strategyId, id)));
  await db.delete(paperPositions).where(and(eq(paperPositions.ownerId, ownerId), eq(paperPositions.strategyId, id)));
  await db.delete(paperDailyPnl).where(and(eq(paperDailyPnl.ownerId, ownerId), eq(paperDailyPnl.strategyId, id)));
  await db.delete(tradeStrategyInstances).where(and(eq(tradeStrategyInstances.ownerId, ownerId), eq(tradeStrategyInstances.id, id)));
}

export async function saveReport(ownerId: string, input: { instanceId: string; strategyKey: string; kind: ReportKind; title: string; filename: string; markdown: string; summary: Record<string, unknown> }) {
  await ensureSchema();
  const id = crypto.randomUUID();
  const createdAt = new Date();
  await getDb().insert(tradeStrategyReports).values({
    id, ownerId, instanceId: input.instanceId, strategyKey: input.strategyKey, kind: input.kind,
    title: input.title, filename: input.filename, markdown: input.markdown,
    summaryPayload: JSON.stringify(input.summary), createdAt,
  });
  return { id, createdAt: createdAt.toISOString() };
}

/** Report list for one strategy card. `markdown` is dropped so the list stays small. */
export async function listReports(ownerId: string, instanceId: string, limit = 30): Promise<Array<Omit<StrategyReport, "markdown">>> {
  await ensureSchema();
  const rows = await getDb().select().from(tradeStrategyReports)
    .where(and(eq(tradeStrategyReports.ownerId, ownerId), eq(tradeStrategyReports.instanceId, instanceId)))
    .orderBy(desc(tradeStrategyReports.createdAt))
    .limit(limit);
  return rows.map((row) => { const { markdown, ...rest } = toReport(row); void markdown; return rest; });
}

export async function getReport(ownerId: string, id: string): Promise<StrategyReport | null> {
  await ensureSchema();
  const [row] = await getDb().select().from(tradeStrategyReports)
    .where(and(eq(tradeStrategyReports.ownerId, ownerId), eq(tradeStrategyReports.id, id)))
    .limit(1);
  return row ? toReport(row) : null;
}
