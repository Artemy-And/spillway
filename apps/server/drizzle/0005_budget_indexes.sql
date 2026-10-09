DROP INDEX `request_logs_key_idx`;--> statement-breakpoint
DROP INDEX `request_logs_team_idx`;--> statement-breakpoint
CREATE INDEX `request_logs_key_idx` ON `request_logs` (`key_id`,`created_at`,`cost_usd`);--> statement-breakpoint
CREATE INDEX `request_logs_team_idx` ON `request_logs` (`team_id`,`created_at`,`cost_usd`);