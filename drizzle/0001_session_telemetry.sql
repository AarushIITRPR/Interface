CREATE TABLE `session_telemetry` (
	`code` text PRIMARY KEY NOT NULL,
	`sensors_json` text,
	`acquisition_json` text,
	`operator_last_seen_at` text,
	`subject_last_seen_at` text,
	`updated_at` text NOT NULL
);
