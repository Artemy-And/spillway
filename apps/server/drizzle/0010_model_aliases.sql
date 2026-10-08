CREATE TABLE `model_aliases` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`strategy` text DEFAULT 'weighted' NOT NULL,
	`targets` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `routing_sessions` ADD `selector` text;