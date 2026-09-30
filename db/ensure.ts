import { env } from "cloudflare:workers";

/**
 * The Sites control plane does not reliably apply drizzle migrations, and local
 * Miniflare starts with an empty D1. Every table the app writes to is therefore
 * created defensively, once per isolate, before the first write.
 */

const STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS strategy_generation_runs (id text PRIMARY KEY, owner_id text NOT NULL, slot text NOT NULL, status text NOT NULL, payload text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, lease_owner text, lease_until integer)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_active ON strategy_generation_runs(status) WHERE status='running'",
  "CREATE INDEX IF NOT EXISTS idx_generation_owner ON strategy_generation_runs(owner_id,created_at)",
  "CREATE TABLE IF NOT EXISTS strategy_generation_data (run_id text NOT NULL, part integer NOT NULL, payload text NOT NULL, PRIMARY KEY(run_id,part))",
  "CREATE TABLE IF NOT EXISTS generated_relay_strategies (id text PRIMARY KEY, slot text NOT NULL UNIQUE, run_id text NOT NULL UNIQUE, owner_id text NOT NULL, spec_payload text NOT NULL, evidence_payload text NOT NULL, created_at integer NOT NULL)",
  "CREATE TABLE IF NOT EXISTS lab_messages (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, role text NOT NULL, content text NOT NULL, tools_payload text DEFAULT '[]' NOT NULL, artifacts_payload text DEFAULT '[]' NOT NULL, created_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_lab_messages_owner_created ON lab_messages (owner_id, created_at)",
  "CREATE TABLE IF NOT EXISTS lab_agent_runs (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, conversation_id text NOT NULL, phase text NOT NULL, label text NOT NULL, detail text DEFAULT '' NOT NULL, status text DEFAULT 'running' NOT NULL, updated_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_lab_agent_runs_owner_updated ON lab_agent_runs (owner_id, updated_at)",
  "CREATE TABLE IF NOT EXISTS news_tests (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, period_start text NOT NULL, period_end text NOT NULL, topic text NOT NULL, article_count integer NOT NULL, overall_score real NOT NULL, overall_label text NOT NULL, tech_score real NOT NULL, tech_label text NOT NULL, value_score real NOT NULL, value_label text NOT NULL, nasdaq_payload text NOT NULL, nyse_payload text NOT NULL, forecast_payload text DEFAULT '[]' NOT NULL, created_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_news_tests_owner_created ON news_tests (owner_id, created_at)",
  "CREATE TABLE IF NOT EXISTS news_agent_messages (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, role text NOT NULL, content text NOT NULL, created_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_news_agent_owner_created ON news_agent_messages (owner_id, created_at)",
  "CREATE TABLE IF NOT EXISTS news_research_runs (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, command text NOT NULL, label text NOT NULL, status text NOT NULL, total_events integer NOT NULL, completed_events integer DEFAULT 0 NOT NULL, failed_events integer DEFAULT 0 NOT NULL, stages_payload text DEFAULT '[]' NOT NULL, result_payload text DEFAULT '{}' NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_news_runs_owner_updated ON news_research_runs (owner_id, updated_at)",
  "CREATE TABLE IF NOT EXISTS llm_usage (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, provider text NOT NULL, model text NOT NULL, feature text NOT NULL, input_tokens integer NOT NULL, output_tokens integer NOT NULL, cache_creation_input_tokens integer DEFAULT 0 NOT NULL, cache_read_input_tokens integer DEFAULT 0 NOT NULL, cost_usd real NOT NULL, priced integer DEFAULT true NOT NULL, created_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_llm_usage_owner_created ON llm_usage (owner_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_llm_usage_owner_model ON llm_usage (owner_id, model)",
  "CREATE TABLE IF NOT EXISTS conversations (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, kind text NOT NULL, title text NOT NULL, preview text DEFAULT '' NOT NULL, message_count integer DEFAULT 0 NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_conversations_owner_updated ON conversations (owner_id, updated_at)",
  "CREATE TABLE IF NOT EXISTS strategies (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, name text NOT NULL, status text DEFAULT 'draft' NOT NULL, spec_payload text NOT NULL, latest_result_payload text DEFAULT 'null' NOT NULL, source_conversation_id text, created_at integer NOT NULL, updated_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_strategies_owner_updated ON strategies (owner_id, updated_at)",
  "CREATE TABLE IF NOT EXISTS strategy_runs (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, strategy_id text NOT NULL, spec_payload text NOT NULL, result_payload text NOT NULL, verdict text NOT NULL, created_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_strategy_runs_strategy_created ON strategy_runs (strategy_id, created_at)",
  "CREATE TABLE IF NOT EXISTS research_findings (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, title text NOT NULL, claim text NOT NULL, evidence_payload text DEFAULT '[]' NOT NULL, symbols text DEFAULT '' NOT NULL, tags text DEFAULT '' NOT NULL, confidence text DEFAULT 'medium' NOT NULL, status text DEFAULT 'open' NOT NULL, falsification text DEFAULT '' NOT NULL, source_conversation_id text, created_at integer NOT NULL, updated_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_research_findings_owner_updated ON research_findings (owner_id, updated_at)",
  // The spine: every store keys off `event_root`, and point-in-time correctness
  // depends on keeping the first-released value separate from later revisions.
  "CREATE TABLE IF NOT EXISTS market_events (id text PRIMARY KEY NOT NULL, event_root text NOT NULL, event_date text NOT NULL, event_time_et text DEFAULT '' NOT NULL, released_before_close integer DEFAULT true NOT NULL, category text DEFAULT '' NOT NULL, importance text DEFAULT 'medium' NOT NULL, title text DEFAULT '' NOT NULL, unit text DEFAULT '' NOT NULL, actual_initial real, actual_revised real, consensus real, previous real, surprise real, surprise_z real, surprise_basis text DEFAULT '' NOT NULL, source text DEFAULT '' NOT NULL, updated_at integer NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_market_events_root_date ON market_events (event_root, event_date)",
  "CREATE INDEX IF NOT EXISTS idx_market_events_date ON market_events (event_date)",
  "CREATE TABLE IF NOT EXISTS paper_positions (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, strategy_id text NOT NULL, symbol text NOT NULL, quantity real NOT NULL, average_price real NOT NULL, opened_at text NOT NULL, closed_at text, realized_pnl_usd real DEFAULT 0 NOT NULL, status text DEFAULT 'open' NOT NULL, updated_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_paper_positions_owner_strategy ON paper_positions (owner_id, strategy_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_positions_open ON paper_positions (owner_id, strategy_id, symbol, status)",
  "CREATE TABLE IF NOT EXISTS paper_fills (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, strategy_id text NOT NULL, symbol text NOT NULL, side text NOT NULL, quantity real NOT NULL, signal_date text NOT NULL, fill_date text NOT NULL, reference_price real NOT NULL, fill_price real NOT NULL, slippage_bps real DEFAULT 0 NOT NULL, cost_usd real DEFAULT 0 NOT NULL, reason text DEFAULT '' NOT NULL, gateway text DEFAULT 'dry_run' NOT NULL, created_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_paper_fills_owner_strategy ON paper_fills (owner_id, strategy_id)",
  "CREATE INDEX IF NOT EXISTS idx_paper_fills_signal_date ON paper_fills (signal_date)",
  "CREATE TABLE IF NOT EXISTS paper_daily_pnl (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, strategy_id text NOT NULL, trading_date text NOT NULL, equity_usd real NOT NULL, realized_pnl_usd real DEFAULT 0 NOT NULL, unrealized_pnl_usd real DEFAULT 0 NOT NULL, return_pct real, benchmark_return_pct real, open_positions integer DEFAULT 0 NOT NULL, created_at integer NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_pnl_strategy_date ON paper_daily_pnl (owner_id, strategy_id, trading_date)",
  // The 전략 board: which coded rules are running, and the markdown record of every run.
  "CREATE TABLE IF NOT EXISTS trade_strategy_instances (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, strategy_key text NOT NULL, name text NOT NULL, capital_usd real NOT NULL, gateway text DEFAULT 'dry_run' NOT NULL, last_backtest_at integer, last_trade_at integer, created_at integer NOT NULL, updated_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_trade_instances_owner ON trade_strategy_instances (owner_id, updated_at)",
  "CREATE TABLE IF NOT EXISTS trade_strategy_reports (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, instance_id text NOT NULL, strategy_key text NOT NULL, kind text NOT NULL, title text NOT NULL, filename text NOT NULL, markdown text NOT NULL, summary_payload text DEFAULT '{}' NOT NULL, created_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_trade_reports_instance ON trade_strategy_reports (instance_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_trade_reports_owner ON trade_strategy_reports (owner_id, created_at)",
  // Relay backtest bar cache: one row per symbol-session, plus which ranges were fetched.
  "CREATE TABLE IF NOT EXISTS intraday_bar_days (id text PRIMARY KEY NOT NULL, symbol text NOT NULL, interval text NOT NULL, trading_date text NOT NULL, payload text NOT NULL, provider text NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_intraday_bar_days_symbol_date ON intraday_bar_days (symbol, interval, trading_date)",
  "CREATE TABLE IF NOT EXISTS intraday_bar_coverage (id text PRIMARY KEY NOT NULL, symbol text NOT NULL, interval text NOT NULL, month text NOT NULL, from_date text NOT NULL, to_date text NOT NULL, complete integer DEFAULT false NOT NULL, fetched_at integer NOT NULL)",
  // 급등주: the shared ranking history (one row per session, every liquid ticker's
  // close) plus the per-run research job and what it published.
  "CREATE TABLE IF NOT EXISTS surge_intraday_observations (trading_date text NOT NULL, pool text NOT NULL, symbol text NOT NULL, payload text NOT NULL, PRIMARY KEY (trading_date,pool,symbol))",
  "CREATE TABLE IF NOT EXISTS surge_observation_status (trading_date text PRIMARY KEY NOT NULL, checked_at text NOT NULL, error text, cursor integer DEFAULT 0 NOT NULL, lease_owner text, lease_until integer)",
  "CREATE TABLE IF NOT EXISTS surge_market_days (trading_date text PRIMARY KEY NOT NULL, payload text NOT NULL, tickers integer DEFAULT 0 NOT NULL, created_at integer NOT NULL)",
  "CREATE TABLE IF NOT EXISTS surge_rank_days (id text PRIMARY KEY NOT NULL, ranked_on text NOT NULL, pool text NOT NULL, payload text NOT NULL, created_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_surge_rank_pool_date ON surge_rank_days (pool, ranked_on)",
  "CREATE TABLE IF NOT EXISTS surge_generation_runs (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, pool text NOT NULL, status text NOT NULL, payload text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, lease_owner text, lease_until integer)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_surge_generation_active ON surge_generation_runs(status) WHERE status='running'",
  "CREATE INDEX IF NOT EXISTS idx_surge_generation_owner ON surge_generation_runs(owner_id,created_at)",
  "CREATE TABLE IF NOT EXISTS generated_surge_strategies (id text PRIMARY KEY NOT NULL, run_id text NOT NULL UNIQUE, owner_id text NOT NULL, pool text NOT NULL, spec_payload text NOT NULL, evidence_payload text NOT NULL, created_at integer NOT NULL)",
  // Corporate actions. A 1:10 reverse split reads as +900% in raw prices, so the
  // ranking has to know which moves were splits before it calls one a surge.
  "CREATE TABLE IF NOT EXISTS surge_splits (id text PRIMARY KEY NOT NULL, ticker text NOT NULL, execution_date text NOT NULL, split_from real NOT NULL, split_to real NOT NULL, created_at integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_surge_splits_date ON surge_splits (execution_date)",
  // 급등락 사례: the owner's nightly Toss TOP_GAINERS/TOP_LOSERS top 10, and each case's own session minutes.
  "CREATE TABLE IF NOT EXISTS surge_cases (id text PRIMARY KEY NOT NULL, stated_date text NOT NULL, symbol text NOT NULL, board text NOT NULL, reported_pct real NOT NULL, rank integer NOT NULL, line text NOT NULL, status text NOT NULL, session_date text, attempts integer DEFAULT 0 NOT NULL, error text, profile text, minutes text, received_at integer NOT NULL, collected_at integer)",
  "CREATE INDEX IF NOT EXISTS idx_surge_cases_status ON surge_cases (status, stated_date)",
  // The live and paper trading dashboards. The lease serialises ticks from the page and the runner.
  "CREATE TABLE IF NOT EXISTS trading_dashboards (id text PRIMARY KEY NOT NULL, state_payload text NOT NULL, lease_owner text, lease_until integer, last_tick_at integer, runner_heartbeat_at integer, updated_at integer NOT NULL)",
];

