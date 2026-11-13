CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"notification_id" integer NOT NULL REFERENCES "notification_settings"("id") ON DELETE cascade,
	"environment_id" integer REFERENCES "environments"("id") ON DELETE cascade,
	"event_type" text,
	"scope" text NOT NULL,
	"destination_hash" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"created_at" integer NOT NULL,
	"due_at" integer NOT NULL,
	"expires_at" integer NOT NULL,
	"retention_days" integer NOT NULL,
	"finished_at" integer,
	"lease_until" integer,
	"lease_token" text,
	"last_error" text,
	"http_status" integer
);
--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" ("status", "due_at");
--> statement-breakpoint
CREATE INDEX "notification_deliveries_channel_idx" ON "notification_deliveries" ("notification_id", "created_at");
