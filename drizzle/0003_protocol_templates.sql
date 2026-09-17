CREATE TABLE `protocol_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`label` text NOT NULL,
	`template_json` text NOT NULL,
	`active` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_protocol_active` ON `protocol_templates` (`active`,`version`);--> statement-breakpoint
ALTER TABLE `media_assets` ADD `duration_sec` real;
