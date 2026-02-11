/**
 * Drizzle ORM Schema for Dockhand
 *
 * This schema supports both SQLite and PostgreSQL through Drizzle's
 * database-agnostic schema definitions.
 */

import {
	sqliteTable,
	text,
	integer,
	real,
	primaryKey,
	unique,
	index
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// =============================================================================
// CORE TABLES
// =============================================================================

export const environments = sqliteTable('environments', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	host: text('host'),
	port: integer('port').default(2375),
	protocol: text('protocol').default('http'),
	tlsCa: text('tls_ca'),
	tlsCert: text('tls_cert'),
	tlsKey: text('tls_key'),
	tlsSkipVerify: integer('tls_skip_verify', { mode: 'boolean' }).default(false),
	icon: text('icon').default('globe'),
	collectActivity: integer('collect_activity', { mode: 'boolean' }).default(true),
	collectMetrics: integer('collect_metrics', { mode: 'boolean' }).default(true),
	highlightChanges: integer('highlight_changes', { mode: 'boolean' }).default(true),
	labels: text('labels'), // JSON array of label strings for categorization
	// Connection settings
	connectionType: text('connection_type').default('socket'), // 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge'
	socketPath: text('socket_path').default('/var/run/docker.sock'), // Unix socket path for 'socket' connection type
	hawserToken: text('hawser_token'), // Plain-text token for hawser-standard auth
	hawserLastSeen: text('hawser_last_seen'),
	hawserAgentId: text('hawser_agent_id'),
	hawserAgentName: text('hawser_agent_name'),
	hawserVersion: text('hawser_version'),
	hawserCapabilities: text('hawser_capabilities'), // JSON array: ["compose", "exec", "metrics"]
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const hawserTokens = sqliteTable('hawser_tokens', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	token: text('token').notNull().unique(), // Hashed token
	tokenPrefix: text('token_prefix').notNull(), // First 8 chars for identification
	name: text('name').notNull(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	isActive: integer('is_active', { mode: 'boolean' }).default(true),
	lastUsed: text('last_used'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	expiresAt: text('expires_at')
});

export const registries = sqliteTable('registries', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	url: text('url').notNull(),
	username: text('username'),
	password: text('password'),
	isDefault: integer('is_default', { mode: 'boolean' }).default(false),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

// =============================================================================
// EVENT TRACKING TABLES
// =============================================================================

export const stackEvents = sqliteTable('stack_events', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	stackName: text('stack_name').notNull(),
	eventType: text('event_type').notNull(),
	timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`),
	metadata: text('metadata')
});

export const hostMetrics = sqliteTable('host_metrics', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	cpuPercent: real('cpu_percent').notNull(),
	memoryPercent: real('memory_percent').notNull(),
	memoryUsed: integer('memory_used'),
	memoryTotal: integer('memory_total'),
	timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	envTimestampIdx: index('host_metrics_env_timestamp_idx').on(table.environmentId, table.timestamp)
}));

// =============================================================================
// CONFIGURATION TABLES
// =============================================================================

export const configSets = sqliteTable('config_sets', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	description: text('description'),
	envVars: text('env_vars'),
	labels: text('labels'),
	ports: text('ports'),
	volumes: text('volumes'),
	networkMode: text('network_mode').default('bridge'),
	restartPolicy: text('restart_policy').default('no'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const autoUpdateSettings = sqliteTable('auto_update_settings', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	environmentId: integer('environment_id').references(() => environments.id),
	containerName: text('container_name').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).default(false),
	scheduleType: text('schedule_type').default('daily'),
	cronExpression: text('cron_expression'),
	vulnerabilityCriteria: text('vulnerability_criteria').default('never'), // 'never' | 'any' | 'critical_high' | 'critical' | 'more_than_current'
	lastChecked: text('last_checked'),
	lastUpdated: text('last_updated'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	envContainerUnique: unique().on(table.environmentId, table.containerName)
}));

export const notificationSettings = sqliteTable('notification_settings', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	type: text('type').notNull(),
	name: text('name').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).default(true),
	config: text('config').notNull(),
	eventTypes: text('event_types'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const environmentNotifications = sqliteTable('environment_notifications', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	environmentId: integer('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
	notificationId: integer('notification_id').notNull().references(() => notificationSettings.id, { onDelete: 'cascade' }),
	enabled: integer('enabled', { mode: 'boolean' }).default(true),
	eventTypes: text('event_types'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	envNotifUnique: unique().on(table.environmentId, table.notificationId)
}));

// =============================================================================
// AUTHENTICATION TABLES
// =============================================================================

export const authSettings = sqliteTable('auth_settings', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	authEnabled: integer('auth_enabled', { mode: 'boolean' }).default(false),
	defaultProvider: text('default_provider').default('local'),
	sessionTimeout: integer('session_timeout').default(86400),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	username: text('username').notNull().unique(),
	email: text('email'),
	passwordHash: text('password_hash').notNull(),
	displayName: text('display_name'),
	avatar: text('avatar'),
	authProvider: text('auth_provider').default('local'), // e.g., 'local', 'oidc:Keycloak', 'ldap:AD'
	mfaEnabled: integer('mfa_enabled', { mode: 'boolean' }).default(false),
	mfaSecret: text('mfa_secret'), // JSON: { secret: string, backupCodes: string[] }
	isActive: integer('is_active', { mode: 'boolean' }).default(true),
	lastLogin: text('last_login'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	provider: text('provider').notNull(),
	expiresAt: text('expires_at').notNull(),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	userIdIdx: index('sessions_user_id_idx').on(table.userId),
	expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt)
}));

export const ldapConfig = sqliteTable('ldap_config', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).default(false),
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
	tlsEnabled: integer('tls_enabled', { mode: 'boolean' }).default(false),
	tlsCa: text('tls_ca'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const oidcConfig = sqliteTable('oidc_config', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).default(false),
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
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

// =============================================================================
// ROLE-BASED ACCESS CONTROL TABLES
// =============================================================================

export const roles = sqliteTable('roles', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	description: text('description'),
	isSystem: integer('is_system', { mode: 'boolean' }).default(false),
	permissions: text('permissions').notNull(),
	environmentIds: text('environment_ids'), // JSON array of env IDs, null = all environments
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const userRoles = sqliteTable('user_roles', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	roleId: integer('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	userRoleEnvUnique: unique().on(table.userId, table.roleId, table.environmentId)
}));

// =============================================================================
// GIT INTEGRATION TABLES
// =============================================================================

export const gitCredentials = sqliteTable('git_credentials', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	authType: text('auth_type').notNull().default('none'),
	username: text('username'),
	password: text('password'),
	sshPrivateKey: text('ssh_private_key'),
	sshPassphrase: text('ssh_passphrase'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const gitRepositories = sqliteTable('git_repositories', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	url: text('url').notNull(),
	branch: text('branch').default('main'),
	credentialId: integer('credential_id').references(() => gitCredentials.id, { onDelete: 'set null' }),
	composePath: text('compose_path').default('compose.yaml'),
	environmentId: integer('environment_id'),
	autoUpdate: integer('auto_update', { mode: 'boolean' }).default(false),
	autoUpdateSchedule: text('auto_update_schedule').default('daily'),
	autoUpdateCron: text('auto_update_cron').default('0 3 * * *'),
	webhookEnabled: integer('webhook_enabled', { mode: 'boolean' }).default(false),
	webhookSecret: text('webhook_secret'),
	lastSync: text('last_sync'),
	lastCommit: text('last_commit'),
	syncStatus: text('sync_status').default('pending'),
	syncError: text('sync_error'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const gitStacks = sqliteTable('git_stacks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	stackName: text('stack_name').notNull(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	repositoryId: integer('repository_id').notNull().references(() => gitRepositories.id, { onDelete: 'cascade' }),
	composePath: text('compose_path').default('compose.yaml'),
	envFilePath: text('env_file_path'), // Path to .env file in repository (e.g., ".env", "config/.env.prod")
	autoUpdate: integer('auto_update', { mode: 'boolean' }).default(false),
	autoUpdateSchedule: text('auto_update_schedule').default('daily'),
	autoUpdateCron: text('auto_update_cron').default('0 3 * * *'),
	webhookEnabled: integer('webhook_enabled', { mode: 'boolean' }).default(false),
	webhookSecret: text('webhook_secret'),
	lastSync: text('last_sync'),
	lastCommit: text('last_commit'),
	syncStatus: text('sync_status').default('pending'),
	syncError: text('sync_error'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	stackEnvUnique: unique().on(table.stackName, table.environmentId)
}));

export const stackSources = sqliteTable('stack_sources', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	stackName: text('stack_name').notNull(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	sourceType: text('source_type').notNull().default('internal'),
	gitRepositoryId: integer('git_repository_id').references(() => gitRepositories.id, { onDelete: 'set null' }),
	gitStackId: integer('git_stack_id').references(() => gitStacks.id, { onDelete: 'set null' }),
	composePath: text('compose_path'), // Custom path to compose file (for stacks with non-default location)
	envPath: text('env_path'), // Custom path to .env file (for stacks with non-default location)
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	stackSourceEnvUnique: unique().on(table.stackName, table.environmentId)
}));

export const stackEnvironmentVariables = sqliteTable('stack_environment_variables', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	stackName: text('stack_name').notNull(),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	key: text('key').notNull(),
	value: text('value').notNull(),
	isSecret: integer('is_secret', { mode: 'boolean' }).default(false),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	stackEnvVarUnique: unique().on(table.stackName, table.environmentId, table.key)
}));

// =============================================================================
// SECURITY TABLES
// =============================================================================

export const vulnerabilityScans = sqliteTable('vulnerability_scans', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	imageId: text('image_id').notNull(),
	imageName: text('image_name').notNull(),
	scanner: text('scanner').notNull(),
	scannedAt: text('scanned_at').notNull(),
	scanDuration: integer('scan_duration'),
	criticalCount: integer('critical_count').default(0),
	highCount: integer('high_count').default(0),
	mediumCount: integer('medium_count').default(0),
	lowCount: integer('low_count').default(0),
	negligibleCount: integer('negligible_count').default(0),
	unknownCount: integer('unknown_count').default(0),
	vulnerabilities: text('vulnerabilities'),
	error: text('error'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	envImageIdx: index('vulnerability_scans_env_image_idx').on(table.environmentId, table.imageId)
}));

// =============================================================================
// AUDIT LOGGING TABLES
// =============================================================================

export const auditLogs = sqliteTable('audit_logs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
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
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	userIdIdx: index('audit_logs_user_id_idx').on(table.userId),
	createdAtIdx: index('audit_logs_created_at_idx').on(table.createdAt)
}));

// =============================================================================
// CONTAINER ACTIVITY TABLES
// =============================================================================

export const containerEvents = sqliteTable('container_events', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	containerId: text('container_id').notNull(),
	containerName: text('container_name'),
	image: text('image'),
	action: text('action').notNull(),
	actorAttributes: text('actor_attributes'),
	timestamp: text('timestamp').notNull(),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	envTimestampIdx: index('container_events_env_timestamp_idx').on(table.environmentId, table.timestamp)
}));

// =============================================================================
// SCHEDULE EXECUTION TABLES
// =============================================================================

export const scheduleExecutions = sqliteTable('schedule_executions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	// Link to the scheduled job
	scheduleType: text('schedule_type').notNull(), // 'container_update' | 'git_stack_sync' | 'system_cleanup'
	scheduleId: integer('schedule_id').notNull(), // ID in autoUpdateSettings or gitStacks, or 0 for system jobs
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
	// What ran
	entityName: text('entity_name').notNull(), // container name or stack name
	// When and how
	triggeredBy: text('triggered_by').notNull(), // 'cron' | 'webhook' | 'manual'
	triggeredAt: text('triggered_at').notNull(),
	startedAt: text('started_at'),
	completedAt: text('completed_at'),
	duration: integer('duration'), // milliseconds
	// Result
	status: text('status').notNull(), // 'queued' | 'running' | 'success' | 'failed' | 'skipped'
	errorMessage: text('error_message'),
	// Details
	details: text('details'), // JSON with execution details
	logs: text('logs'), // Execution logs/output
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	typeIdIdx: index('schedule_executions_type_id_idx').on(table.scheduleType, table.scheduleId)
}));

// =============================================================================
// PENDING CONTAINER UPDATES TABLE
// =============================================================================

export const pendingContainerUpdates = sqliteTable('pending_container_updates', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	environmentId: integer('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
	containerId: text('container_id').notNull(),
	containerName: text('container_name').notNull(),
	currentImage: text('current_image').notNull(),
	checkedAt: text('checked_at').default(sql`CURRENT_TIMESTAMP`),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
	envContainerUnique: unique().on(table.environmentId, table.containerId)
}));

// =============================================================================
// USER PREFERENCES TABLE (unified key-value store)
// =============================================================================

export const userPreferences = sqliteTable('user_preferences', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), // NULL = shared (free edition), set = per-user (enterprise)
	environmentId: integer('environment_id').references(() => environments.id, { onDelete: 'cascade' }), // NULL for global prefs
	key: text('key').notNull(), // e.g., 'dashboard_layout', 'logs_favorites'
	value: text('value').notNull(), // JSON value
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => [
	unique().on(table.userId, table.environmentId, table.key)
]);

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type Environment = typeof environments.$inferSelect;
export type NewEnvironment = typeof environments.$inferInsert;

export type Registry = typeof registries.$inferSelect;
export type NewRegistry = typeof registries.$inferInsert;

export type HawserToken = typeof hawserTokens.$inferSelect;
export type NewHawserToken = typeof hawserTokens.$inferInsert;

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;

export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;

export type OidcConfig = typeof oidcConfig.$inferSelect;
export type NewOidcConfig = typeof oidcConfig.$inferInsert;

export type LdapConfig = typeof ldapConfig.$inferSelect;
export type NewLdapConfig = typeof ldapConfig.$inferInsert;

export type AuthSetting = typeof authSettings.$inferSelect;
export type NewAuthSetting = typeof authSettings.$inferInsert;

export type ConfigSet = typeof configSets.$inferSelect;
export type NewConfigSet = typeof configSets.$inferInsert;

export type NotificationSetting = typeof notificationSettings.$inferSelect;
export type NewNotificationSetting = typeof notificationSettings.$inferInsert;

export type EnvironmentNotification = typeof environmentNotifications.$inferSelect;
export type NewEnvironmentNotification = typeof environmentNotifications.$inferInsert;

export type GitCredential = typeof gitCredentials.$inferSelect;
export type NewGitCredential = typeof gitCredentials.$inferInsert;

export type GitRepository = typeof gitRepositories.$inferSelect;
export type NewGitRepository = typeof gitRepositories.$inferInsert;

export type GitStack = typeof gitStacks.$inferSelect;
export type NewGitStack = typeof gitStacks.$inferInsert;

export type StackSource = typeof stackSources.$inferSelect;
export type NewStackSource = typeof stackSources.$inferInsert;

export type VulnerabilityScan = typeof vulnerabilityScans.$inferSelect;
export type NewVulnerabilityScan = typeof vulnerabilityScans.$inferInsert;

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

export type ContainerEvent = typeof containerEvents.$inferSelect;
export type NewContainerEvent = typeof containerEvents.$inferInsert;

export type HostMetric = typeof hostMetrics.$inferSelect;
export type NewHostMetric = typeof hostMetrics.$inferInsert;

export type StackEvent = typeof stackEvents.$inferSelect;
export type NewStackEvent = typeof stackEvents.$inferInsert;

export type AutoUpdateSetting = typeof autoUpdateSettings.$inferSelect;
export type NewAutoUpdateSetting = typeof autoUpdateSettings.$inferInsert;

export type UserPreference = typeof userPreferences.$inferSelect;
export type NewUserPreference = typeof userPreferences.$inferInsert;

export type ScheduleExecution = typeof scheduleExecutions.$inferSelect;
export type NewScheduleExecution = typeof scheduleExecutions.$inferInsert;

export type StackEnvironmentVariable = typeof stackEnvironmentVariables.$inferSelect;
export type NewStackEnvironmentVariable = typeof stackEnvironmentVariables.$inferInsert;

export type PendingContainerUpdate = typeof pendingContainerUpdates.$inferSelect;
export type NewPendingContainerUpdate = typeof pendingContainerUpdates.$inferInsert;
