CREATE TABLE `container_icon_overrides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`container_name` text NOT NULL,
	`environment_id` integer,
	`icon` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `container_icon_overrides_container_name_environment_id_unique` ON `container_icon_overrides` (`container_name`,`environment_id`);--> statement-breakpoint
ALTER TABLE `backup_destinations` ADD `cacert` text;--> statement-breakpoint
ALTER TABLE `backup_destinations` ADD `tls_client_cert` text;