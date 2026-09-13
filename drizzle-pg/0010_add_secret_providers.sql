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
ALTER TABLE "stack_sources" ADD COLUMN "secret_provider_id" integer;--> statement-breakpoint
ALTER TABLE "stack_sources" ADD COLUMN "injected_secret_keys" text;--> statement-breakpoint
ALTER TABLE "stack_sources" ADD CONSTRAINT "stack_sources_secret_provider_id_secret_providers_id_fk" FOREIGN KEY ("secret_provider_id") REFERENCES "public"."secret_providers"("id") ON DELETE set null ON UPDATE no action;
