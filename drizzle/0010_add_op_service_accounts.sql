CREATE TABLE `op_service_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `op_service_accounts_name_unique` ON `op_service_accounts` (`name`);--> statement-breakpoint
ALTER TABLE `stack_sources` ADD `op_service_account_id` integer REFERENCES op_service_accounts(id);