CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`step_id` text NOT NULL,
	`event_type` text NOT NULL,
	`severity` text NOT NULL,
	`source` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_session_sequence` ON `events` (`session_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_media_created` ON `media_assets` (`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`participant_id` integer NOT NULL,
	`operator` text NOT NULL,
	`protocol_version` text NOT NULL,
	`status` text NOT NULL,
	`step_index` integer NOT NULL,
	`revision` integer NOT NULL,
	`assignment_json` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sessions_code` ON `sessions` (`code`);--> statement-breakpoint
CREATE INDEX `idx_sessions_updated` ON `sessions` (`updated_at`);