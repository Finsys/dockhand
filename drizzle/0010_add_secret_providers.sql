CREATE TABLE `secret_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_providers_name_unique` ON `secret_providers` (`name`);--> statement-breakpoint
ALTER TABLE `stack_sources` ADD `secret_provider_id` integer REFERENCES secret_providers(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `stack_sources` ADD `injected_secret_keys` text;
