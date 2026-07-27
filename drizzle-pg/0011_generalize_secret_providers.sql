CREATE TABLE "secret_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "secret_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
INSERT INTO "secret_providers" ("id", "type", "name", "config", "created_at", "updated_at") SELECT "id", 'op-service-account', "name", "token", "created_at", "updated_at" FROM "op_service_accounts";--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('secret_providers', 'id'), COALESCE((SELECT MAX("id") FROM "secret_providers"), 1));--> statement-breakpoint
ALTER TABLE "stack_sources" ADD COLUMN "secret_provider_id" integer;--> statement-breakpoint
UPDATE "stack_sources" SET "secret_provider_id" = "op_service_account_id";--> statement-breakpoint
ALTER TABLE "stack_sources" ADD CONSTRAINT "stack_sources_secret_provider_id_secret_providers_id_fk" FOREIGN KEY ("secret_provider_id") REFERENCES "public"."secret_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_sources" DROP CONSTRAINT IF EXISTS "stack_sources_op_service_account_id_op_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "stack_sources" DROP COLUMN "op_service_account_id";--> statement-breakpoint
DROP TABLE "op_service_accounts";