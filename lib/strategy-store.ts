import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { strategies, strategyRuns } from "@/db/schema";
import { loadDailyRows } from "@/lib/price-cache";
import type { Bar } from "@/lib/quant";
import { runStrategyBacktest, warmupDays, type BacktestResult, type StrategySpec } from "@/lib/strategy";
import { resolveSymbol } from "@/lib/symbols";
import { brokerSnapshotFor, evaluateLiveSignal, orderIntentFor, type LiveSignal, type OrderIntent } from "@/lib/trading";

export type StrategyStatus = "draft" | "backtested" | "candidate" | "rejected" | "paper" | "live";
export type StoredStrategy = {
  id: string; name: string; status: StrategyStatus; spec: StrategySpec; latestResult: BacktestResult | null; sourceConversationId: string | null; createdAt: string; updatedAt: string;
};

export const STRATEGY_STATUS_LABELS: Record<StrategyStatus, string> = {
  draft: "가설", backtested: "백테스트 완료", candidate: "시그널 후보", rejected: "기각", paper: "페이퍼 트레이딩", live: "실거래",
};

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function parse<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function rowToStrategy(row: typeof strategies.$inferSelect): StoredStrategy {
  return {
    id: row.id, name: row.name, status: (row.status as StrategyStatus) || "draft", spec: parse(row.specPayload, null as unknown as StrategySpec), latestResult: parse(row.latestResultPayload, null),
    sourceConversationId: row.sourceConversationId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/** Loads every universe symbol (plus the benchmark) with enough warm-up for the spec's indicators. */
export async function loadStrategyData(spec: StrategySpec) {
  const from = shiftDate(spec.period.from, -warmupDays(spec));
  const data: Record<string, Bar[]> = {};
  const missing: Array<{ symbol: string; reason: string }> = [];
  const resolvedUniverse: string[] = [];
  for (const query of spec.universe) {
    const asset = await resolveSymbol(query);
    if (!asset.public || !asset.symbol) { missing.push({ symbol: query, reason: asset.note ?? "거래 가능 종목으로 확인되지 않음" }); continue; }
    const load = await loadDailyRows(asset.symbol, from, spec.period.to);
    if (load.rows.length < 40) { missing.push({ symbol: asset.symbol, reason: load.reason ?? "일봉 데이터 부족" }); continue; }
    data[asset.symbol] = load.rows;
    resolvedUniverse.push(asset.symbol);
  }
  const benchmark = await resolveSymbol(spec.benchmark || "SPY");
  const marketRows = benchmark.public && benchmark.symbol ? (await loadDailyRows(benchmark.symbol, from, spec.period.to)).rows : [];
  return { data, missing, marketRows, resolvedUniverse };
}

export async function backtestSpec(spec: StrategySpec) {
  const { data, missing, marketRows, resolvedUniverse } = await loadStrategyData(spec);
  const normalized: StrategySpec = { ...spec, universe: resolvedUniverse.length ? resolvedUniverse : spec.universe };
  const result = runStrategyBacktest(normalized, data, marketRows, missing);
  return { result, missing };
}

export async function listStrategies(ownerId: string) {
  await ensureSchema();
  const rows = await getDb().select().from(strategies).where(eq(strategies.ownerId, ownerId)).orderBy(desc(strategies.updatedAt)).limit(100);
  return rows.map(rowToStrategy).filter((item) => item.spec);
}

export async function getStrategy(ownerId: string, id: string) {
  await ensureSchema();
  const rows = await getDb().select().from(strategies).where(and(eq(strategies.ownerId, ownerId), eq(strategies.id, id))).limit(1);
  return rows.length && rows[0].specPayload ? rowToStrategy(rows[0]) : null;
}

export async function saveStrategy(ownerId: string, spec: StrategySpec, options: { id?: string; status?: StrategyStatus; sourceConversationId?: string | null; latestResult?: BacktestResult | null } = {}) {
  await ensureSchema();
  const db = getDb();
  const now = new Date();
  const id = options.id ?? crypto.randomUUID();
  const existing = options.id ? await getStrategy(ownerId, options.id) : null;
  const row = {
    id, ownerId, name: spec.name, status: options.status ?? existing?.status ?? "draft", specPayload: JSON.stringify(spec),
    latestResultPayload: JSON.stringify(options.latestResult ?? existing?.latestResult ?? null),
    sourceConversationId: options.sourceConversationId ?? existing?.sourceConversationId ?? null, createdAt: existing ? new Date(existing.createdAt) : now, updatedAt: now,
  };
  await db.insert(strategies).values(row).onConflictDoUpdate({ target: strategies.id, set: { name: row.name, status: row.status, specPayload: row.specPayload, latestResultPayload: row.latestResultPayload, sourceConversationId: row.sourceConversationId, updatedAt: now } });
  return rowToStrategy(row);
}

export async function updateStrategyStatus(ownerId: string, id: string, status: StrategyStatus) {
  await ensureSchema();
  await getDb().update(strategies).set({ status, updatedAt: new Date() }).where(and(eq(strategies.ownerId, ownerId), eq(strategies.id, id)));
}

export async function deleteStrategy(ownerId: string, id: string) {
  await ensureSchema();
  await getDb().delete(strategies).where(and(eq(strategies.ownerId, ownerId), eq(strategies.id, id)));
  await getDb().delete(strategyRuns).where(and(eq(strategyRuns.ownerId, ownerId), eq(strategyRuns.strategyId, id)));
}

/** Runs and persists a backtest; the strategy status follows the deterministic verdict unless it is already paper/live. */
export async function runAndRecord(ownerId: string, strategy: StoredStrategy, specOverride?: StrategySpec) {
  const spec = specOverride ?? strategy.spec;
  const { result, missing } = await backtestSpec(spec);
  if (!result) return { result: null, missing };
  await ensureSchema();
  await getDb().insert(strategyRuns).values({ id: crypto.randomUUID(), ownerId, strategyId: strategy.id, specPayload: JSON.stringify(spec), resultPayload: JSON.stringify(result), verdict: result.verdict.status, createdAt: new Date() });
  const keepStatus = strategy.status === "paper" || strategy.status === "live";
  const status: StrategyStatus = keepStatus ? strategy.status : result.verdict.status === "pass" ? "candidate" : result.verdict.status === "fail" ? "rejected" : "backtested";
  const saved = await saveStrategy(ownerId, spec, { id: strategy.id, status, latestResult: result, sourceConversationId: strategy.sourceConversationId });
  return { result, missing, strategy: saved };
}

export async function listRuns(ownerId: string, strategyId: string, limit = 12) {
  await ensureSchema();
  const rows = await getDb().select().from(strategyRuns).where(and(eq(strategyRuns.ownerId, ownerId), eq(strategyRuns.strategyId, strategyId))).orderBy(desc(strategyRuns.createdAt)).limit(limit);
  return rows.map((row) => { const result = parse<BacktestResult | null>(row.resultPayload, null); return { id: row.id, verdict: row.verdict, createdAt: row.createdAt.toISOString(), period: result?.period ?? null, metrics: result?.metrics ?? null }; });
}

/** Live signal state for every universe symbol plus dry-run order intents sized to `capitalUsd`. */
export async function liveSignalsFor(strategy: StoredStrategy, capitalUsd: number, heldSymbols: string[] = []): Promise<{ signals: LiveSignal[]; intents: OrderIntent[]; asOf: string }> {
  const spec = strategy.spec;
  const today = new Date().toISOString().slice(0, 10);
  const from = shiftDate(today, -warmupDays(spec) - 30);
  const signals: LiveSignal[] = [];
  for (const query of spec.universe) {
    const asset = await resolveSymbol(query);
    if (!asset.public || !asset.symbol) continue;
    const [load, broker] = await Promise.all([loadDailyRows(asset.symbol, from, today), brokerSnapshotFor(asset.symbol)]);
    if (load.rows.length < 30) continue;
    signals.push(evaluateLiveSignal(asset.symbol, load.rows, spec, broker));
  }
  const intents = signals.flatMap((signal) => { const intent = orderIntentFor(strategy.id, signal, spec, capitalUsd, heldSymbols.includes(signal.symbol)); return intent ? [intent] : []; });
  return { signals, intents, asOf: new Date().toISOString() };
}