// SQLite has no ADD COLUMN IF NOT EXISTS; a duplicate-column error just means the column is already there.
const COLUMN_ADDITIONS = [
  "ALTER TABLE lab_messages ADD COLUMN conversation_id text",
  "ALTER TABLE news_agent_messages ADD COLUMN conversation_id text",
  "CREATE INDEX IF NOT EXISTS idx_lab_messages_conversation ON lab_messages (conversation_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_news_agent_conversation ON news_agent_messages (conversation_id, created_at)",
  // Usage rows recorded before this column existed keep a NULL role and are reported as "기록 이전".
  "ALTER TABLE llm_usage ADD COLUMN role text",
  "CREATE INDEX IF NOT EXISTS idx_llm_usage_owner_role ON llm_usage (owner_id, role)",
  // Lineage: which finding a strategy mechanises, so a refuted finding can flag its strategies.
  "ALTER TABLE strategies ADD COLUMN source_finding_id text",
  // Findings join the event spine the same way strategy operands do.
  "ALTER TABLE research_findings ADD COLUMN event_roots text DEFAULT '' NOT NULL",
  // Rows written before the ranking moved to raw prices hold split-adjusted closes,
  // which put a later reverse split into a past session. They are ignored on read
  // and re-downloaded, rather than silently mixed with correct ones.
  "ALTER TABLE surge_market_days ADD COLUMN basis text DEFAULT 'adjusted' NOT NULL",
  "ALTER TABLE surge_rank_days ADD COLUMN basis text DEFAULT 'adjusted' NOT NULL",
];

let ready: Promise<void> | undefined;

export function ensureSchema() {
  if (ready) return ready;
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) return Promise.reject(new Error("Cloudflare D1 binding `DB` is unavailable."));
  ready = binding.batch(STATEMENTS.map((statement) => binding.prepare(statement))).then(async () => {
    for (const statement of COLUMN_ADDITIONS) {
      try {
        await binding.prepare(statement).run();
      } catch (error) {
        if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }).catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}
