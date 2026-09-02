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

export const newsTests = sqliteTable("news_tests", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  topic: text("topic").notNull(),
  articleCount: integer("article_count").notNull(),
  overallScore: real("overall_score").notNull(),
  overallLabel: text("overall_label").notNull(),
  techScore: real("tech_score").notNull(),
  techLabel: text("tech_label").notNull(),
  valueScore: real("value_score").notNull(),
  valueLabel: text("value_label").notNull(),
  nasdaqPayload: text("nasdaq_payload").notNull(),
  nysePayload: text("nyse_payload").notNull(),
  forecastPayload: text("forecast_payload").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_news_tests_owner_created").on(table.ownerId, table.createdAt),
]);

export const newsAgentMessages = sqliteTable("news_agent_messages", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  conversationId: text("conversation_id"),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_news_agent_owner_created").on(table.ownerId, table.createdAt),
]);

export const newsResearchRuns = sqliteTable("news_research_runs", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  command: text("command").notNull(),
  label: text("label").notNull(),
  status: text("status").notNull(),
  totalEvents: integer("total_events").notNull(),
  completedEvents: integer("completed_events").notNull().default(0),
  failedEvents: integer("failed_events").notNull().default(0),
  stagesPayload: text("stages_payload").notNull().default("[]"),
  resultPayload: text("result_payload").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_news_runs_owner_updated").on(table.ownerId, table.updatedAt)]);

export const llmUsage = sqliteTable("llm_usage", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  feature: text("feature").notNull(),
  role: text("role"),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull(),
  priced: integer("priced", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_llm_usage_owner_created").on(table.ownerId, table.createdAt),
  index("idx_llm_usage_owner_model").on(table.ownerId, table.model),
]);

export const labMessages = sqliteTable("lab_messages", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  conversationId: text("conversation_id"),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolsPayload: text("tools_payload").notNull().default("[]"),
  artifactsPayload: text("artifacts_payload").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_lab_messages_owner_created").on(table.ownerId, table.createdAt),
]);

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  preview: text("preview").notNull().default(""),
  messageCount: integer("message_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_conversations_owner_updated").on(table.ownerId, table.updatedAt)]);

export const strategies = sqliteTable("strategies", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
  specPayload: text("spec_payload").notNull(),
  latestResultPayload: text("latest_result_payload").notNull().default("null"),
  sourceConversationId: text("source_conversation_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_strategies_owner_updated").on(table.ownerId, table.updatedAt)]);

export const strategyRuns = sqliteTable("strategy_runs", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  strategyId: text("strategy_id").notNull(),
  specPayload: text("spec_payload").notNull(),
  resultPayload: text("result_payload").notNull(),
  verdict: text("verdict").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_strategy_runs_strategy_created").on(table.strategyId, table.createdAt)]);

export const researchFindings = sqliteTable("research_findings", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  claim: text("claim").notNull(),
  evidencePayload: text("evidence_payload").notNull().default("[]"),
  symbols: text("symbols").notNull().default(""),
  tags: text("tags").notNull().default(""),
  confidence: text("confidence").notNull().default("medium"),
  status: text("status").notNull().default("open"),
  falsification: text("falsification").notNull().default(""),
  sourceConversationId: text("source_conversation_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_research_findings_owner_updated").on(table.ownerId, table.updatedAt),
]);
