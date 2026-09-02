CREATE TABLE `lab_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tools_payload` text DEFAULT '[]' NOT NULL,
	`artifacts_payload` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_lab_messages_owner_created` ON `lab_messages` (`owner_id`,`created_at`);