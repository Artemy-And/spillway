CREATE TABLE `limit_asks` (
	`id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`user_id` text,
	`usd` real NOT NULL,
	`reason` text,
	`day` text NOT NULL,
	`created_at` integer NOT NULL,
	`approved` integer,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `limit_asks_day_idx` ON `limit_asks` (`day`,`key_id`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `extra` text;