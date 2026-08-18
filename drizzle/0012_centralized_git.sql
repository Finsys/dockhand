ALTER TABLE `environments` ADD `hawser_stacks_dir` text;--> statement-breakpoint
ALTER TABLE `git_stacks` ADD `compose_paths` text;--> statement-breakpoint
ALTER TABLE `stack_sources` ADD `compose_paths` text;--> statement-breakpoint
ALTER TABLE `git_stacks` ADD `engine` text DEFAULT 'stack' NOT NULL;--> statement-breakpoint
CREATE TABLE `git_migration_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`job_id` text,
	`stack_ids` text,
	`snapshot` text,
	`error` text,
	`started_at` text,
	`finished_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);