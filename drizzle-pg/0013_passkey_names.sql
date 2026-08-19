UPDATE "passkey_credentials" SET "name" = 'Passkey ' || "id" WHERE "name" IS NULL OR btrim("name") = '';--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credentials_user_name_unique" ON "passkey_credentials" USING btree ("user_id",lower("name"));
