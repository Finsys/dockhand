ALTER TABLE `sessions` ADD `oidc_sub` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `oidc_sid` text;--> statement-breakpoint
CREATE INDEX `sessions_oidc_sub_idx` ON `sessions` (`oidc_sub`);--> statement-breakpoint
CREATE INDEX `sessions_oidc_sid_idx` ON `sessions` (`oidc_sid`);