ALTER TABLE "auto_update_settings" ADD COLUMN "minimum_image_age_days" integer;--> statement-breakpoint
ALTER TABLE "auto_update_settings" ADD COLUMN "bypass_age_for_security_fixes" boolean;--> statement-breakpoint
ALTER TABLE "auto_update_settings" ADD COLUMN "excluded_from_env_update" boolean DEFAULT false;