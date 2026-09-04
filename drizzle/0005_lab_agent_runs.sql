CREATE TABLE IF NOT EXISTS `lab_agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`phase` text NOT NULL,
	`label` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_lab_agent_runs_owner_updated` ON `lab_agent_runs` (`owner_id`,`updated_at`);
