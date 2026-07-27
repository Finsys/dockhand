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
INSERT INTO `secret_providers` (`id`, `type`, `name`, `config`, `created_at`, `updated_at`) SELECT `id`, 'op-service-account', `name`, `token`, `created_at`, `updated_at` FROM `op_service_accounts`;--> statement-breakpoint
ALTER TABLE `stack_sources` ADD `secret_provider_id` integer REFERENCES secret_providers(id);--> statement-breakpoint
UPDATE `stack_sources` SET `secret_provider_id` = `op_service_account_id`;--> statement-breakpoint
ALTER TABLE `stack_sources` DROP COLUMN `op_service_account_id`;--> statement-breakpoint
DROP TABLE `op_service_accounts`;