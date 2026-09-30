CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`team_id` text,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`daily_limit_usd` real,
	`monthly_limit_usd` real,
	`fallback_to_local` integer DEFAULT true NOT NULL,
	`allowed_model_ids` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE INDEX `api_keys_team_idx` ON `api_keys` (`team_id`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`label` text,
	`provider_id` text NOT NULL,
	`upstream_model` text NOT NULL,
	`input_price` real DEFAULT 0 NOT NULL,
	`output_price` real DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_name_unique` ON `models` (`name`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_enc` text,
	`is_local` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`key_id` text,
	`team_id` text,
	`format` text NOT NULL,
	`requested_model` text NOT NULL,
	`requested_model_id` text,
	`served_model_id` text,
	`served_model` text,
	`served_local` integer DEFAULT false NOT NULL,
	`provider_name` text,
	`status` integer NOT NULL,
	`result` text NOT NULL,
	`rule_id` text,
	`trace` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`saved_usd` real DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`stream` integer DEFAULT false NOT NULL,
	`pii` text,
	`prompt_preview` text,
	`response_preview` text,
	`error` text,
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `request_logs_created_idx` ON `request_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `request_logs_key_idx` ON `request_logs` (`key_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `request_logs_team_idx` ON `request_logs` (`team_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`monthly_budget_usd` real,
	`allowed_model_ids` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_name_unique` ON `teams` (`name`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`role` text DEFAULT 'member' NOT NULL,
	`team_id` text,
	`password_hash` text,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	`disabled_at` integer,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);