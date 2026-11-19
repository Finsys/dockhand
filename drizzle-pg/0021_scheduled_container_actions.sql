CREATE TABLE "scheduled_container_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"environment_id" integer NOT NULL,
	"container_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"start_at" text,
	"stop_at" text,
	"source" text DEFAULT 'ui' NOT NULL,
	"last_started" timestamp,
	"last_stopped" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "scheduled_container_actions_environment_id_container_name_unique" UNIQUE("environment_id","container_name")
);
--> statement-breakpoint
ALTER TABLE "scheduled_container_actions" ADD CONSTRAINT "scheduled_container_actions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;