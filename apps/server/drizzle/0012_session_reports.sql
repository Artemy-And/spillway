ALTER TABLE `budget_reservations` ADD `session_id` text;--> statement-breakpoint
CREATE INDEX `budget_session_idx` ON `budget_reservations` (`session_id`);--> statement-breakpoint
ALTER TABLE `request_logs` ADD `usage_known` integer;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `session_id` text;--> statement-breakpoint
CREATE INDEX `request_logs_session_idx` ON `request_logs` (`session_id`,`created_at`);