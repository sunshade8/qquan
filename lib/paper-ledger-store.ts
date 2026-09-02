/**
 * D1 persistence for the paper-trading ledger. Arithmetic lives in
 * `lib/paper-ledger.ts` so it stays unit-testable without a database.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { paperDailyPnl, paperFills, paperPositions } from "@/db/schema";
import { applyFill, estimateFill, markToMarket, paperPerformance, type PaperSide } from "@/lib/paper-ledger";
import type { OrderIntent } from "@/lib/trading";

export type PaperPosition = { id: string; symbol: string; quantity: number; averagePrice: number; openedAt: string; realizedPnlUsd: number; status: string };
export type PaperFill = { id: string; symbol: string; side: string; quantity: number; signalDate: string; fillDate: string; referencePrice: number; fillPrice: number; slippageBps: number; costUsd: number; reason: string };

export async function openPositions(ownerId: string, strategyId: string): Promise<PaperPosition[]> {
  await ensureSchema();
  const rows = await getDb().select().from(paperPositions)
    .where(and(eq(paperPositions.ownerId, ownerId), eq(paperPositions.strategyId, strategyId), eq(paperPositions.status, "open")));
  return rows.map((row) => ({ id: row.id, symbol: row.symbol, quantity: row.quantity, averagePrice: row.averagePrice, openedAt: row.openedAt, realizedPnlUsd: row.realizedPnlUsd, status: row.status }));
}

export async function recentFills(ownerId: string, strategyId: string, limit = 50): Promise<PaperFill[]> {
  await ensureSchema();
  const rows = await getDb().select().from(paperFills)
    .where(and(eq(paperFills.ownerId, ownerId), eq(paperFills.strategyId, strategyId)))
    .orderBy(desc(paperFills.createdAt)).limit(limit);
  return rows.map((row) => ({ id: row.id, symbol: row.symbol, side: row.side, quantity: row.quantity, signalDate: row.signalDate, fillDate: row.fillDate, referencePrice: row.referencePrice, fillPrice: row.fillPrice, slippageBps: row.slippageBps, costUsd: row.costUsd, reason: row.reason }));
}

/**
 * Records one intent as a paper fill and moves the position.
 *
 * The same intent is not recorded twice for the same signal date: a signals
 * endpoint polled several times a day would otherwise stack duplicate fills and
 * quietly inflate the track record it exists to measure.
 */
export async function recordPaperFill(ownerId: string, intent: OrderIntent, costBps: number, quote: { bid?: number | null; ask?: number | null }) {
  await ensureSchema();
  const db = getDb();
  const side = intent.side as PaperSide;

  const duplicates = await db.select().from(paperFills)
    .where(and(eq(paperFills.ownerId, ownerId), eq(paperFills.strategyId, intent.strategyId), eq(paperFills.symbol, intent.symbol), eq(paperFills.signalDate, intent.signalDate), eq(paperFills.side, side)))
    .limit(1);
  if (duplicates.length) return { recorded: false as const, reason: `${intent.symbol} ${side} 신호(${intent.signalDate})는 이미 기록되어 있습니다.` };

  const estimate = estimateFill(side, intent.quantity, intent.referencePrice, quote, costBps);
  const [existing] = await db.select().from(paperPositions)
    .where(and(eq(paperPositions.ownerId, ownerId), eq(paperPositions.strategyId, intent.strategyId), eq(paperPositions.symbol, intent.symbol), eq(paperPositions.status, "open")))
    .limit(1);

  const before = existing
    ? { quantity: existing.quantity, averagePrice: existing.averagePrice, realizedPnlUsd: existing.realizedPnlUsd }
    : { quantity: 0, averagePrice: 0, realizedPnlUsd: 0 };
  if (side === "sell" && before.quantity <= 0) {
    return { recorded: false as const, reason: `${intent.symbol} 보유 수량이 없어 매도를 기록하지 않았습니다. (롱 온리 원장)` };
  }
  const { position, realizedUsd } = applyFill(before, side, intent.quantity, estimate.fillPrice, estimate.costUsd);
  const now = new Date();
  const fillDate = now.toISOString().slice(0, 10);

  await db.insert(paperFills).values({
    id: crypto.randomUUID(), ownerId, strategyId: intent.strategyId, symbol: intent.symbol, side,
    quantity: intent.quantity, signalDate: intent.signalDate, fillDate,
    referencePrice: intent.referencePrice, fillPrice: estimate.fillPrice,
    slippageBps: estimate.slippageBps, costUsd: estimate.costUsd, reason: intent.reason,
    gateway: "dry_run", createdAt: now,
  });

  if (existing) {
    await db.update(paperPositions).set({
      quantity: position.quantity, averagePrice: position.averagePrice, realizedPnlUsd: position.realizedPnlUsd,
      status: position.quantity > 0 ? "open" : "closed",
      closedAt: position.quantity > 0 ? null : fillDate,
      updatedAt: now,
    }).where(eq(paperPositions.id, existing.id));
  } else {
    await db.insert(paperPositions).values({
      id: crypto.randomUUID(), ownerId, strategyId: intent.strategyId, symbol: intent.symbol,
      quantity: position.quantity, averagePrice: position.averagePrice, openedAt: fillDate, closedAt: null,
      realizedPnlUsd: position.realizedPnlUsd, status: position.quantity > 0 ? "open" : "closed", updatedAt: now,
    });
  }
  return { recorded: true as const, fill: { ...estimate, side, symbol: intent.symbol, quantity: intent.quantity, signalDate: intent.signalDate, fillDate, realizedUsd } };
}

