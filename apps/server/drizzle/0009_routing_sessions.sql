CREATE TABLE `routing_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`profile_id` text,
	`requested_model_id` text NOT NULL,
	`target_model_id` text NOT NULL,
	`contract_hash` text NOT NULL,
	`baseline` text NOT NULL,
	`target` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routing_sessions_key` ON `routing_sessions` (`key_id`);--> statement-breakpoint
CREATE INDEX `routing_sessions_expiry` ON `routing_sessions` (`expires_at`);