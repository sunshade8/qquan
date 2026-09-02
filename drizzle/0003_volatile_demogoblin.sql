CREATE TABLE `llm_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`feature` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_input_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real NOT NULL,
	`priced` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_llm_usage_owner_created` ON `llm_usage` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_owner_model` ON `llm_usage` (`owner_id`,`model`);--> statement-breakpoint
CREATE TABLE `news_research_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`command` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`total_events` integer NOT NULL,
	`completed_events` integer DEFAULT 0 NOT NULL,
	`failed_events` integer DEFAULT 0 NOT NULL,
	`stages_payload` text DEFAULT '[]' NOT NULL,
	`result_payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_news_runs_owner_updated` ON `news_research_runs` (`owner_id`,`updated_at`);