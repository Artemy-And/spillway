CREATE TABLE `native_session_states` (
	`session_id` text PRIMARY KEY NOT NULL,
	`format` text NOT NULL,
	`config_hash` text NOT NULL,
	`credential_hash` text NOT NULL,
	`head_hash` text,
	`history_length` integer DEFAULT 0 NOT NULL,
	`pending_call_hash` text,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`pii` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`in_flight` text,
	`interrupted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `routing_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
