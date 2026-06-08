CREATE TABLE IF NOT EXISTS "op_service_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "op_service_accounts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "stack_sources" ADD COLUMN "op_service_account_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stack_sources" ADD CONSTRAINT "stack_sources_op_service_account_id_op_service_accounts_id_fk" FOREIGN KEY ("op_service_account_id") REFERENCES "public"."op_service_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
