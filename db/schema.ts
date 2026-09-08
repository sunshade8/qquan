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

export const labAgentRuns = sqliteTable("lab_agent_runs", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  phase: text("phase").notNull(),
  label: text("label").notNull(),
  detail: text("detail").notNull().default(""),
  status: text("status").notNull().default("running"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_lab_agent_runs_owner_updated").on(table.ownerId, table.updatedAt)]);

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
  sourceFindingId: text("source_finding_id"),
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
  eventRoots: text("event_roots").notNull().default(""),
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

export const marketEvents = sqliteTable("market_events", {
  id: text("id").primaryKey(),
  eventRoot: text("event_root").notNull(),
  eventDate: text("event_date").notNull(),
  eventTimeEt: text("event_time_et").notNull().default(""),
  releasedBeforeClose: integer("released_before_close", { mode: "boolean" }).notNull().default(true),
  category: text("category").notNull().default(""),
  importance: text("importance").notNull().default("medium"),
  title: text("title").notNull().default(""),
  unit: text("unit").notNull().default(""),
  actualInitial: real("actual_initial"),
  actualRevised: real("actual_revised"),
  consensus: real("consensus"),
  previous: real("previous"),
  surprise: real("surprise"),
  surpriseZ: real("surprise_z"),
  surpriseBasis: text("surprise_basis").notNull().default(""),
  source: text("source").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("idx_market_events_root_date").on(table.eventRoot, table.eventDate),
  index("idx_market_events_date").on(table.eventDate),
]);

export const paperPositions = sqliteTable("paper_positions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  strategyId: text("strategy_id").notNull(),
  symbol: text("symbol").notNull(),
  quantity: real("quantity").notNull(),
  averagePrice: real("average_price").notNull(),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  realizedPnlUsd: real("realized_pnl_usd").notNull().default(0),
  status: text("status").notNull().default("open"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_paper_positions_owner_strategy").on(table.ownerId, table.strategyId),
  uniqueIndex("idx_paper_positions_open").on(table.ownerId, table.strategyId, table.symbol, table.status),
]);

export const paperFills = sqliteTable("paper_fills", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  strategyId: text("strategy_id").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  quantity: real("quantity").notNull(),
  signalDate: text("signal_date").notNull(),
  fillDate: text("fill_date").notNull(),
  referencePrice: real("reference_price").notNull(),
  fillPrice: real("fill_price").notNull(),
  slippageBps: real("slippage_bps").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  reason: text("reason").notNull().default(""),
  gateway: text("gateway").notNull().default("dry_run"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_paper_fills_owner_strategy").on(table.ownerId, table.strategyId),
  index("idx_paper_fills_signal_date").on(table.signalDate),
]);

export const paperDailyPnl = sqliteTable("paper_daily_pnl", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  strategyId: text("strategy_id").notNull(),
  tradingDate: text("trading_date").notNull(),
  equityUsd: real("equity_usd").notNull(),
  realizedPnlUsd: real("realized_pnl_usd").notNull().default(0),
  unrealizedPnlUsd: real("unrealized_pnl_usd").notNull().default(0),
  returnPct: real("return_pct"),
  benchmarkReturnPct: real("benchmark_return_pct"),
  openPositions: integer("open_positions").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("idx_paper_pnl_strategy_date").on(table.ownerId, table.strategyId, table.tradingDate),
]);

/**
 * A strategy the owner put on the 전략 board. `strategyKey` points at a rule in
 * `lib/trade-strategies.ts`; the row carries only what the owner chose — how much
 * capital it runs and which gateway it submits to — so the rule itself stays in
 * code where it can be reviewed and versioned.
 */
export const tradeStrategyInstances = sqliteTable("trade_strategy_instances", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  strategyKey: text("strategy_key").notNull(),
  name: text("name").notNull(),
  capitalUsd: real("capital_usd").notNull(),
  gateway: text("gateway").notNull().default("dry_run"),
  lastBacktestAt: integer("last_backtest_at", { mode: "timestamp_ms" }),
  lastTradeAt: integer("last_trade_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_trade_instances_owner").on(table.ownerId, table.updatedAt),
]);

/**
 * The markdown record of one run. Stored as rendered text, not regenerated on
 * demand: a report rebuilt from today's prices is not evidence of what the run
 * decided at the time.
 */
export const tradeStrategyReports = sqliteTable("trade_strategy_reports", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  instanceId: text("instance_id").notNull(),
  strategyKey: text("strategy_key").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  filename: text("filename").notNull(),
  markdown: text("markdown").notNull(),
  summaryPayload: text("summary_payload").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_trade_reports_instance").on(table.instanceId, table.createdAt),
  index("idx_trade_reports_owner").on(table.ownerId, table.createdAt),
]);
