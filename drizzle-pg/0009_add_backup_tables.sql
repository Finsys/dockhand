CREATE TABLE IF NOT EXISTS "backup_destinations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repository" text NOT NULL,
	"password" text NOT NULL,
	"env_vars" text,
	"flags" text,
	"host_path" text,
	"policies" text,
	"last_test_at" timestamp,
	"last_test_status" text,
	"last_test_error" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "backup_destinations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text DEFAULT 'container' NOT NULL,
	"target_name" text NOT NULL,
	"environment_id" integer,
	"destination_id" integer NOT NULL,
	"enabled" boolean DEFAULT true,
	"all_volumes" boolean DEFAULT true,
	"selected_volumes" text,
	"stop_before_backup" boolean DEFAULT false,
	"schedule" text,
	"retention" text,
	"options" text,
	"tags" text,
	"last_backup_at" timestamp,
	"last_backup_status" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_configs" ADD CONSTRAINT "backup_configs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_configs" ADD CONSTRAINT "backup_configs_destination_id_backup_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destinations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
