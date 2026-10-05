PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_models` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`label` text,
	`provider_id` text NOT NULL,
	`upstream_model` text NOT NULL,
	`input_price` real,
	`output_price` real,
	`cache_read_price` real,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_models`("id", "name", "label", "provider_id", "upstream_model", "input_price", "output_price", "enabled", "created_at") SELECT "id", "name", "label", "provider_id", "upstream_model", "input_price", "output_price", "enabled", "created_at" FROM `models`;--> statement-breakpoint
DROP TABLE `models`;--> statement-breakpoint
ALTER TABLE `__new_models` RENAME TO `models`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `models_name_unique` ON `models` (`name`);--> statement-breakpoint
-- Before prices could be left empty, 0 meant "not set". Cloud models at 0/0 become unset so they get flagged.
UPDATE `models` SET `input_price` = NULL, `output_price` = NULL WHERE `input_price` = 0 AND `output_price` = 0 AND `provider_id` IN (SELECT `id` FROM `providers` WHERE `is_local` = 0);