CREATE TABLE `news_agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_news_agent_owner_created` ON `news_agent_messages` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `news_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`topic` text NOT NULL,
	`article_count` integer NOT NULL,
	`overall_score` real NOT NULL,
	`overall_label` text NOT NULL,
	`tech_score` real NOT NULL,
	`tech_label` text NOT NULL,
	`value_score` real NOT NULL,
	`value_label` text NOT NULL,
	`nasdaq_payload` text NOT NULL,
	`nyse_payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_news_tests_owner_created` ON `news_tests` (`owner_id`,`created_at`);