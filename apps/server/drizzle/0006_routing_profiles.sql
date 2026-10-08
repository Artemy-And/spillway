CREATE TABLE `routing_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_id` text NOT NULL,
	`comparison_id` text NOT NULL,
	`baseline_model_id` text NOT NULL,
	`candidate_model_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`fallback_on_error` integer DEFAULT true NOT NULL,
	`evidence` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`baseline_model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routing_profiles_key_id_unique` ON `routing_profiles` (`key_id`);--> statement-breakpoint
ALTER TABLE `request_logs` ADD `attempted_model_id` text;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `routing_profile_id` text;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `routing_profile_name` text;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `routing_outcome` text;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `routing_cost_known` integer;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `baseline_cost_usd` real;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `routing_savings_usd` real;--> statement-breakpoint
CREATE INDEX `request_logs_routing_idx` ON `request_logs` (`routing_profile_id`,`created_at`);