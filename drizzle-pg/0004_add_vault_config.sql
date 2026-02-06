CREATE TABLE IF NOT EXISTS "vault_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"namespace" text,
	"default_path" text,
	"auth_method" text NOT NULL,
	"token" text,
	"role_id" text,
	"secret_id" text,
	"kube_role" text,
	"enabled" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
