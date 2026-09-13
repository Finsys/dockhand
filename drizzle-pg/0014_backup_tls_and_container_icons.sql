CREATE TABLE "container_icon_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"container_name" text NOT NULL,
	"environment_id" integer,
	"icon" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "container_icon_overrides_container_name_environment_id_unique" UNIQUE("container_name","environment_id")
);
--> statement-breakpoint
ALTER TABLE "backup_destinations" ADD COLUMN "cacert" text;--> statement-breakpoint
ALTER TABLE "backup_destinations" ADD COLUMN "tls_client_cert" text;--> statement-breakpoint
ALTER TABLE "container_icon_overrides" ADD CONSTRAINT "container_icon_overrides_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;