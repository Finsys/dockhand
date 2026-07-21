ALTER TABLE `git_repositories` ADD `webhook_deploy_delay` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `git_repositories` ADD `webhook_deploy_mode` text DEFAULT 'parallel';
