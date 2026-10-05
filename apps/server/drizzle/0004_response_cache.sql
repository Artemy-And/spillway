CREATE TABLE `response_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`model_id` text NOT NULL,
	`body` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `response_cache_expires_idx` ON `response_cache` (`expires_at`);