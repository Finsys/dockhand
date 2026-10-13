ALTER TABLE "backup_destinations" ADD COLUMN "ssh_private_key" text;--> statement-breakpoint
ALTER TABLE "backup_destinations" ADD COLUMN "ssh_known_hosts" text;