ALTER TABLE `auto_update_settings` ADD `minimum_image_age_days` integer;--> statement-breakpoint
ALTER TABLE `auto_update_settings` ADD `bypass_age_for_security_fixes` integer;--> statement-breakpoint
ALTER TABLE `auto_update_settings` ADD `excluded_from_env_update` integer DEFAULT false;