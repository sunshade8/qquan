CREATE TABLE IF NOT EXISTS trade_strategy_instances (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, strategy_key text NOT NULL, name text NOT NULL, capital_usd real NOT NULL, gateway text DEFAULT 'dry_run' NOT NULL, last_backtest_at integer, last_trade_at integer, created_at integer NOT NULL, updated_at integer NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_trade_instances_owner ON trade_strategy_instances (owner_id, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS trade_strategy_reports (id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, instance_id text NOT NULL, strategy_key text NOT NULL, kind text NOT NULL, title text NOT NULL, filename text NOT NULL, markdown text NOT NULL, summary_payload text DEFAULT '{}' NOT NULL, created_at integer NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_trade_reports_instance ON trade_strategy_reports (instance_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_trade_reports_owner ON trade_strategy_reports (owner_id, created_at);
