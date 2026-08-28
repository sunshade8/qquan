import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const securities = sqliteTable("securities", {
  symbol: text("symbol").primaryKey(),
  name: text("name").notNull(),
  sector: text("sector").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const dailyPrices = sqliteTable("daily_prices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  tradingDate: text("trading_date").notNull(),
  open: real("open").notNull(),
  high: real("high").notNull(),
  low: real("low").notNull(),
  close: real("close").notNull(),
  adjustedClose: real("adjusted_close").notNull(),
  volume: integer("volume").notNull(),
}, (table) => [
  uniqueIndex("idx_daily_prices_symbol_date").on(table.symbol, table.tradingDate),
  index("idx_daily_prices_date").on(table.tradingDate),
]);

export const marketSyncRuns = sqliteTable("market_sync_runs", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  rowsWritten: integer("rows_written").notNull().default(0),
  message: text("message").notNull().default(""),
});

export const hypotheses = sqliteTable("hypotheses", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  symbolUniverse: text("symbol_universe").notNull(),
  thesis: text("thesis").notNull(),
  entryRule: text("entry_rule").notNull(),
  exitRule: text("exit_rule").notNull(),
  sizingRule: text("sizing_rule").notNull(),
  status: text("status").notNull().default("draft"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_hypotheses_updated_at").on(table.updatedAt)]);

export const backtestRuns = sqliteTable("backtest_runs", {
  id: text("id").primaryKey(),
  hypothesisId: text("hypothesis_id").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  initialCapital: real("initial_capital").notNull(),
  annualReturn: real("annual_return").notNull(),
  maxDrawdown: real("max_drawdown").notNull(),
  sharpe: real("sharpe").notNull(),
  winRate: real("win_rate").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_backtest_runs_hypothesis_id").on(table.hypothesisId),
  index("idx_backtest_runs_created_at").on(table.createdAt),
]);
