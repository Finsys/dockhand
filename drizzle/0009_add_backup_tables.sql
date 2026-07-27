CREATE TABLE IF NOT EXISTS `backup_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text DEFAULT 'container' NOT NULL,
	`target_name` text NOT NULL,
	`environment_id` integer,
	`destination_id` integer NOT NULL,
	`enabled` integer DEFAULT true,
	`all_volumes` integer DEFAULT true,
	`selected_volumes` text,
	`stop_before_backup` integer DEFAULT false,
	`schedule` text,
	`retention` text,
	`options` text,
	`tags` text,
	`last_backup_at` text,
	`last_backup_status` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `backup_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `backup_destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`repository` text NOT NULL,
	`password` text NOT NULL,
	`env_vars` text,
	`flags` text,
	`host_path` text,
	`policies` text,
	`last_test_at` text,
	`last_test_status` text,
	`last_test_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `backup_destinations_name_unique` ON `backup_destinations` (`name`);
