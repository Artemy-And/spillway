CREATE TABLE `budget_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`key_id` text,
	`team_id` text,
	`model_name` text NOT NULL,
	`provider_name` text NOT NULL,
	`state` text NOT NULL,
	`estimated_usd` real NOT NULL,
	`held_usd` real NOT NULL,
	`charged_usd` real DEFAULT 0 NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `budget_key_idx` ON `budget_reservations` (`key_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `budget_team_idx` ON `budget_reservations` (`team_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `budget_request_idx` ON `budget_reservations` (`request_id`);--> statement-breakpoint
CREATE INDEX `budget_state_idx` ON `budget_reservations` (`state`);--> statement-breakpoint
ALTER TABLE `request_logs` ADD `cost_known` integer;