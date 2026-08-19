ALTER TABLE `pending_container_updates` ADD `has_image_update` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_container_updates` ADD `newer_version` text;