/** One equity snapshot per strategy per session; re-running the same day overwrites rather than duplicates. */
export async function snapshotEquity(ownerId: string, strategyId: string, tradingDate: string, input: { cashUsd: number; positions: Array<{ symbol: string; quantity: number; averagePrice: number; lastPrice: number | null }>; realizedPnlUsd: number; benchmarkReturnPct: number | null }) {
  await ensureSchema();
  const marked = markToMarket(input.positions, input.cashUsd);
  const db = getDb();
  const [previous] = await db.select().from(paperDailyPnl)
    .where(and(eq(paperDailyPnl.ownerId, ownerId), eq(paperDailyPnl.strategyId, strategyId)))
    .orderBy(desc(paperDailyPnl.tradingDate)).limit(1);
  const returnPct = previous && previous.tradingDate < tradingDate && previous.equityUsd > 0
    ? Number(((marked.equityUsd / previous.equityUsd - 1) * 100).toFixed(4))
    : null;

  await db.insert(paperDailyPnl).values({
    id: crypto.randomUUID(), ownerId, strategyId, tradingDate,
    equityUsd: marked.equityUsd, realizedPnlUsd: input.realizedPnlUsd, unrealizedPnlUsd: marked.unrealizedPnlUsd,
    returnPct, benchmarkReturnPct: input.benchmarkReturnPct, openPositions: input.positions.length, createdAt: new Date(),
  }).onConflictDoUpdate({
    target: [paperDailyPnl.ownerId, paperDailyPnl.strategyId, paperDailyPnl.tradingDate],
    set: { equityUsd: marked.equityUsd, realizedPnlUsd: input.realizedPnlUsd, unrealizedPnlUsd: marked.unrealizedPnlUsd, returnPct, benchmarkReturnPct: input.benchmarkReturnPct, openPositions: input.positions.length },
  });
  return { ...marked, returnPct, tradingDate };
}

/**
 * The live track record next to what the backtest promised. `backtestSharpe` and
 * friends come from the caller so this module stays free of strategy types.
 */
export async function paperTrackRecord(ownerId: string, strategyId: string, startingEquityUsd: number) {
  await ensureSchema();
  const rows = await getDb().select().from(paperDailyPnl)
    .where(and(eq(paperDailyPnl.ownerId, ownerId), eq(paperDailyPnl.strategyId, strategyId)))
    .orderBy(asc(paperDailyPnl.tradingDate)).limit(1000);
  const points = rows.map((row) => ({ tradingDate: row.tradingDate, equityUsd: row.equityUsd, benchmarkReturnPct: row.benchmarkReturnPct }));
  return {
    ...paperPerformance(points, startingEquityUsd),
    equityCurve: points.map((point) => ({ date: point.tradingDate, equity: point.equityUsd })),
    firstSession: points[0]?.tradingDate ?? null,
    lastSession: points.at(-1)?.tradingDate ?? null,
  };
}
