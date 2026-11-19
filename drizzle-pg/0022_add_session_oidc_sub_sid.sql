ALTER TABLE "sessions" ADD COLUMN "oidc_sub" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "oidc_sid" text;--> statement-breakpoint
CREATE INDEX "sessions_oidc_sub_idx" ON "sessions" USING btree ("oidc_sub");--> statement-breakpoint
CREATE INDEX "sessions_oidc_sid_idx" ON "sessions" USING btree ("oidc_sid");