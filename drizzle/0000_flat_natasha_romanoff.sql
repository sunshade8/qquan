CREATE TABLE `backtest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`hypothesis_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`initial_capital` real NOT NULL,
	`annual_return` real NOT NULL,
	`max_drawdown` real NOT NULL,
	`sharpe` real NOT NULL,
	`win_rate` real NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_runs_hypothesis_id` ON `backtest_runs` (`hypothesis_id`);--> statement-breakpoint
CREATE INDEX `idx_backtest_runs_created_at` ON `backtest_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `daily_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`trading_date` text NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`adjusted_close` real NOT NULL,
	`volume` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_daily_prices_symbol_date` ON `daily_prices` (`symbol`,`trading_date`);--> statement-breakpoint
CREATE INDEX `idx_daily_prices_date` ON `daily_prices` (`trading_date`);--> statement-breakpoint
CREATE TABLE `hypotheses` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`symbol_universe` text NOT NULL,
	`thesis` text NOT NULL,
	`entry_rule` text NOT NULL,
	`exit_rule` text NOT NULL,
	`sizing_rule` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hypotheses_updated_at` ON `hypotheses` (`updated_at`);--> statement-breakpoint
CREATE TABLE `market_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`rows_written` integer DEFAULT 0 NOT NULL,
	`message` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `securities` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sector` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
PRAGMA optimize;
