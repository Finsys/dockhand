UPDATE `passkey_credentials` SET `name` = 'Passkey ' || `id` WHERE `name` IS NULL OR trim(`name`) = '';--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_credentials_user_name_unique` ON `passkey_credentials` (`user_id`,lower("name"));
