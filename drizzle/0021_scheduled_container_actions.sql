CREATE TABLE `scheduled_container_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`environment_id` integer NOT NULL,
	`container_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`start_at` text,
	`stop_at` text,
	`source` text DEFAULT 'ui' NOT NULL,
	`last_started` text,
	`last_stopped` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_container_actions_environment_id_container_name_unique` ON `scheduled_container_actions` (`environment_id`,`container_name`);