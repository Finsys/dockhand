CREATE TABLE `container_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`container_name` text NOT NULL,
	`environment_id` integer,
	`tag_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `container_tags_container_name_environment_id_tag_id_unique` ON `container_tags` (`container_name`,`environment_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `stack_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stack_name` text NOT NULL,
	`environment_id` integer,
	`tag_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stack_tags_stack_name_environment_id_tag_id_unique` ON `stack_tags` (`stack_name`,`environment_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'slate' NOT NULL,
	`icon` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name` COLLATE NOCASE);