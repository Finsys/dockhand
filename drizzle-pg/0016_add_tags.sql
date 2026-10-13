CREATE TABLE "container_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"container_name" text NOT NULL,
	"environment_id" integer,
	"tag_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "container_tags_container_name_environment_id_tag_id_unique" UNIQUE("container_name","environment_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "stack_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"stack_name" text NOT NULL,
	"environment_id" integer,
	"tag_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "stack_tags_stack_name_environment_id_tag_id_unique" UNIQUE("stack_name","environment_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'slate' NOT NULL,
	"icon" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tags_name_unique" ON "tags" (lower("name"));--> statement-breakpoint
ALTER TABLE "container_tags" ADD CONSTRAINT "container_tags_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_tags" ADD CONSTRAINT "container_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_tags" ADD CONSTRAINT "stack_tags_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_tags" ADD CONSTRAINT "stack_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;