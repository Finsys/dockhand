ALTER TABLE "git_stacks" ADD COLUMN "context_dir" text;--> statement-breakpoint
ALTER TABLE "git_stacks" ADD COLUMN "no_build_cache" boolean DEFAULT false;
