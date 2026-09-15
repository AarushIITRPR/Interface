CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`step_id` text NOT NULL,
	`chunk` integer NOT NULL,
	`samples_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_annotations_code` ON `annotations` (`code`,`step_id`,`chunk`);