/**
 * Drizzle ORM Schema for Dockhand - PostgreSQL Version
 *
 * This schema is used for PostgreSQL migrations and is a mirror of the SQLite schema
 * with PostgreSQL-specific types and syntax.
 */

import {
	pgTable,
	text,
	integer,
	serial,
	boolean,
	doublePrecision,
	bigint,
	timestamp,
	unique,
	index
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// =============================================================================
// CORE TABLES
// =============================================================================

export const environments = pgTable('environments', {
	id: serial('id').primaryKey(),
	name: text('name').notNull().unique(),
	host: text('host'),
	port: integer('port').default(2375),
	protocol: text('protocol').default('http'),
	tlsCa: text('tls_ca'),
	tlsCert: text('tls_cert'),
	tlsKey: text('tls_key'),
	tlsSkipVerify: boolean('tls_skip_verify').default(false),
	icon: text('icon').default('globe'),
	collectActivity: boolean('collect_activity').default(true),
	collectMetrics: boolean('collect_metrics').default(true),
	highlightChanges: boolean('highlight_changes').default(true),
	labels: text('labels'), // JSON array of label strings for categorization
	// Connection settings
	connectionType: text('connection_type').default('socket'), // 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge'
	socketPath: text('socket_path').default('/var/run/docker.sock'), // Unix socket path for 'socket' connection type
	hawserToken: text('hawser_token'), // Plain-text token for hawser-standard auth
	hawserLastSeen: timestamp('hawser_last_seen', { mode: 'string' }),
	hawserAgentId: text('hawser_agent_id'),
	hawserAgentName: text('hawser_agent_name'),
	hawserVersion: text('hawser_version'),
	hawserCapabilities: text('hawser_capabilities'), // JSON array: ["compose", "exec", "metrics"]
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

export const hawserTokens = pgTable('hawser_tokens', {
	id: serial('id').primaryKey(),
	token: text('token').notNull().unique(), // Hashed token
	tokenPrefix: text('token_prefix').notNull(), // First 8 chars for identification
	name: text('name').notNull(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	isActive: boolean('is_active').default(true),
	lastUsed: timestamp('last_used', { mode: 'string' }),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	expiresAt: timestamp('expires_at', { mode: 'string' })
});

export const registries = pgTable('registries', {
	id: serial('id').primaryKey(),
	name: text('name').notNull().unique(),
	url: text('url').notNull(),
	username: text('username'),
	password: text('password'),
	isDefault: boolean('is_default').default(false),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

export const settings = pgTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

// =============================================================================
// EVENT TRACKING TABLES
// =============================================================================

export const stackEvents = pgTable('stack_events', {
	id: serial('id').primaryKey(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	stackName: text('stack_name').notNull(),
	eventType: text('event_type').notNull(),
	timestamp: timestamp('timestamp', { mode: 'string' }).defaultNow(),
	metadata: text('metadata')
});

export const hostMetrics = pgTable('host_metrics', {
	id: serial('id').primaryKey(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	cpuPercent: doublePrecision('cpu_percent').notNull(),
	memoryPercent: doublePrecision('memory_percent').notNull(),
	memoryUsed: bigint('memory_used', { mode: 'number' }),
	memoryTotal: bigint('memory_total', { mode: 'number' }),
	timestamp: timestamp('timestamp', { mode: 'string' }).defaultNow()
}, (table) => ({
	envTimestampIdx: index('host_metrics_env_timestamp_idx').on(table.environmentId, table.timestamp)
}));

// =============================================================================
// CONFIGURATION TABLES
// =============================================================================

export const configSets = pgTable('config_sets', {
	id: serial('id').primaryKey(),
	name: text('name').notNull().unique(),
	description: text('description'),
	envVars: text('env_vars'),
	labels: text('labels'),
	ports: text('ports'),
	volumes: text('volumes'),
	networkMode: text('network_mode').default('bridge'),
	restartPolicy: text('restart_policy').default('no'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

export const autoUpdateSettings = pgTable('auto_update_settings', {
	id: serial('id').primaryKey(),
	environmentId: integer('environment_id').references(() => environments.id),
	containerName: text('container_name').notNull(),
	enabled: boolean('enabled').default(false),
	scheduleType: text('schedule_type').default('daily'),
	cronExpression: text('cron_expression'),
	vulnerabilityCriteria: text('vulnerability_criteria').default('never'), // 'never' | 'any' | 'critical_high' | 'critical' | 'more_than_current'
	lastChecked: timestamp('last_checked', { mode: 'string' }),
	lastUpdated: timestamp('last_updated', { mode: 'string' }),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	envContainerUnique: unique().on(table.environmentId, table.containerName)
}));

export const notificationSettings = pgTable('notification_settings', {
	id: serial('id').primaryKey(),
	type: text('type').notNull(),
	name: text('name').notNull(),
	enabled: boolean('enabled').default(true),
	config: text('config').notNull(),
	eventTypes: text('event_types'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

export const environmentNotifications = pgTable('environment_notifications', {
	id: serial('id').primaryKey(),
	environmentId: integer('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
	notificationId: integer('notification_id').notNull().references(() => notificationSettings.id, { onDelete: 'cascade' }),
	enabled: boolean('enabled').default(true),
	eventTypes: text('event_types'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	envNotifUnique: unique().on(table.environmentId, table.notificationId)
}));

// =============================================================================
// AUTHENTICATION TABLES
// =============================================================================

export const authSettings = pgTable('auth_settings', {
	id: serial('id').primaryKey(),
	authEnabled: boolean('auth_enabled').default(false),
	defaultProvider: text('default_provider').default('local'),
	sessionTimeout: integer('session_timeout').default(86400),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

export const users = pgTable('users', {
	id: serial('id').primaryKey(),
	username: text('username').notNull().unique(),
	email: text('email'),
	passwordHash: text('password_hash').notNull(),
	displayName: text('display_name'),
	avatar: text('avatar'),
	authProvider: text('auth_provider').default('local'), // e.g., 'local', 'oidc:Keycloak', 'ldap:AD'
	mfaEnabled: boolean('mfa_enabled').default(false),
	mfaSecret: text('mfa_secret'), // JSON: { secret: string, backupCodes: string[] }
	isActive: boolean('is_active').default(true),
	lastLogin: timestamp('last_login', { mode: 'string' }),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

export const sessions = pgTable('sessions', {
	id: text('id').primaryKey(),
	userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	provider: text('provider').notNull(),
	expiresAt: timestamp('expires_at', { mode: 'string' }).notNull(),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	userIdIdx: index('sessions_user_id_idx').on(table.userId),
	expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt)
}));

export const ldapConfig = pgTable('ldap_config', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
	enabled: boolean('enabled').default(false),
	serverUrl: text('server_url').notNull(),
	bindDn: text('bind_dn'),
	bindPassword: text('bind_password'),
	baseDn: text('base_dn').notNull(),
	userFilter: text('user_filter').default('(uid={{username}})'),
	usernameAttribute: text('username_attribute').default('uid'),
	emailAttribute: text('email_attribute').default('mail'),
	displayNameAttribute: text('display_name_attribute').default('cn'),
	groupBaseDn: text('group_base_dn'),
	groupFilter: text('group_filter'),
	adminGroup: text('admin_group'),
	roleMappings: text('role_mappings'), // JSON: [{ groupDn: string, roleId: number }]
	tlsEnabled: boolean('tls_enabled').default(false),
	tlsCa: text('tls_ca'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

export const oidcConfig = pgTable('oidc_config', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
	enabled: boolean('enabled').default(false),
	issuerUrl: text('issuer_url').notNull(),
	clientId: text('client_id').notNull(),
	clientSecret: text('client_secret').notNull(),
	redirectUri: text('redirect_uri').notNull(),
	scopes: text('scopes').default('openid profile email'),
	usernameClaim: text('username_claim').default('preferred_username'),
	emailClaim: text('email_claim').default('email'),
	displayNameClaim: text('display_name_claim').default('name'),
	adminClaim: text('admin_claim'),
	adminValue: text('admin_value'),
	roleMappingsClaim: text('role_mappings_claim').default('groups'),
	roleMappings: text('role_mappings'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

// =============================================================================
// ROLE-BASED ACCESS CONTROL TABLES
// =============================================================================

export const roles = pgTable('roles', {
	id: serial('id').primaryKey(),
	name: text('name').notNull().unique(),
	description: text('description'),
	isSystem: boolean('is_system').default(false),
	permissions: text('permissions').notNull(),
	environmentIds: text('environment_ids'), // JSON array of env IDs, null = all environments
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

export const userRoles = pgTable('user_roles', {
	id: serial('id').primaryKey(),
	userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	roleId: integer('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	userRoleEnvUnique: unique().on(table.userId, table.roleId, table.environmentId)
}));

// =============================================================================
// GIT INTEGRATION TABLES
// =============================================================================

export const gitCredentials = pgTable('git_credentials', {
	id: serial('id').primaryKey(),
	name: text('name').notNull().unique(),
	authType: text('auth_type').notNull().default('none'),
	username: text('username'),
	password: text('password'),
	sshPrivateKey: text('ssh_private_key'),
	sshPassphrase: text('ssh_passphrase'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

export const gitRepositories = pgTable('git_repositories', {
	id: serial('id').primaryKey(),
	name: text('name').notNull().unique(),
	url: text('url').notNull(),
	branch: text('branch').default('main'),
	credentialId: integer('credential_id').references(() => gitCredentials.id, { onDelete: 'set null' }),
	composePath: text('compose_path').default('compose.yaml'),
	environmentId: integer('environment_id'),
	autoUpdate: boolean('auto_update').default(false),
	autoUpdateSchedule: text('auto_update_schedule').default('daily'),
	autoUpdateCron: text('auto_update_cron').default('0 3 * * *'),
	webhookEnabled: boolean('webhook_enabled').default(false),
	webhookSecret: text('webhook_secret'),
	lastSync: timestamp('last_sync', { mode: 'string' }),
	lastCommit: text('last_commit'),
	syncStatus: text('sync_status').default('pending'),
	syncError: text('sync_error'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

export const gitStacks = pgTable('git_stacks', {
	id: serial('id').primaryKey(),
	stackName: text('stack_name').notNull(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	repositoryId: integer('repository_id').notNull().references(() => gitRepositories.id, { onDelete: 'cascade' }),
	composePath: text('compose_path').default('compose.yaml'),
	envFilePath: text('env_file_path'), // Path to .env file in repository (e.g., ".env", "config/.env.prod")
	autoUpdate: boolean('auto_update').default(false),
	autoUpdateSchedule: text('auto_update_schedule').default('daily'),
	autoUpdateCron: text('auto_update_cron').default('0 3 * * *'),
	webhookEnabled: boolean('webhook_enabled').default(false),
	webhookSecret: text('webhook_secret'),
	lastSync: timestamp('last_sync', { mode: 'string' }),
	lastCommit: text('last_commit'),
	syncStatus: text('sync_status').default('pending'),
	syncError: text('sync_error'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	stackEnvUnique: unique().on(table.stackName, table.environmentId)
}));

export const stackSources = pgTable('stack_sources', {
	id: serial('id').primaryKey(),
	stackName: text('stack_name').notNull(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	sourceType: text('source_type').notNull().default('internal'),
	gitRepositoryId: integer('git_repository_id').references(() => gitRepositories.id, { onDelete: 'set null' }),
	gitStackId: integer('git_stack_id').references(() => gitStacks.id, { onDelete: 'set null' }),
	composePath: text('compose_path'), // Custom path to compose file (for stacks with non-default location)
	envPath: text('env_path'), // Custom path to .env file (for stacks with non-default location)
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	stackSourceEnvUnique: unique().on(table.stackName, table.environmentId)
}));

export const stackEnvironmentVariables = pgTable('stack_environment_variables', {
	id: serial('id').primaryKey(),
	stackName: text('stack_name').notNull(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	key: text('key').notNull(),
	value: text('value').notNull(),
	isSecret: boolean('is_secret').default(false),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	stackEnvVarUnique: unique().on(table.stackName, table.environmentId, table.key)
}));

// =============================================================================
// SECURITY TABLES
// =============================================================================

export const vulnerabilityScans = pgTable('vulnerability_scans', {
	id: serial('id').primaryKey(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	imageId: text('image_id').notNull(),
	imageName: text('image_name').notNull(),
	scanner: text('scanner').notNull(),
	scannedAt: timestamp('scanned_at', { mode: 'string' }).notNull(),
	scanDuration: integer('scan_duration'),
	criticalCount: integer('critical_count').default(0),
	highCount: integer('high_count').default(0),
	mediumCount: integer('medium_count').default(0),
	lowCount: integer('low_count').default(0),
	negligibleCount: integer('negligible_count').default(0),
	unknownCount: integer('unknown_count').default(0),
	vulnerabilities: text('vulnerabilities'),
	error: text('error'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	envImageIdx: index('vulnerability_scans_env_image_idx').on(table.environmentId, table.imageId)
}));

// =============================================================================
// AUDIT LOGGING TABLES
// =============================================================================

export const auditLogs = pgTable('audit_logs', {
	id: serial('id').primaryKey(),
	userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
	username: text('username').notNull(),
	action: text('action').notNull(),
	entityType: text('entity_type').notNull(),
	entityId: text('entity_id'),
	entityName: text('entity_name'),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'set null' }),
	description: text('description'),
	details: text('details'),
	ipAddress: text('ip_address'),
	userAgent: text('user_agent'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	userIdIdx: index('audit_logs_user_id_idx').on(table.userId),
	createdAtIdx: index('audit_logs_created_at_idx').on(table.createdAt)
}));

// =============================================================================
// CONTAINER ACTIVITY TABLES
// =============================================================================

export const containerEvents = pgTable('container_events', {
	id: serial('id').primaryKey(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	containerId: text('container_id').notNull(),
	containerName: text('container_name'),
	image: text('image'),
	action: text('action').notNull(),
	actorAttributes: text('actor_attributes'),
	timestamp: timestamp('timestamp', { mode: 'string' }).notNull(),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	envTimestampIdx: index('container_events_env_timestamp_idx').on(table.environmentId, table.timestamp)
}));

// =============================================================================
// SCHEDULE EXECUTION TABLES
// =============================================================================

export const scheduleExecutions = pgTable('schedule_executions', {
	id: serial('id').primaryKey(),
	// Link to the scheduled job
	scheduleType: text('schedule_type').notNull(), // 'container_update' | 'git_stack_sync' | 'system_cleanup'
	scheduleId: integer('schedule_id').notNull(), // ID in autoUpdateSettings or gitStacks, or 0 for system jobs
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	// What ran
	entityName: text('entity_name').notNull(), // container name or stack name
	// When and how
	triggeredBy: text('triggered_by').notNull(), // 'cron' | 'webhook' | 'manual'
	triggeredAt: timestamp('triggered_at', { mode: 'string' }).notNull(),
	startedAt: timestamp('started_at', { mode: 'string' }),
	completedAt: timestamp('completed_at', { mode: 'string' }),
	duration: integer('duration'), // milliseconds
	// Result
	status: text('status').notNull(), // 'queued' | 'running' | 'success' | 'failed' | 'skipped'
	errorMessage: text('error_message'),
	// Details
	details: text('details'), // JSON with execution details
	logs: text('logs'), // Execution logs/output
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	typeIdIdx: index('schedule_executions_type_id_idx').on(table.scheduleType, table.scheduleId)
}));

// =============================================================================
// PENDING CONTAINER UPDATES TABLE
// =============================================================================

export const pendingContainerUpdates = pgTable('pending_container_updates', {
	id: serial('id').primaryKey(),
	environmentId: integer('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
	containerId: text('container_id').notNull(),
	containerName: text('container_name').notNull(),
	currentImage: text('current_image').notNull(),
	checkedAt: timestamp('checked_at', { mode: 'string' }).defaultNow(),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
}, (table) => ({
	envContainerUnique: unique().on(table.environmentId, table.containerId)
}));

// =============================================================================
// USER PREFERENCES TABLE (unified key-value store)
// =============================================================================

export const userPreferences = pgTable('user_preferences', {
	id: serial('id').primaryKey(),
	userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), // NULL = shared (free edition), set = per-user (enterprise)
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }), // NULL for global prefs
	key: text('key').notNull(), // e.g., 'dashboard_layout', 'logs_favorites'
	value: text('value').notNull(), // JSON value
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
}, (table) => [
	unique().on(table.userId, table.environmentId, table.key)
]);
