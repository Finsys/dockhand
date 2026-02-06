CREATE TABLE `vault_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address` text NOT NULL,
	`namespace` text,
	`default_path` text,
	`auth_method` text NOT NULL,
	`token` text,
	`role_id` text,
	`secret_id` text,
	`kube_role` text,
	`enabled` integer DEFAULT true,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
