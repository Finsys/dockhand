ALTER TABLE "pending_container_updates" ADD COLUMN "has_image_update" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_container_updates" ADD COLUMN "newer_version" text;