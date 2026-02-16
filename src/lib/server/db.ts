/**
 * Database Operations Module
 *
 * Provides all database operations using Drizzle ORM.
 * Supports both SQLite and PostgreSQL.
 */

import {
	db,
	rawClient,
	isPostgres,
	isSqlite,
	eq,
	and,
	or,
	desc,
	asc,
	like,
	sql,
	inArray,
	isNull,
	isNotNull,
	// Schema tables
	environments,
	registries,
	stackEvents,
	settings,
	configSets,
	hostMetrics,
	autoUpdateSettings,
	notificationSettings,
	environmentNotifications,
	authSettings,
	users,
	sessions,
	roles,
	userRoles,
	ldapConfig,
	oidcConfig,
	gitCredentials,
	gitRepositories,
	gitStacks,
	stackSources,
	vulnerabilityScans,
	auditLogs,
	containerEvents,
	userPreferences,
	scheduleExecutions,
	stackEnvironmentVariables,
	pendingContainerUpdates,
	// Types
	type Environment,
	type Registry,
	type StackEvent,
	type Setting,
	type ConfigSet,
	type HostMetric,
	type AutoUpdateSetting,
	type NotificationSetting,
	type EnvironmentNotification,
	type AuthSetting,
	type User,
	type Session,
	type Role,
	type UserRole,
	type LdapConfig,
	type OidcConfig,
	type GitCredential,
	type GitRepository,
	type GitStack,
	type StackSource,
	type VulnerabilityScan,
	type AuditLog,
	type ContainerEvent,
	type ScheduleExecution,
	type StackEnvironmentVariable,
	type PendingContainerUpdate
} from './db/drizzle.js';

import type { AllGridPreferences, GridId, GridColumnPreferences } from '$lib/types';
import { encrypt, decrypt } from './encryption.js';

// Re-export for backwards compatibility
export { db, isPostgres, isSqlite };
export type {
	Environment,
	Registry,
	ConfigSet,
	HostMetric,
	AutoUpdateSetting as AutoUpdateSettingType,
	User,
	Session,
	Role,
	UserRole,
	LdapConfig,
	OidcConfig,
	GitCredential,
	GitRepository,
	GitStack,
	StackSource,
	VulnerabilityScan,
	AuditLog,
	ContainerEvent
};

// Initialize database (no-op now, kept for API compatibility)
export function initDatabase() {
	// Database is already initialized by drizzle.ts
}

// =============================================================================
// ENVIRONMENT OPERATIONS
// =============================================================================

export async function getEnvironments(): Promise<Environment[]> {
	const results = await db.select().from(environments).orderBy(asc(environments.name));
	return results.map((e: Environment) => ({
		...e,
		tlsKey: decrypt(e.tlsKey),
		hawserToken: decrypt(e.hawserToken)
	}));
}

export async function hasEnvironments(): Promise<boolean> {
	const results = await db.select({ id: environments.id }).from(environments).limit(1);
	return results.length > 0;
}

export async function getEnvironment(id: number): Promise<Environment | undefined> {
	const results = await db.select().from(environments).where(eq(environments.id, id));
	if (!results[0]) return undefined;
	return {
		...results[0],
		tlsKey: decrypt(results[0].tlsKey),
		hawserToken: decrypt(results[0].hawserToken)
	};
}

export async function getEnvironmentByName(name: string): Promise<Environment | undefined> {
	const results = await db.select().from(environments).where(eq(environments.name, name));
	if (!results[0]) return undefined;
	return {
		...results[0],
		tlsKey: decrypt(results[0].tlsKey),
		hawserToken: decrypt(results[0].hawserToken)
	};
}

export async function createEnvironment(env: Omit<Environment, 'id' | 'createdAt' | 'updatedAt'>): Promise<Environment> {
	const result = await db.insert(environments).values({
		name: env.name,
		host: env.host || null,
		port: env.port || 2375,
		protocol: env.protocol || 'http',
		tlsCa: env.tlsCa || null,
		tlsCert: env.tlsCert || null,
		tlsKey: encrypt(env.tlsKey) || null,
		tlsSkipVerify: env.tlsSkipVerify ?? false,
		icon: env.icon || 'globe',
		socketPath: env.socketPath || '/var/run/docker.sock',
		collectActivity: env.collectActivity !== false,
		collectMetrics: env.collectMetrics !== false,
		highlightChanges: env.highlightChanges !== false,
		labels: env.labels || null,
		connectionType: env.connectionType || 'socket',
		hawserToken: encrypt(env.hawserToken) || null
	}).returning();
	return {
		...result[0],
		tlsKey: decrypt(result[0].tlsKey),
		hawserToken: decrypt(result[0].hawserToken)
	};
}

export async function updateEnvironment(id: number, env: Partial<Environment>): Promise<Environment | undefined> {
	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (env.name !== undefined) updateData.name = env.name;
	if (env.host !== undefined) updateData.host = env.host;
	if (env.port !== undefined) updateData.port = env.port;
	if (env.protocol !== undefined) updateData.protocol = env.protocol;
	if (env.tlsCa !== undefined) updateData.tlsCa = env.tlsCa;
	if (env.tlsCert !== undefined) updateData.tlsCert = env.tlsCert;
	if (env.tlsKey !== undefined) updateData.tlsKey = encrypt(env.tlsKey);
	if (env.tlsSkipVerify !== undefined) updateData.tlsSkipVerify = env.tlsSkipVerify;
	if (env.icon !== undefined) updateData.icon = env.icon;
	if (env.socketPath !== undefined) updateData.socketPath = env.socketPath;
	if (env.collectActivity !== undefined) updateData.collectActivity = env.collectActivity;
	if (env.collectMetrics !== undefined) updateData.collectMetrics = env.collectMetrics;
	if (env.highlightChanges !== undefined) updateData.highlightChanges = env.highlightChanges;
	if (env.labels !== undefined) updateData.labels = env.labels;
	if (env.connectionType !== undefined) updateData.connectionType = env.connectionType;
	if (env.hawserToken !== undefined) updateData.hawserToken = encrypt(env.hawserToken);

	await db.update(environments).set(updateData).where(eq(environments.id, id));
	return getEnvironment(id);
}

export async function deleteEnvironment(id: number): Promise<boolean> {
	const env = await getEnvironment(id);
	if (!env) return false;

	// Clean up related records that don't have cascade delete defined
	try {
		await db.delete(hostMetrics).where(eq(hostMetrics.environmentId, id));
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[DB] Failed to cleanup host metrics for environment:', errorMsg);
	}

	try {
		await db.delete(stackEvents).where(eq(stackEvents.environmentId, id));
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[DB] Failed to cleanup stack events for environment:', errorMsg);
	}

	try {
		await db.delete(autoUpdateSettings).where(eq(autoUpdateSettings.environmentId, id));
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[DB] Failed to cleanup auto-update schedules for environment:', errorMsg);
	}

	await db.delete(environments).where(eq(environments.id, id));
	return true;
}

// =============================================================================
// REGISTRY OPERATIONS
// =============================================================================

export async function getRegistries(): Promise<Registry[]> {
	const results = await db.select().from(registries).orderBy(desc(registries.isDefault), asc(registries.name));
	return results.map((r: Registry) => ({ ...r, password: decrypt(r.password) }));
}

export async function getRegistry(id: number): Promise<Registry | undefined> {
	const results = await db.select().from(registries).where(eq(registries.id, id));
	if (!results[0]) return undefined;
	return { ...results[0], password: decrypt(results[0].password) };
}

export async function getDefaultRegistry(): Promise<Registry | undefined> {
	const results = await db.select().from(registries).where(eq(registries.isDefault, true));
	if (!results[0]) return undefined;
	return { ...results[0], password: decrypt(results[0].password) };
}

export async function createRegistry(registry: Omit<Registry, 'id' | 'createdAt' | 'updatedAt'>): Promise<Registry> {
	const result = await db.insert(registries).values({
		name: registry.name,
		url: registry.url,
		username: registry.username || null,
		password: encrypt(registry.password) || null,
		isDefault: registry.isDefault || false
	}).returning();
	return {
		...result[0],
		password: decrypt(result[0].password)
	};
}

export async function updateRegistry(id: number, registry: Partial<Registry>): Promise<Registry | undefined> {
	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (registry.name !== undefined) updateData.name = registry.name;
	if (registry.url !== undefined) updateData.url = registry.url;
	if (registry.username !== undefined) updateData.username = registry.username || null;
	if (registry.password !== undefined) updateData.password = encrypt(registry.password) || null;
	if (registry.isDefault !== undefined) updateData.isDefault = registry.isDefault;

	await db.update(registries).set(updateData).where(eq(registries.id, id));
	return getRegistry(id);
}

export async function deleteRegistry(id: number): Promise<boolean> {
	const registry = await getRegistry(id);
	if (!registry) return false;

	await db.delete(registries).where(eq(registries.id, id));
	return true;
}

export async function setDefaultRegistry(id: number): Promise<boolean> {
	await db.update(registries).set({ isDefault: false });
	await db.update(registries).set({ isDefault: true }).where(eq(registries.id, id));
	return true;
}

// =============================================================================
// STACK EVENT LOGGING
// =============================================================================

export async function logStackEvent(stackName: string, eventType: string, metadata?: any, environmentId?: number) {
	await db.insert(stackEvents).values({
		environmentId: environmentId || null,
		stackName,
		eventType,
		metadata: metadata ? JSON.stringify(metadata) : null
	});
}

export async function getStackEvents(limit = 50, environmentId?: number): Promise<StackEvent[]> {
	if (environmentId) {
		return db.select().from(stackEvents)
			.where(eq(stackEvents.environmentId, environmentId))
			.orderBy(desc(stackEvents.timestamp))
			.limit(limit);
	}
	return db.select().from(stackEvents)
		.orderBy(desc(stackEvents.timestamp))
		.limit(limit);
}

// =============================================================================
// SETTINGS MANAGEMENT
// =============================================================================

export async function getSetting(key: string): Promise<any> {
	const results = await db.select().from(settings).where(eq(settings.key, key));
	if (!results[0]) return null;
	try {
		return JSON.parse(results[0].value);
	} catch {
		return results[0].value;
	}
}

export async function setSetting(key: string, value: any): Promise<void> {
	const jsonValue = JSON.stringify(value);
	await db.insert(settings).values({
		key,
		value: jsonValue
	}).onConflictDoUpdate({
		target: settings.key,
		set: { value: jsonValue, updatedAt: new Date().toISOString() }
	});
}

export async function deleteSetting(key: string): Promise<void> {
	await db.delete(settings).where(eq(settings.key, key));
}

export async function getEnvSetting(key: string, envId?: number): Promise<any> {
	if (envId !== undefined) {
		const envKey = `env_${envId}_${key}`;
		const results = await db.select().from(settings).where(eq(settings.key, envKey));
		if (results[0]) {
			try {
				return JSON.parse(results[0].value);
			} catch {
				return results[0].value;
			}
		}
	}
	return getSetting(key);
}

export async function setEnvSetting(key: string, value: any, envId?: number): Promise<void> {
	const actualKey = envId !== undefined ? `env_${envId}_${key}` : key;
	await setSetting(actualKey, value);
}

// =============================================================================
// USER SETTINGS (for per-user preferences like themes)
// =============================================================================

export async function getUserSetting(userId: number, key: string): Promise<any> {
	const userKey = `user:${userId}:${key}`;
	return getSetting(userKey);
}

export async function setUserSetting(userId: number, key: string, value: any): Promise<void> {
	const userKey = `user:${userId}:${key}`;
	await setSetting(userKey, value);
}

export async function getUserThemePreferences(userId: number): Promise<{
	lightTheme: string;
	darkTheme: string;
	font: string;
	fontSize: string;
	gridFontSize: string;
	terminalFont: string;
	editorFont: string;
}> {
	const [lightTheme, darkTheme, font, fontSize, gridFontSize, terminalFont, editorFont] = await Promise.all([
		getUserSetting(userId, 'light_theme'),
		getUserSetting(userId, 'dark_theme'),
		getUserSetting(userId, 'font'),
		getUserSetting(userId, 'font_size'),
		getUserSetting(userId, 'grid_font_size'),
		getUserSetting(userId, 'terminal_font'),
		getUserSetting(userId, 'editor_font')
	]);
	return {
		lightTheme: lightTheme || 'default',
		darkTheme: darkTheme || 'default',
		font: font || 'system',
		fontSize: fontSize || 'normal',
		gridFontSize: gridFontSize || 'normal',
		terminalFont: terminalFont || 'system-mono',
		editorFont: editorFont || 'system-mono'
	};
}

export async function setUserThemePreferences(
	userId: number,
	prefs: { lightTheme?: string; darkTheme?: string; font?: string; fontSize?: string; gridFontSize?: string; terminalFont?: string; editorFont?: string }
): Promise<void> {
	const updates: Promise<void>[] = [];
	if (prefs.lightTheme !== undefined) {
		updates.push(setUserSetting(userId, 'light_theme', prefs.lightTheme));
	}
	if (prefs.darkTheme !== undefined) {
		updates.push(setUserSetting(userId, 'dark_theme', prefs.darkTheme));
	}
	if (prefs.font !== undefined) {
		updates.push(setUserSetting(userId, 'font', prefs.font));
	}
	if (prefs.fontSize !== undefined) {
		updates.push(setUserSetting(userId, 'font_size', prefs.fontSize));
	}
	if (prefs.gridFontSize !== undefined) {
		updates.push(setUserSetting(userId, 'grid_font_size', prefs.gridFontSize));
	}
	if (prefs.terminalFont !== undefined) {
		updates.push(setUserSetting(userId, 'terminal_font', prefs.terminalFont));
	}
	if (prefs.editorFont !== undefined) {
		updates.push(setUserSetting(userId, 'editor_font', prefs.editorFont));
	}
	await Promise.all(updates);
}

// =============================================================================
// GRID COLUMN PREFERENCES
// =============================================================================

export async function getGridPreferences(userId?: number): Promise<AllGridPreferences> {
	const key = userId ? `user:${userId}:grid_preferences` : 'grid_preferences';
	const value = await getSetting(key);
	return value || {};
}

export async function setGridPreferences(
	gridId: GridId,
	prefs: GridColumnPreferences,
	userId?: number
): Promise<void> {
	const key = userId ? `user:${userId}:grid_preferences` : 'grid_preferences';
	const current = await getGridPreferences(userId);
	current[gridId] = prefs;
	await setSetting(key, current);
}

export async function deleteGridPreferences(gridId: GridId, userId?: number): Promise<void> {
	const key = userId ? `user:${userId}:grid_preferences` : 'grid_preferences';
	const current = await getGridPreferences(userId);
	delete current[gridId];
	await setSetting(key, current);
}

export async function resetAllGridPreferences(userId?: number): Promise<void> {
	const key = userId ? `user:${userId}:grid_preferences` : 'grid_preferences';
	await deleteSetting(key);
}

// =============================================================================
// ENVIRONMENT PUBLIC IPS (for port links)
// =============================================================================

export async function getEnvironmentPublicIps(): Promise<Record<string, string>> {
	const value = await getSetting('environment_public_ips');
	return value || {};
}

export async function setEnvironmentPublicIp(envId: number, publicIp: string | null): Promise<void> {
	const current = await getEnvironmentPublicIps();
	if (publicIp) {
		current[envId.toString()] = publicIp;
	} else {
		delete current[envId.toString()];
	}
	await setSetting('environment_public_ips', current);
}

export async function deleteEnvironmentPublicIp(envId: number): Promise<void> {
	await setEnvironmentPublicIp(envId, null);
}

// =============================================================================
// CONFIG SET OPERATIONS
// =============================================================================

export interface ConfigSetData {
	id: number;
	name: string;
	description?: string | null;
	envVars?: { key: string; value: string }[];
	labels?: { key: string; value: string }[];
	ports?: { hostPort: string; containerPort: string; protocol: string }[];
	volumes?: { hostPath: string; containerPath: string; mode: string }[];
	networkMode: string;
	restartPolicy: string;
	createdAt: string;
	updatedAt: string;
}

export async function getConfigSets(): Promise<ConfigSetData[]> {
	const rows = await db.select().from(configSets).orderBy(asc(configSets.name));
	return rows.map((row: typeof configSets.$inferSelect) => ({
		...row,
		envVars: row.envVars ? JSON.parse(row.envVars) : [],
		labels: row.labels ? JSON.parse(row.labels) : [],
		ports: row.ports ? JSON.parse(row.ports) : [],
		volumes: row.volumes ? JSON.parse(row.volumes) : []
	}));
}

export async function getConfigSet(id: number): Promise<ConfigSetData | undefined> {
	const results = await db.select().from(configSets).where(eq(configSets.id, id));
	if (!results[0]) return undefined;
	const row = results[0];
	return {
		...row,
		envVars: row.envVars ? JSON.parse(row.envVars) : [],
		labels: row.labels ? JSON.parse(row.labels) : [],
		ports: row.ports ? JSON.parse(row.ports) : [],
		volumes: row.volumes ? JSON.parse(row.volumes) : []
	};
}

export async function createConfigSet(configSet: Omit<ConfigSetData, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConfigSetData> {
	const result = await db.insert(configSets).values({
		name: configSet.name,
		description: configSet.description || null,
		envVars: configSet.envVars ? JSON.stringify(configSet.envVars) : null,
		labels: configSet.labels ? JSON.stringify(configSet.labels) : null,
		ports: configSet.ports ? JSON.stringify(configSet.ports) : null,
		volumes: configSet.volumes ? JSON.stringify(configSet.volumes) : null,
		networkMode: configSet.networkMode || 'bridge',
		restartPolicy: configSet.restartPolicy || 'no'
	}).returning();
	return getConfigSet(result[0].id) as Promise<ConfigSetData>;
}

export async function updateConfigSet(id: number, configSet: Partial<ConfigSetData>): Promise<ConfigSetData | undefined> {
	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (configSet.name !== undefined) updateData.name = configSet.name;
	if (configSet.description !== undefined) updateData.description = configSet.description || null;
	if (configSet.envVars !== undefined) updateData.envVars = JSON.stringify(configSet.envVars);
	if (configSet.labels !== undefined) updateData.labels = JSON.stringify(configSet.labels);
	if (configSet.ports !== undefined) updateData.ports = JSON.stringify(configSet.ports);
	if (configSet.volumes !== undefined) updateData.volumes = JSON.stringify(configSet.volumes);
	if (configSet.networkMode !== undefined) updateData.networkMode = configSet.networkMode;
	if (configSet.restartPolicy !== undefined) updateData.restartPolicy = configSet.restartPolicy;

	await db.update(configSets).set(updateData).where(eq(configSets.id, id));
	return getConfigSet(id);
}

export async function deleteConfigSet(id: number): Promise<boolean> {
	await db.delete(configSets).where(eq(configSets.id, id));
	return true;
}

// =============================================================================
// HOST METRICS OPERATIONS
// =============================================================================

export async function saveHostMetric(
	cpuPercent: number,
	memoryPercent: number,
	memoryUsed: number,
	memoryTotal: number,
	environmentId?: number
): Promise<void> {
	// Verify environment exists before inserting (avoids FK violations on deleted envs)
	if (environmentId) {
		const env = await getEnvironment(environmentId);
		if (!env) return;
	}

	await db.insert(hostMetrics).values({
		environmentId: environmentId || null,
		cpuPercent,
		memoryPercent,
		memoryUsed,
		memoryTotal
	});

	// Cleanup old metrics (keep last 24 hours)
	const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	await db.delete(hostMetrics).where(sql`timestamp < ${cutoff24h}`);
}

export async function getHostMetrics(limit = 60, environmentId?: number): Promise<HostMetric[]> {
	if (environmentId) {
		return db.select().from(hostMetrics)
			.where(eq(hostMetrics.environmentId, environmentId))
			.orderBy(desc(hostMetrics.timestamp))
			.limit(limit);
	}
	return db.select().from(hostMetrics)
		.orderBy(desc(hostMetrics.timestamp))
		.limit(limit);
}

export async function getLatestHostMetrics(environmentId: number): Promise<HostMetric | null> {
	const results = await db.select().from(hostMetrics)
		.where(eq(hostMetrics.environmentId, environmentId))
		.orderBy(desc(hostMetrics.timestamp))
		.limit(1);
	return results[0] ?? null;
}

// =============================================================================
// AUTO-UPDATE SETTINGS
// =============================================================================

export type VulnerabilityCriteria = 'never' | 'any' | 'critical_high' | 'critical' | 'more_than_current';

export interface AutoUpdateSettingData {
	id: number;
	environmentId: number | null;
	containerName: string;
	enabled: boolean;
	scheduleType: 'daily' | 'weekly' | 'custom';
	cronExpression: string | null;
	vulnerabilityCriteria: VulnerabilityCriteria | null;
	lastChecked: string | null;
	lastUpdated: string | null;
	createdAt: string;
	updatedAt: string;
}

export async function getAutoUpdateSettings(environmentId?: number): Promise<AutoUpdateSettingData[]> {
	if (environmentId) {
		return db.select().from(autoUpdateSettings)
			.where(eq(autoUpdateSettings.environmentId, environmentId)) as Promise<AutoUpdateSettingData[]>;
	}
	return db.select().from(autoUpdateSettings) as Promise<AutoUpdateSettingData[]>;
}

export async function getAutoUpdateSetting(containerName: string, environmentId?: number): Promise<AutoUpdateSettingData | undefined> {
	const results = await db.select().from(autoUpdateSettings)
		.where(and(
			eq(autoUpdateSettings.containerName, containerName),
			environmentId ? eq(autoUpdateSettings.environmentId, environmentId) : isNull(autoUpdateSettings.environmentId)
		));
	return results[0] as AutoUpdateSettingData | undefined;
}

export async function getAutoUpdateSettingById(id: number): Promise<AutoUpdateSettingData | undefined> {
	const results = await db.select().from(autoUpdateSettings)
		.where(eq(autoUpdateSettings.id, id));
	return results[0] as AutoUpdateSettingData | undefined;
}

export async function updateAutoUpdateSettingById(id: number, data: Partial<AutoUpdateSettingData>): Promise<void> {
	await db.update(autoUpdateSettings)
		.set({
			...data,
			updatedAt: new Date().toISOString()
		})
		.where(eq(autoUpdateSettings.id, id));
}

export async function getEnabledAutoUpdateSettings(): Promise<AutoUpdateSettingData[]> {
	return db.select().from(autoUpdateSettings)
		.where(eq(autoUpdateSettings.enabled, true)) as Promise<AutoUpdateSettingData[]>;
}

export async function getAllAutoUpdateSettings(): Promise<AutoUpdateSettingData[]> {
	return db.select().from(autoUpdateSettings)
		.orderBy(desc(autoUpdateSettings.containerName)) as Promise<AutoUpdateSettingData[]>;
}

export async function upsertAutoUpdateSetting(
	containerName: string,
	settingsData: {
		enabled: boolean;
		scheduleType: 'daily' | 'weekly' | 'custom';
		cronExpression?: string | null;
		vulnerabilityCriteria?: VulnerabilityCriteria | null;
	},
	environmentId?: number
): Promise<AutoUpdateSettingData> {
	const existing = await getAutoUpdateSetting(containerName, environmentId);

	if (existing) {
		await db.update(autoUpdateSettings)
			.set({
				enabled: settingsData.enabled,
				scheduleType: settingsData.scheduleType,
				cronExpression: settingsData.cronExpression || null,
				vulnerabilityCriteria: settingsData.vulnerabilityCriteria || 'never',
				updatedAt: new Date().toISOString()
			})
			.where(eq(autoUpdateSettings.id, existing.id));
		return getAutoUpdateSetting(containerName, environmentId) as Promise<AutoUpdateSettingData>;
	} else {
		await db.insert(autoUpdateSettings).values({
			environmentId: environmentId || null,
			containerName,
			enabled: settingsData.enabled,
			scheduleType: settingsData.scheduleType,
			cronExpression: settingsData.cronExpression || null,
			vulnerabilityCriteria: settingsData.vulnerabilityCriteria || 'never'
		});
		return getAutoUpdateSetting(containerName, environmentId) as Promise<AutoUpdateSettingData>;
	}
}

export async function updateAutoUpdateLastChecked(containerName: string, environmentId?: number): Promise<void> {
	await db.update(autoUpdateSettings)
		.set({
			lastChecked: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		})
		.where(and(
			eq(autoUpdateSettings.containerName, containerName),
			environmentId ? eq(autoUpdateSettings.environmentId, environmentId) : isNull(autoUpdateSettings.environmentId)
		));
}

export async function updateAutoUpdateLastUpdated(containerName: string, environmentId?: number): Promise<void> {
	await db.update(autoUpdateSettings)
		.set({
			lastUpdated: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		})
		.where(and(
			eq(autoUpdateSettings.containerName, containerName),
			environmentId ? eq(autoUpdateSettings.environmentId, environmentId) : isNull(autoUpdateSettings.environmentId)
		));
}

export async function deleteAutoUpdateSetting(containerName: string, environmentId?: number): Promise<boolean> {
	await db.delete(autoUpdateSettings)
		.where(and(
			eq(autoUpdateSettings.containerName, containerName),
			environmentId ? eq(autoUpdateSettings.environmentId, environmentId) : isNull(autoUpdateSettings.environmentId)
		));
	return true;
}

// Alias for consistency with plan
export const deleteAutoUpdateSchedule = deleteAutoUpdateSetting;

export async function renameAutoUpdateSchedule(
	oldName: string,
	newName: string,
	environmentId?: number
): Promise<boolean> {
	await db.update(autoUpdateSettings)
		.set({ containerName: newName })
		.where(and(
			eq(autoUpdateSettings.containerName, oldName),
			environmentId
				? eq(autoUpdateSettings.environmentId, environmentId)
				: isNull(autoUpdateSettings.environmentId)
		));
	return true;
}

// =============================================================================
// NOTIFICATION SETTINGS
// =============================================================================

// Event scope: 'environment' = configurable per-environment, 'system' = global only (configured at channel level)
export const NOTIFICATION_EVENT_TYPES = [
	// Container lifecycle events (environment-scoped)
	{ id: 'container_started', label: 'Container started', description: 'When a container starts running', group: 'container', scope: 'environment' },
	{ id: 'container_stopped', label: 'Container stopped', description: 'When a container is stopped', group: 'container', scope: 'environment' },
	{ id: 'container_restarted', label: 'Container restarted', description: 'When a container restarts (manual or automatic)', group: 'container', scope: 'environment' },
	{ id: 'container_exited', label: 'Container exited', description: 'When a container exits unexpectedly', group: 'container', scope: 'environment' },
	{ id: 'container_unhealthy', label: 'Container unhealthy', description: 'When a container health check fails', group: 'container', scope: 'environment' },
	{ id: 'container_healthy', label: 'Container healthy', description: 'When a container health check recovers', group: 'container', scope: 'environment' },
	{ id: 'container_oom', label: 'Out of memory', description: 'When a container is killed due to out of memory', group: 'container', scope: 'environment' },
	{ id: 'container_updated', label: 'Container updated', description: 'When a container image is updated', group: 'container', scope: 'environment' },
	{ id: 'image_pulled', label: 'Image pulled', description: 'When a new image is pulled', group: 'container', scope: 'environment' },

	// Auto-update events (environment-scoped)
	{ id: 'auto_update_success', label: 'Auto-update success', description: 'Container successfully updated to new image', group: 'auto_update', scope: 'environment' },
	{ id: 'auto_update_failed', label: 'Auto-update failed', description: 'Container auto-update failed (pull error, start error)', group: 'auto_update', scope: 'environment' },
	{ id: 'auto_update_blocked', label: 'Auto-update blocked', description: 'Update blocked due to vulnerability criteria', group: 'auto_update', scope: 'environment' },
	{ id: 'updates_detected', label: 'Updates detected', description: 'Container image updates are available (scheduled check)', group: 'auto_update', scope: 'environment' },
	{ id: 'batch_update_success', label: 'Batch update completed', description: 'Scheduled container updates completed successfully', group: 'auto_update', scope: 'environment' },

	// Git stack events (environment-scoped)
	{ id: 'git_sync_success', label: 'Git sync success', description: 'Git stack synced and deployed successfully', group: 'git_stack', scope: 'environment' },
	{ id: 'git_sync_failed', label: 'Git sync failed', description: 'Git stack sync or deploy failed', group: 'git_stack', scope: 'environment' },
	{ id: 'git_sync_skipped', label: 'Git sync skipped', description: 'Git stack sync skipped (no changes)', group: 'git_stack', scope: 'environment' },

	// Stack events (environment-scoped)
	{ id: 'stack_started', label: 'Stack started', description: 'When a compose stack starts', group: 'stack', scope: 'environment' },
	{ id: 'stack_stopped', label: 'Stack stopped', description: 'When a compose stack stops', group: 'stack', scope: 'environment' },
	{ id: 'stack_deployed', label: 'Stack deployed', description: 'Stack deployed (new or update)', group: 'stack', scope: 'environment' },
	{ id: 'stack_deploy_failed', label: 'Stack deploy failed', description: 'Stack deployment failed', group: 'stack', scope: 'environment' },

	// Security events (environment-scoped)
	{ id: 'vulnerability_critical', label: 'Critical vulnerabilities', description: 'Critical vulnerabilities found in image scan', group: 'security', scope: 'environment' },
	{ id: 'vulnerability_high', label: 'High vulnerabilities', description: 'High severity vulnerabilities found in image scan', group: 'security', scope: 'environment' },
	{ id: 'vulnerability_any', label: 'Any vulnerabilities', description: 'Any vulnerabilities found in image scan (medium/low)', group: 'security', scope: 'environment' },

	// System events (global - configured at channel level, not per-environment)
	{ id: 'environment_offline', label: 'Environment offline', description: 'Environment became unreachable', group: 'system', scope: 'environment' },
	{ id: 'environment_online', label: 'Environment online', description: 'Environment came back online', group: 'system', scope: 'environment' },
	{ id: 'disk_space_warning', label: 'Disk space warning', description: 'Docker disk usage exceeds threshold', group: 'system', scope: 'environment' },
	{ id: 'image_prune_success', label: 'Image prune success', description: 'Scheduled image prune completed successfully', group: 'system', scope: 'environment' },
	{ id: 'image_prune_failed', label: 'Image prune failed', description: 'Scheduled image prune failed', group: 'system', scope: 'environment' },
	{ id: 'license_expiring', label: 'License expiring', description: 'Enterprise license expiring soon (global)', group: 'system', scope: 'system' }
] as const;

export const NOTIFICATION_EVENT_GROUPS = [
	{ id: 'container', label: 'Container events' },
	{ id: 'auto_update', label: 'Auto-update events' },
	{ id: 'git_stack', label: 'Git stack events' },
	{ id: 'stack', label: 'Stack events' },
	{ id: 'security', label: 'Security events' },
	{ id: 'system', label: 'System events' }
] as const;

// Helper to get system-only events (configured at channel level, not per-environment)
export const SYSTEM_NOTIFICATION_EVENTS = NOTIFICATION_EVENT_TYPES.filter(e => e.scope === 'system');

// Helper to get environment-scoped events (configured per-environment)
export const ENVIRONMENT_NOTIFICATION_EVENTS = NOTIFICATION_EVENT_TYPES.filter(e => e.scope === 'environment');

export type NotificationEventType = typeof NOTIFICATION_EVENT_TYPES[number]['id'];

export interface NotificationSettingData {
	id: number;
	type: 'smtp' | 'apprise';
	name: string;
	enabled: boolean;
	config: any;
	eventTypes: NotificationEventType[];
	createdAt: string;
	updatedAt: string;
}

export interface SmtpConfig {
	host: string;
	port: number;
	secure: boolean;
	username?: string;
	password?: string;
	from_email: string;
	from_name?: string;
	to_emails: string[];
	skipTlsVerify?: boolean; // Skip TLS certificate verification (useful for self-signed certs)
}

export interface AppriseConfig {
	urls: string[];
}

// Helper to encrypt sensitive fields in notification config
function encryptNotificationConfig(type: 'smtp' | 'apprise', config: SmtpConfig | AppriseConfig): string {
	if (type === 'smtp') {
		const smtpConfig = config as SmtpConfig;
		return JSON.stringify({
			...smtpConfig,
			password: encrypt(smtpConfig.password)
		});
	}
	return JSON.stringify(config);
}

// Helper to decrypt sensitive fields in notification config
function decryptNotificationConfig(type: string, configJson: string): any {
	const config = JSON.parse(configJson);
	if (type === 'smtp' && config.password) {
		return {
			...config,
			password: decrypt(config.password)
		};
	}
	return config;
}

export async function getNotificationSettings(): Promise<NotificationSettingData[]> {
	const rows = await db.select().from(notificationSettings).orderBy(desc(notificationSettings.createdAt));
	return rows.map((row: typeof notificationSettings.$inferSelect) => ({
		...row,
		config: decryptNotificationConfig(row.type, row.config),
		eventTypes: row.eventTypes ? JSON.parse(row.eventTypes) : NOTIFICATION_EVENT_TYPES.map(e => e.id)
	})) as NotificationSettingData[];
}

export async function getNotificationSetting(id: number): Promise<NotificationSettingData | null> {
	const results = await db.select().from(notificationSettings).where(eq(notificationSettings.id, id));
	if (!results[0]) return null;
	const row = results[0];
	return {
		...row,
		config: decryptNotificationConfig(row.type, row.config),
		eventTypes: row.eventTypes ? JSON.parse(row.eventTypes) : NOTIFICATION_EVENT_TYPES.map(e => e.id)
	} as NotificationSettingData;
}

export async function getEnabledNotificationSettings(): Promise<NotificationSettingData[]> {
	const rows = await db.select().from(notificationSettings).where(eq(notificationSettings.enabled, true));
	return rows.map((row: typeof notificationSettings.$inferSelect) => ({
		...row,
		config: decryptNotificationConfig(row.type, row.config),
		eventTypes: row.eventTypes ? JSON.parse(row.eventTypes) : NOTIFICATION_EVENT_TYPES.map(e => e.id)
	})) as NotificationSettingData[];
}

export async function createNotificationSetting(data: {
	type: 'smtp' | 'apprise';
	name: string;
	enabled?: boolean;
	config: SmtpConfig | AppriseConfig;
	eventTypes?: NotificationEventType[];
}): Promise<NotificationSettingData> {
	const eventTypes = data.eventTypes || NOTIFICATION_EVENT_TYPES.map(e => e.id);
	const result = await db.insert(notificationSettings).values({
		type: data.type,
		name: data.name,
		enabled: data.enabled !== false,
		config: encryptNotificationConfig(data.type, data.config),
		eventTypes: JSON.stringify(eventTypes)
	}).returning();
	return getNotificationSetting(result[0].id) as Promise<NotificationSettingData>;
}

export async function updateNotificationSetting(id: number, data: {
	name?: string;
	enabled?: boolean;
	config?: SmtpConfig | AppriseConfig;
	eventTypes?: NotificationEventType[];
}): Promise<NotificationSettingData | null> {
	const existing = await getNotificationSetting(id);
	if (!existing) return null;

	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (data.name !== undefined) updateData.name = data.name;
	if (data.enabled !== undefined) updateData.enabled = data.enabled;
	if (data.config !== undefined) updateData.config = encryptNotificationConfig(existing.type, data.config);
	if (data.eventTypes !== undefined) updateData.eventTypes = JSON.stringify(data.eventTypes);

	await db.update(notificationSettings).set(updateData).where(eq(notificationSettings.id, id));
	return getNotificationSetting(id);
}

export async function deleteNotificationSetting(id: number): Promise<boolean> {
	// First delete all environment notifications that reference this notification channel
	await db.delete(environmentNotifications).where(eq(environmentNotifications.notificationId, id));
	// Then delete the notification setting itself
	await db.delete(notificationSettings).where(eq(notificationSettings.id, id));
	return true;
}

// =============================================================================
// ENVIRONMENT NOTIFICATION SETTINGS
// =============================================================================

export interface EnvironmentNotificationData {
	id: number;
	environmentId: number;
	notificationId: number;
	enabled: boolean;
	eventTypes: NotificationEventType[];
	createdAt: string;
	updatedAt: string;
	channelName?: string;
	channelType?: 'smtp' | 'apprise';
	channelEnabled?: boolean;
}

export async function getEnvironmentNotifications(environmentId: number): Promise<EnvironmentNotificationData[]> {
	const rows = await db.select({
		id: environmentNotifications.id,
		environmentId: environmentNotifications.environmentId,
		notificationId: environmentNotifications.notificationId,
		enabled: environmentNotifications.enabled,
		eventTypes: environmentNotifications.eventTypes,
		createdAt: environmentNotifications.createdAt,
		updatedAt: environmentNotifications.updatedAt,
		channelName: notificationSettings.name,
		channelType: notificationSettings.type,
		channelEnabled: notificationSettings.enabled
	})
		.from(environmentNotifications)
		.innerJoin(notificationSettings, eq(environmentNotifications.notificationId, notificationSettings.id))
		.where(eq(environmentNotifications.environmentId, environmentId))
		.orderBy(asc(notificationSettings.name));

	return rows.map((row: any) => ({
		...row,
		eventTypes: row.eventTypes ? JSON.parse(row.eventTypes) : NOTIFICATION_EVENT_TYPES.map(e => e.id)
	})) as EnvironmentNotificationData[];
}

export async function getEnvironmentNotification(environmentId: number, notificationId: number): Promise<EnvironmentNotificationData | null> {
	const rows = await db.select({
		id: environmentNotifications.id,
		environmentId: environmentNotifications.environmentId,
		notificationId: environmentNotifications.notificationId,
		enabled: environmentNotifications.enabled,
		eventTypes: environmentNotifications.eventTypes,
		createdAt: environmentNotifications.createdAt,
		updatedAt: environmentNotifications.updatedAt,
		channelName: notificationSettings.name,
		channelType: notificationSettings.type,
		channelEnabled: notificationSettings.enabled
	})
		.from(environmentNotifications)
		.innerJoin(notificationSettings, eq(environmentNotifications.notificationId, notificationSettings.id))
		.where(and(
			eq(environmentNotifications.environmentId, environmentId),
			eq(environmentNotifications.notificationId, notificationId)
		));

	if (!rows[0]) return null;
	return {
		...rows[0],
		eventTypes: rows[0].eventTypes ? JSON.parse(rows[0].eventTypes) : NOTIFICATION_EVENT_TYPES.map(e => e.id)
	} as EnvironmentNotificationData;
}

export async function createEnvironmentNotification(data: {
	environmentId: number;
	notificationId: number;
	enabled?: boolean;
	eventTypes?: NotificationEventType[];
}): Promise<EnvironmentNotificationData> {
	const eventTypes = data.eventTypes || NOTIFICATION_EVENT_TYPES.map(e => e.id);
	await db.insert(environmentNotifications).values({
		environmentId: data.environmentId,
		notificationId: data.notificationId,
		enabled: data.enabled !== false,
		eventTypes: JSON.stringify(eventTypes)
	});
	return getEnvironmentNotification(data.environmentId, data.notificationId) as Promise<EnvironmentNotificationData>;
}

export async function updateEnvironmentNotification(environmentId: number, notificationId: number, data: {
	enabled?: boolean;
	eventTypes?: NotificationEventType[];
}): Promise<EnvironmentNotificationData | null> {
	const existing = await getEnvironmentNotification(environmentId, notificationId);
	if (!existing) return null;

	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (data.enabled !== undefined) updateData.enabled = data.enabled;
	if (data.eventTypes !== undefined) updateData.eventTypes = JSON.stringify(data.eventTypes);

	await db.update(environmentNotifications)
		.set(updateData)
		.where(and(
			eq(environmentNotifications.environmentId, environmentId),
			eq(environmentNotifications.notificationId, notificationId)
		));
	return getEnvironmentNotification(environmentId, notificationId);
}

export async function deleteEnvironmentNotification(environmentId: number, notificationId: number): Promise<boolean> {
	await db.delete(environmentNotifications)
		.where(and(
			eq(environmentNotifications.environmentId, environmentId),
			eq(environmentNotifications.notificationId, notificationId)
		));
	return true;
}

export async function getEnabledEnvironmentNotifications(
	environmentId: number,
	eventType?: NotificationEventType
): Promise<(EnvironmentNotificationData & { config: any })[]> {
	const rows = await db.select({
		id: environmentNotifications.id,
		environmentId: environmentNotifications.environmentId,
		notificationId: environmentNotifications.notificationId,
		enabled: environmentNotifications.enabled,
		eventTypes: environmentNotifications.eventTypes,
		createdAt: environmentNotifications.createdAt,
		updatedAt: environmentNotifications.updatedAt,
		channelName: notificationSettings.name,
		channelType: notificationSettings.type,
		channelEnabled: notificationSettings.enabled,
		config: notificationSettings.config
	})
		.from(environmentNotifications)
		.innerJoin(notificationSettings, eq(environmentNotifications.notificationId, notificationSettings.id))
		.where(and(
			eq(environmentNotifications.environmentId, environmentId),
			eq(environmentNotifications.enabled, true),
			eq(notificationSettings.enabled, true)
		));

	return rows
		.map(row => ({
			...row,
			eventTypes: row.eventTypes ? JSON.parse(row.eventTypes) : NOTIFICATION_EVENT_TYPES.map(e => e.id),
			config: decryptNotificationConfig(row.channelType ?? 'apprise', row.config)
		}))
		.filter(row => !eventType || row.eventTypes.includes(eventType)) as (EnvironmentNotificationData & { config: any })[];
}

// =============================================================================
// AUTHENTICATION TYPES AND OPERATIONS
// =============================================================================

export interface Permissions {
	containers: string[];
	images: string[];
	volumes: string[];
	networks: string[];
	stacks: string[];
	environments: string[];
	registries: string[];
	notifications: string[];
	configsets: string[];
	settings: string[];
	users: string[];
	git: string[];
	license: string[];
	audit_logs: string[];
	activity: string[];
	schedules: string[];
}

export interface AuthSettingsData {
	id: number;
	authEnabled: boolean;
	defaultProvider: 'local' | 'ldap' | 'oidc';
	sessionTimeout: number;
	createdAt: string;
	updatedAt: string;
}

export async function getAuthSettings(): Promise<AuthSettingsData> {
	const results = await db.select().from(authSettings).limit(1);
	return results[0] as AuthSettingsData;
}

export async function updateAuthSettings(data: Partial<AuthSettingsData>): Promise<AuthSettingsData> {
	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (data.authEnabled !== undefined) updateData.authEnabled = data.authEnabled;
	if (data.defaultProvider !== undefined) updateData.defaultProvider = data.defaultProvider;
	if (data.sessionTimeout !== undefined) {
		// Cap session timeout to safe maximum (30 days)
		const MAX_SESSION_TIMEOUT = 2592000; // 30 days in seconds
		updateData.sessionTimeout = Math.min(Math.max(1, data.sessionTimeout), MAX_SESSION_TIMEOUT);
	}

	// Get existing row's id (may not be 1 after db reset/migration)
	const existing = await db.select({ id: authSettings.id }).from(authSettings).limit(1);
	if (existing[0]) {
		await db.update(authSettings).set(updateData).where(eq(authSettings.id, existing[0].id));
	}
	return getAuthSettings();
}

// =============================================================================
// USER OPERATIONS
// =============================================================================

export interface UserData {
	id: number;
	username: string;
	email?: string | null;
	passwordHash: string;
	displayName?: string | null;
	avatar?: string | null;
	authProvider?: string | null;
	mfaEnabled: boolean;
	mfaSecret?: string | null;
	isActive: boolean;
	lastLogin?: string | null;
	createdAt: string;
	updatedAt: string;
}

export async function getUsers(): Promise<UserData[]> {
	return db.select().from(users).orderBy(asc(users.username)) as Promise<UserData[]>;
}

export async function getUser(id: number): Promise<UserData | null> {
	const results = await db.select().from(users).where(eq(users.id, id));
	return results[0] as UserData || null;
}

export async function hasAdminUser(): Promise<boolean> {
	// Check if any user has the Admin role assigned
	const adminRole = await db.select().from(roles).where(eq(roles.name, 'Admin')).limit(1);
	if (!adminRole[0]) return false;

	const result = await db.select({ id: userRoles.id })
		.from(userRoles)
		.where(eq(userRoles.roleId, adminRole[0].id))
		.limit(1);
	return result.length > 0;
}

export async function countAdminUsers(): Promise<number> {
	// Import license check dynamically to avoid circular dependencies
	const { isEnterprise } = await import('./license');
	const enterprise = await isEnterprise();

	if (enterprise) {
		// ENTERPRISE: Count users who have the Admin role assigned
		const adminRole = await db.select().from(roles).where(eq(roles.name, 'Admin')).limit(1);
		if (!adminRole[0]) return 0;

		const results = await db.select({ count: sql<number>`count(DISTINCT ${userRoles.userId})` })
			.from(userRoles)
			.where(eq(userRoles.roleId, adminRole[0].id));
		// PostgreSQL returns bigint for count, ensure we return a number
		return Number(results[0]?.count ?? 0);
	} else {
		// FREE: Any user is effectively an admin (no RBAC), just count all users
		const results = await db.select({ count: sql<number>`count(*)` }).from(users);
		// PostgreSQL returns bigint for count, ensure we return a number
		return Number(results[0]?.count ?? 0);
	}
}

export async function getUserByUsername(username: string): Promise<UserData | null> {
	const results = await db.select().from(users).where(eq(users.username, username));
	return results[0] as UserData || null;
}

export async function createUser(data: {
	username: string;
	email?: string;
	passwordHash: string;
	displayName?: string;
	authProvider?: string;
}): Promise<UserData> {
	const result = await db.insert(users).values({
		username: data.username,
		email: data.email || null,
		passwordHash: data.passwordHash,
		displayName: data.displayName || null,
		authProvider: data.authProvider || 'local'
	}).returning();
	return getUser(result[0].id) as Promise<UserData>;
}

export async function updateUser(id: number, data: Partial<UserData>): Promise<UserData | null> {
	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (data.username !== undefined) updateData.username = data.username;
	if (data.email !== undefined) updateData.email = data.email || null;
	if (data.passwordHash !== undefined) updateData.passwordHash = data.passwordHash;
	if (data.displayName !== undefined) updateData.displayName = data.displayName || null;
	if (data.avatar !== undefined) updateData.avatar = data.avatar || null;
	if (data.authProvider !== undefined) updateData.authProvider = data.authProvider;
	if (data.mfaEnabled !== undefined) updateData.mfaEnabled = data.mfaEnabled;
	if (data.mfaSecret !== undefined) updateData.mfaSecret = data.mfaSecret || null;
	if (data.isActive !== undefined) updateData.isActive = data.isActive;
	if (data.lastLogin !== undefined) updateData.lastLogin = data.lastLogin;

	await db.update(users).set(updateData).where(eq(users.id, id));
	return getUser(id);
}

export async function deleteUser(id: number): Promise<boolean> {
	await db.delete(users).where(eq(users.id, id));
	return true;
}

// =============================================================================
// SESSION OPERATIONS
// =============================================================================

export interface SessionData {
	id: string;
	userId: number;
	provider: string;
	expiresAt: string;
	createdAt: string;
}

export async function createSession(id: string, userId: number, provider: string, expiresAt: string): Promise<SessionData> {
	await db.insert(sessions).values({
		id,
		userId,
		provider,
		expiresAt
	});
	return getSession(id) as Promise<SessionData>;
}

export async function getSession(id: string): Promise<SessionData | null> {
	const results = await db.select().from(sessions).where(eq(sessions.id, id));
	return results[0] as SessionData || null;
}

export async function deleteSession(id: string): Promise<boolean> {
	await db.delete(sessions).where(eq(sessions.id, id));
	return true;
}

export async function deleteExpiredSessions(): Promise<number> {
	const now = new Date().toISOString();
	await db.delete(sessions).where(sql`expires_at < ${now}`);
	return 0; // Drizzle doesn't return changes count easily
}

export async function deleteUserSessions(userId: number): Promise<number> {
	await db.delete(sessions).where(eq(sessions.userId, userId));
	return 0;
}

// =============================================================================
// ROLE OPERATIONS
// =============================================================================

export interface RoleData {
	id: number;
	name: string;
	description?: string | null;
	isSystem: boolean;
	permissions: Permissions;
	environmentIds: number[] | null; // null = all environments, array = specific env IDs
	createdAt: string;
	updatedAt: string;
}

export async function getRoles(): Promise<RoleData[]> {
	const rows = await db.select().from(roles).orderBy(asc(roles.name));
	return rows.map(row => ({
		...row,
		permissions: JSON.parse(row.permissions),
		environmentIds: row.environmentIds ? JSON.parse(row.environmentIds) : null
	})) as RoleData[];
}

export async function getRole(id: number): Promise<RoleData | null> {
	const results = await db.select().from(roles).where(eq(roles.id, id));
	if (!results[0]) return null;
	return {
		...results[0],
		permissions: JSON.parse(results[0].permissions),
		environmentIds: results[0].environmentIds ? JSON.parse(results[0].environmentIds) : null
	} as RoleData;
}

export async function getRoleByName(name: string): Promise<RoleData | null> {
	const results = await db.select().from(roles).where(eq(roles.name, name));
	if (!results[0]) return null;
	return {
		...results[0],
		permissions: JSON.parse(results[0].permissions),
		environmentIds: results[0].environmentIds ? JSON.parse(results[0].environmentIds) : null
	} as RoleData;
}

export async function createRole(data: {
	name: string;
	description?: string;
	permissions: Permissions;
	environmentIds?: number[] | null;
}): Promise<RoleData> {
	const result = await db.insert(roles).values({
		name: data.name,
		description: data.description || null,
		isSystem: false,
		permissions: JSON.stringify(data.permissions),
		environmentIds: data.environmentIds ? JSON.stringify(data.environmentIds) : null
	}).returning();
	return getRole(result[0].id) as Promise<RoleData>;
}

export async function updateRole(id: number, data: Partial<RoleData>): Promise<RoleData | null> {
	const role = await getRole(id);
	if (!role || role.isSystem) return null;

	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (data.name !== undefined) updateData.name = data.name;
	if (data.description !== undefined) updateData.description = data.description || null;
	if (data.permissions !== undefined) updateData.permissions = JSON.stringify(data.permissions);
	if (data.environmentIds !== undefined) {
		updateData.environmentIds = data.environmentIds ? JSON.stringify(data.environmentIds) : null;
	}

	await db.update(roles).set(updateData).where(eq(roles.id, id));
	return getRole(id);
}

export async function deleteRole(id: number): Promise<boolean> {
	const role = await getRole(id);
	if (!role || role.isSystem) return false;
	await db.delete(roles).where(and(eq(roles.id, id), eq(roles.isSystem, false)));
	return true;
}

// =============================================================================
// USER-ROLE OPERATIONS
// =============================================================================

export interface UserRoleData {
	id: number;
	userId: number;
	roleId: number;
	environmentId?: number | null;
	createdAt: string;
	role?: RoleData;
}

export async function getUserRoles(userId: number): Promise<UserRoleData[]> {
	const rows = await db.select({
		id: userRoles.id,
		userId: userRoles.userId,
		roleId: userRoles.roleId,
		environmentId: userRoles.environmentId,
		createdAt: userRoles.createdAt,
		roleName: roles.name,
		roleDescription: roles.description,
		roleIsSystem: roles.isSystem,
		rolePermissions: roles.permissions
	})
		.from(userRoles)
		.innerJoin(roles, eq(userRoles.roleId, roles.id))
		.where(eq(userRoles.userId, userId));

	return rows.map(row => ({
		id: row.id,
		userId: row.userId,
		roleId: row.roleId,
		environmentId: row.environmentId,
		createdAt: row.createdAt,
		role: {
			id: row.roleId,
			name: row.roleName,
			description: row.roleDescription,
			isSystem: row.roleIsSystem,
			permissions: JSON.parse(row.rolePermissions),
			createdAt: row.createdAt,
			updatedAt: row.createdAt
		}
	})) as UserRoleData[];
}

export async function assignUserRole(userId: number, roleId: number, environmentId?: number): Promise<UserRoleData> {
	await db.insert(userRoles).values({
		userId,
		roleId,
		environmentId: environmentId || null
	}).onConflictDoNothing();

	const results = await db.select().from(userRoles)
		.where(and(
			eq(userRoles.userId, userId),
			eq(userRoles.roleId, roleId),
			environmentId ? eq(userRoles.environmentId, environmentId) : isNull(userRoles.environmentId)
		));
	return results[0] as UserRoleData;
}

export async function removeUserRole(userId: number, roleId: number, environmentId?: number): Promise<boolean> {
	await db.delete(userRoles)
		.where(and(
			eq(userRoles.userId, userId),
			eq(userRoles.roleId, roleId),
			environmentId ? eq(userRoles.environmentId, environmentId) : isNull(userRoles.environmentId)
		));
	return true;
}

/**
 * Check if user has the Admin role assigned.
 * This is the authoritative check for admin privileges (instead of users.isAdmin column).
 */
export async function userHasAdminRole(userId: number): Promise<boolean> {
	const result = await db.select({ id: roles.id })
		.from(userRoles)
		.innerJoin(roles, eq(userRoles.roleId, roles.id))
		.where(and(
			eq(userRoles.userId, userId),
			eq(roles.name, 'Admin')
		))
		.limit(1);
	return result.length > 0;
}

/**
 * Get environment IDs that a user can access based on their role assignments.
 * Returns null if user has access to ALL environments (has at least one role with null environmentIds).
 * Returns array of environment IDs if user has limited access.
 * Returns empty array if user has no environment access.
 */
export async function getUserAccessibleEnvironments(userId: number): Promise<number[] | null> {
	const rows = await db.select({
		roleEnvironmentIds: roles.environmentIds
	})
		.from(userRoles)
		.innerJoin(roles, eq(userRoles.roleId, roles.id))
		.where(eq(userRoles.userId, userId));

	const accessibleEnvIds: number[] = [];

	for (const row of rows) {
		// If any role has null environmentIds, user has access to all environments
		if (row.roleEnvironmentIds === null) {
			return null; // null means "all environments"
		}
		try {
			const envIds: number[] = JSON.parse(row.roleEnvironmentIds);
			accessibleEnvIds.push(...envIds);
		} catch {
			// If parsing fails, assume all environments
			return null;
		}
	}

	// Return unique environment IDs
	return [...new Set(accessibleEnvIds)];
}

/**
 * Get roles for a user that apply to a specific environment.
 * Returns roles where environmentId is null (global) OR matches the specified environment.
 */
interface RoleEnvRow {
	id: number;
	userId: number;
	roleId: number;
	environmentId: number | null;
	createdAt: string | null;
	roleName: string;
	roleDescription: string | null;
	roleIsSystem: boolean;
	rolePermissions: string;
	roleEnvironmentIds: string | null;
}

/**
 * Get user roles that apply to a specific environment.
 * A role applies if:
 * - role.environmentIds is NULL (applies to all environments), OR
 * - role.environmentIds array contains the target environmentId
 */
export async function getUserRolesForEnvironment(userId: number, environmentId: number): Promise<UserRoleData[]> {
	const rows = await db.select({
		id: userRoles.id,
		userId: userRoles.userId,
		roleId: userRoles.roleId,
		environmentId: userRoles.environmentId,
		createdAt: userRoles.createdAt,
		roleName: roles.name,
		roleDescription: roles.description,
		roleIsSystem: roles.isSystem,
		rolePermissions: roles.permissions,
		roleEnvironmentIds: roles.environmentIds
	})
		.from(userRoles)
		.innerJoin(roles, eq(userRoles.roleId, roles.id))
		.where(eq(userRoles.userId, userId)) as RoleEnvRow[];

	// Filter roles that apply to this environment
	// Role applies if environmentIds is null OR contains the environmentId
	const filteredRows = rows.filter((row: RoleEnvRow) => {
		if (row.roleEnvironmentIds === null) {
			return true; // null means all environments
		}
		try {
			const envIds: number[] = JSON.parse(row.roleEnvironmentIds);
			return envIds.includes(environmentId);
		} catch {
			return true; // If parsing fails, assume all environments
		}
	});

	return filteredRows.map((row: RoleEnvRow) => ({
		id: row.id,
		userId: row.userId,
		roleId: row.roleId,
		environmentId: row.environmentId,
		createdAt: row.createdAt,
		role: {
			id: row.roleId,
			name: row.roleName,
			description: row.roleDescription,
			isSystem: row.roleIsSystem,
			permissions: JSON.parse(row.rolePermissions),
			environmentIds: row.roleEnvironmentIds ? JSON.parse(row.roleEnvironmentIds) : null,
			createdAt: row.createdAt,
			updatedAt: row.createdAt
		}
	})) as UserRoleData[];
}

/**
 * Check if a user can access a specific environment.
 * Returns true if user has any role that applies to this environment.
 * A role applies if role.environmentIds is null OR contains the environmentId.
 */
export async function userCanAccessEnvironment(userId: number, environmentId: number): Promise<boolean> {
	const rows = await db.select({
		id: userRoles.id,
		roleEnvironmentIds: roles.environmentIds
	})
		.from(userRoles)
		.innerJoin(roles, eq(userRoles.roleId, roles.id))
		.where(eq(userRoles.userId, userId));

	// Check if any assigned role applies to this environment
	for (const row of rows) {
		if (row.roleEnvironmentIds === null) {
			return true; // null means all environments
		}
		try {
			const envIds: number[] = JSON.parse(row.roleEnvironmentIds);
			if (envIds.includes(environmentId)) {
				return true;
			}
		} catch {
			return true; // If parsing fails, assume all environments
		}
	}

	return false;
}

// =============================================================================
// LDAP CONFIG OPERATIONS
// =============================================================================

export interface LdapRoleMapping {
	groupDn: string;
	roleId: number;
}

export interface LdapConfigData {
	id: number;
	name: string;
	enabled: boolean;
	serverUrl: string;
	bindDn?: string | null;
	bindPassword?: string | null;
	baseDn: string;
	userFilter: string;
	usernameAttribute: string;
	emailAttribute: string;
	displayNameAttribute: string;
	groupBaseDn?: string | null;
	groupFilter?: string | null;
	adminGroup?: string | null;
	roleMappings?: LdapRoleMapping[] | null;
	tlsEnabled: boolean;
	tlsCa?: string | null;
	createdAt: string;
	updatedAt: string;
}

export async function getLdapConfigs(): Promise<LdapConfigData[]> {
	const results = await db.select().from(ldapConfig).orderBy(asc(ldapConfig.name));
	return results.map((row: any) => ({
		...row,
		bindPassword: decrypt(row.bindPassword),
		roleMappings: row.roleMappings ? JSON.parse(row.roleMappings) : null
	})) as LdapConfigData[];
}

export async function getLdapConfig(id: number): Promise<LdapConfigData | null> {
	const results = await db.select().from(ldapConfig).where(eq(ldapConfig.id, id));
	if (!results[0]) return null;
	const row = results[0] as any;
	return {
		...row,
		bindPassword: decrypt(row.bindPassword),
		roleMappings: row.roleMappings ? JSON.parse(row.roleMappings) : null
	} as LdapConfigData;
}

export async function createLdapConfig(data: Omit<LdapConfigData, 'id' | 'createdAt' | 'updatedAt'>): Promise<LdapConfigData> {
	const result = await db.insert(ldapConfig).values({
		name: data.name,
		enabled: data.enabled,
		serverUrl: data.serverUrl,
		bindDn: data.bindDn || null,
		bindPassword: encrypt(data.bindPassword) || null,
		baseDn: data.baseDn,
		userFilter: data.userFilter,
		usernameAttribute: data.usernameAttribute,
		emailAttribute: data.emailAttribute,
		displayNameAttribute: data.displayNameAttribute,
		groupBaseDn: data.groupBaseDn || null,
		groupFilter: data.groupFilter || null,
		adminGroup: data.adminGroup || null,
		roleMappings: data.roleMappings ? JSON.stringify(data.roleMappings) : null,
		tlsEnabled: data.tlsEnabled,
		tlsCa: data.tlsCa || null
	}).returning();
	return getLdapConfig(result[0].id) as Promise<LdapConfigData>;
}

export async function updateLdapConfig(id: number, data: Partial<LdapConfigData>): Promise<LdapConfigData | null> {
	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (data.name !== undefined) updateData.name = data.name;
	if (data.enabled !== undefined) updateData.enabled = data.enabled;
	if (data.serverUrl !== undefined) updateData.serverUrl = data.serverUrl;
	if (data.bindDn !== undefined) updateData.bindDn = data.bindDn || null;
	if (data.bindPassword !== undefined) updateData.bindPassword = encrypt(data.bindPassword) || null;
	if (data.baseDn !== undefined) updateData.baseDn = data.baseDn;
	if (data.userFilter !== undefined) updateData.userFilter = data.userFilter;
	if (data.usernameAttribute !== undefined) updateData.usernameAttribute = data.usernameAttribute;
	if (data.emailAttribute !== undefined) updateData.emailAttribute = data.emailAttribute;
	if (data.displayNameAttribute !== undefined) updateData.displayNameAttribute = data.displayNameAttribute;
	if (data.groupBaseDn !== undefined) updateData.groupBaseDn = data.groupBaseDn || null;
	if (data.groupFilter !== undefined) updateData.groupFilter = data.groupFilter || null;
	if (data.adminGroup !== undefined) updateData.adminGroup = data.adminGroup || null;
	if (data.roleMappings !== undefined) updateData.roleMappings = data.roleMappings ? JSON.stringify(data.roleMappings) : null;
	if (data.tlsEnabled !== undefined) updateData.tlsEnabled = data.tlsEnabled;
	if (data.tlsCa !== undefined) updateData.tlsCa = data.tlsCa || null;

	await db.update(ldapConfig).set(updateData).where(eq(ldapConfig.id, id));
	return getLdapConfig(id);
}

export async function deleteLdapConfig(id: number): Promise<boolean> {
	await db.delete(ldapConfig).where(eq(ldapConfig.id, id));
	return true;
}

// =============================================================================
// OIDC CONFIG OPERATIONS
// =============================================================================

export interface OidcRoleMapping {
	claimValue: string;
	roleId: number;
}

export interface OidcConfigData {
	id: number;
	name: string;
	enabled: boolean;
	issuerUrl: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	scopes: string;
	usernameClaim: string;
	emailClaim: string;
	displayNameClaim: string;
	adminClaim?: string | null;
	adminValue?: string | null;
	roleMappingsClaim?: string | null;
	roleMappings?: OidcRoleMapping[] | null;
	createdAt: string;
	updatedAt: string;
}

export async function getOidcConfigs(): Promise<OidcConfigData[]> {
	const rows = await db.select().from(oidcConfig).orderBy(asc(oidcConfig.name));
	return rows.map(row => ({
		...row,
		clientSecret: decrypt(row.clientSecret) ?? '',
		roleMappings: row.roleMappings ? JSON.parse(row.roleMappings) : undefined
	})) as OidcConfigData[];
}

export async function getOidcConfig(id: number): Promise<OidcConfigData | null> {
	const results = await db.select().from(oidcConfig).where(eq(oidcConfig.id, id));
	if (!results[0]) return null;
	return {
		...results[0],
		clientSecret: decrypt(results[0].clientSecret) ?? '',
		roleMappings: results[0].roleMappings ? JSON.parse(results[0].roleMappings) : undefined
	} as OidcConfigData;
}

export async function createOidcConfig(data: Omit<OidcConfigData, 'id' | 'createdAt' | 'updatedAt'>): Promise<OidcConfigData> {
	const result = await db.insert(oidcConfig).values({
		name: data.name,
		enabled: data.enabled,
		issuerUrl: data.issuerUrl,
		clientId: data.clientId,
		clientSecret: encrypt(data.clientSecret) ?? '',
		redirectUri: data.redirectUri,
		scopes: data.scopes,
		usernameClaim: data.usernameClaim,
		emailClaim: data.emailClaim,
		displayNameClaim: data.displayNameClaim,
		adminClaim: data.adminClaim || null,
		adminValue: data.adminValue || null,
		roleMappingsClaim: data.roleMappingsClaim || 'groups',
		roleMappings: data.roleMappings ? JSON.stringify(data.roleMappings) : null
	}).returning();
	return getOidcConfig(result[0].id) as Promise<OidcConfigData>;
}

export async function updateOidcConfig(id: number, data: Partial<OidcConfigData>): Promise<OidcConfigData | null> {
	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (data.name !== undefined) updateData.name = data.name;
	if (data.enabled !== undefined) updateData.enabled = data.enabled;
	if (data.issuerUrl !== undefined) updateData.issuerUrl = data.issuerUrl;
	if (data.clientId !== undefined) updateData.clientId = data.clientId;
	if (data.clientSecret !== undefined) updateData.clientSecret = encrypt(data.clientSecret);
	if (data.redirectUri !== undefined) updateData.redirectUri = data.redirectUri;
	if (data.scopes !== undefined) updateData.scopes = data.scopes;
	if (data.usernameClaim !== undefined) updateData.usernameClaim = data.usernameClaim;
	if (data.emailClaim !== undefined) updateData.emailClaim = data.emailClaim;
	if (data.displayNameClaim !== undefined) updateData.displayNameClaim = data.displayNameClaim;
	if (data.adminClaim !== undefined) updateData.adminClaim = data.adminClaim || null;
	if (data.adminValue !== undefined) updateData.adminValue = data.adminValue || null;
	if (data.roleMappingsClaim !== undefined) updateData.roleMappingsClaim = data.roleMappingsClaim || 'groups';
	if (data.roleMappings !== undefined) updateData.roleMappings = data.roleMappings ? JSON.stringify(data.roleMappings) : null;

	await db.update(oidcConfig).set(updateData).where(eq(oidcConfig.id, id));
	return getOidcConfig(id);
}

export async function deleteOidcConfig(id: number): Promise<boolean> {
	await db.delete(oidcConfig).where(eq(oidcConfig.id, id));
	return true;
}

// =============================================================================
// GIT CREDENTIALS OPERATIONS
// =============================================================================

export type GitAuthType = 'none' | 'password' | 'ssh';

export interface GitCredentialData {
	id: number;
	name: string;
	authType: GitAuthType;
	username?: string | null;
	password?: string | null;
	sshPrivateKey?: string | null;
	sshPassphrase?: string | null;
	createdAt: string;
	updatedAt: string;
}

export async function getGitCredentials(): Promise<GitCredentialData[]> {
	const results = await db.select().from(gitCredentials).orderBy(asc(gitCredentials.name));
	return results.map(r => ({
		...r,
		password: decrypt(r.password),
		sshPrivateKey: decrypt(r.sshPrivateKey),
		sshPassphrase: decrypt(r.sshPassphrase)
	})) as GitCredentialData[];
}

export async function getGitCredential(id: number): Promise<GitCredentialData | null> {
	const results = await db.select().from(gitCredentials).where(eq(gitCredentials.id, id));
	if (!results[0]) return null;
	return {
		...results[0],
		password: decrypt(results[0].password),
		sshPrivateKey: decrypt(results[0].sshPrivateKey),
		sshPassphrase: decrypt(results[0].sshPassphrase)
	} as GitCredentialData;
}

export async function createGitCredential(data: {
	name: string;
	authType: GitAuthType;
	username?: string;
	password?: string;
	sshPrivateKey?: string;
	sshPassphrase?: string;
}): Promise<GitCredentialData> {
	const result = await db.insert(gitCredentials).values({
		name: data.name,
		authType: data.authType,
		username: data.username || null,
		password: encrypt(data.password) || null,
		sshPrivateKey: encrypt(data.sshPrivateKey) || null,
		sshPassphrase: encrypt(data.sshPassphrase) || null
	}).returning();
	return getGitCredential(result[0].id) as Promise<GitCredentialData>;
}

export async function updateGitCredential(id: number, data: Partial<GitCredentialData>): Promise<GitCredentialData | null> {
	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (data.name !== undefined) updateData.name = data.name;
	if (data.authType !== undefined) updateData.authType = data.authType;
	// Only update username if provided (empty string clears it)
	if (data.username !== undefined) updateData.username = data.username || null;
	// Only update password/ssh keys if they have actual values (preserve existing if empty)
	if (data.password) updateData.password = encrypt(data.password);
	if (data.sshPrivateKey) updateData.sshPrivateKey = encrypt(data.sshPrivateKey);
	if (data.sshPassphrase) updateData.sshPassphrase = encrypt(data.sshPassphrase);

	await db.update(gitCredentials).set(updateData).where(eq(gitCredentials.id, id));
	return getGitCredential(id);
}

export async function deleteGitCredential(id: number): Promise<boolean> {
	await db.delete(gitCredentials).where(eq(gitCredentials.id, id));
	return true;
}

// =============================================================================
// GIT REPOSITORIES OPERATIONS
// =============================================================================

export type GitSyncStatus = 'pending' | 'syncing' | 'synced' | 'error';

export interface GitRepositoryData {
	id: number;
	name: string;
	url: string;
	branch: string;
	composePath: string;
	credentialId: number | null;
	environmentId: number | null;
	autoUpdate: boolean;
	autoUpdateSchedule: 'daily' | 'weekly' | 'custom';
	autoUpdateCron: string;
	webhookEnabled: boolean;
	webhookSecret: string | null;
	lastSync: string | null;
	lastCommit: string | null;
	syncStatus: GitSyncStatus;
	syncError: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface GitRepositoryWithCredential extends GitRepositoryData {
	credential?: GitCredentialData | null;
}

export async function getGitRepositories(): Promise<GitRepositoryWithCredential[]> {
	const rows = await db.select({
		id: gitRepositories.id,
		name: gitRepositories.name,
		url: gitRepositories.url,
		branch: gitRepositories.branch,
		composePath: gitRepositories.composePath,
		credentialId: gitRepositories.credentialId,
		environmentId: gitRepositories.environmentId,
		autoUpdate: gitRepositories.autoUpdate,
		autoUpdateSchedule: gitRepositories.autoUpdateSchedule,
		autoUpdateCron: gitRepositories.autoUpdateCron,
		webhookEnabled: gitRepositories.webhookEnabled,
		webhookSecret: gitRepositories.webhookSecret,
		lastSync: gitRepositories.lastSync,
		lastCommit: gitRepositories.lastCommit,
		syncStatus: gitRepositories.syncStatus,
		syncError: gitRepositories.syncError,
		createdAt: gitRepositories.createdAt,
		updatedAt: gitRepositories.updatedAt,
		credentialName: gitCredentials.name,
		credentialAuthType: gitCredentials.authType
	})
		.from(gitRepositories)
		.leftJoin(gitCredentials, eq(gitRepositories.credentialId, gitCredentials.id))
		.orderBy(asc(gitRepositories.name));

	return rows.map(row => ({
		...row,
		credential: row.credentialId ? {
			id: row.credentialId,
			name: row.credentialName,
			authType: row.credentialAuthType
		} : null
	})) as GitRepositoryWithCredential[];
}

export async function getGitRepository(id: number): Promise<GitRepositoryData | null> {
	const results = await db.select().from(gitRepositories).where(eq(gitRepositories.id, id));
	return results[0] as GitRepositoryData || null;
}

export async function getGitRepositoryByName(name: string): Promise<GitRepositoryData | null> {
	const results = await db.select().from(gitRepositories).where(eq(gitRepositories.name, name));
	return results[0] as GitRepositoryData || null;
}

export async function createGitRepository(data: {
	name: string;
	url: string;
	branch?: string;
	composePath?: string;
	credentialId?: number | null;
	environmentId?: number | null;
	autoUpdate?: boolean;
	autoUpdateSchedule?: 'daily' | 'weekly' | 'custom';
	autoUpdateCron?: string;
	webhookEnabled?: boolean;
	webhookSecret?: string | null;
}): Promise<GitRepositoryData> {
	const result = await db.insert(gitRepositories).values({
		name: data.name,
		url: data.url,
		branch: data.branch || 'main',
		composePath: data.composePath || 'compose.yaml',
		credentialId: data.credentialId || null,
		environmentId: data.environmentId || null,
		autoUpdate: data.autoUpdate || false,
		autoUpdateSchedule: data.autoUpdateSchedule || 'daily',
		autoUpdateCron: data.autoUpdateCron || '0 3 * * *',
		webhookEnabled: data.webhookEnabled || false,
		webhookSecret: data.webhookSecret || null
	}).returning();
	return getGitRepository(result[0].id) as Promise<GitRepositoryData>;
}

export async function updateGitRepository(id: number, data: Partial<GitRepositoryData>): Promise<GitRepositoryData | null> {
	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (data.name !== undefined) updateData.name = data.name;
	if (data.url !== undefined) updateData.url = data.url;
	if (data.branch !== undefined) updateData.branch = data.branch;
	if (data.composePath !== undefined) updateData.composePath = data.composePath;
	if (data.credentialId !== undefined) updateData.credentialId = data.credentialId;
	if (data.environmentId !== undefined) updateData.environmentId = data.environmentId;
	if (data.autoUpdate !== undefined) updateData.autoUpdate = data.autoUpdate;
	if (data.autoUpdateSchedule !== undefined) updateData.autoUpdateSchedule = data.autoUpdateSchedule;
	if (data.autoUpdateCron !== undefined) updateData.autoUpdateCron = data.autoUpdateCron;
	if (data.webhookEnabled !== undefined) updateData.webhookEnabled = data.webhookEnabled;
	if (data.webhookSecret !== undefined) updateData.webhookSecret = data.webhookSecret;
	if (data.lastSync !== undefined) updateData.lastSync = data.lastSync;
	if (data.lastCommit !== undefined) updateData.lastCommit = data.lastCommit;
	if (data.syncStatus !== undefined) updateData.syncStatus = data.syncStatus;
	if (data.syncError !== undefined) updateData.syncError = data.syncError;

	await db.update(gitRepositories).set(updateData).where(eq(gitRepositories.id, id));
	return getGitRepository(id);
}

export async function deleteGitRepository(id: number): Promise<boolean> {
	await db.delete(gitRepositories).where(eq(gitRepositories.id, id));
	return true;
}

// =============================================================================
// GIT STACKS OPERATIONS
// =============================================================================

export interface GitStackData {
	id: number;
	stackName: string;
	environmentId: number | null;
	repositoryId: number;
	composePath: string;
	envFilePath: string | null;
	autoUpdate: boolean;
	autoUpdateSchedule: 'daily' | 'weekly' | 'custom';
	autoUpdateCron: string;
	webhookEnabled: boolean;
	webhookSecret: string | null;
	lastSync: string | null;
	lastCommit: string | null;
	syncStatus: GitSyncStatus;
	syncError: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface GitStackWithRepo extends GitStackData {
	repository: {
		id: number;
		name: string;
		url: string;
		branch: string;
		credentialId: number | null;
	};
}

export async function getGitStacks(environmentId?: number): Promise<GitStackWithRepo[]> {
	let rows;
	if (environmentId !== undefined) {
		rows = await db.select({
			id: gitStacks.id,
			stackName: gitStacks.stackName,
			environmentId: gitStacks.environmentId,
			repositoryId: gitStacks.repositoryId,
			composePath: gitStacks.composePath,
			envFilePath: gitStacks.envFilePath,
			autoUpdate: gitStacks.autoUpdate,
			autoUpdateSchedule: gitStacks.autoUpdateSchedule,
			autoUpdateCron: gitStacks.autoUpdateCron,
			webhookEnabled: gitStacks.webhookEnabled,
			webhookSecret: gitStacks.webhookSecret,
			lastSync: gitStacks.lastSync,
			lastCommit: gitStacks.lastCommit,
			syncStatus: gitStacks.syncStatus,
			syncError: gitStacks.syncError,
			createdAt: gitStacks.createdAt,
			updatedAt: gitStacks.updatedAt,
			repoName: gitRepositories.name,
			repoUrl: gitRepositories.url,
			repoBranch: gitRepositories.branch,
			repoCredentialId: gitRepositories.credentialId
		})
			.from(gitStacks)
			.innerJoin(gitRepositories, eq(gitStacks.repositoryId, gitRepositories.id))
			.where(or(eq(gitStacks.environmentId, environmentId), isNull(gitStacks.environmentId)))
			.orderBy(asc(gitStacks.stackName));
	} else {
		rows = await db.select({
			id: gitStacks.id,
			stackName: gitStacks.stackName,
			environmentId: gitStacks.environmentId,
			repositoryId: gitStacks.repositoryId,
			composePath: gitStacks.composePath,
			envFilePath: gitStacks.envFilePath,
			autoUpdate: gitStacks.autoUpdate,
			autoUpdateSchedule: gitStacks.autoUpdateSchedule,
			autoUpdateCron: gitStacks.autoUpdateCron,
			webhookEnabled: gitStacks.webhookEnabled,
			webhookSecret: gitStacks.webhookSecret,
			lastSync: gitStacks.lastSync,
			lastCommit: gitStacks.lastCommit,
			syncStatus: gitStacks.syncStatus,
			syncError: gitStacks.syncError,
			createdAt: gitStacks.createdAt,
			updatedAt: gitStacks.updatedAt,
			repoName: gitRepositories.name,
			repoUrl: gitRepositories.url,
			repoBranch: gitRepositories.branch,
			repoCredentialId: gitRepositories.credentialId
		})
			.from(gitStacks)
			.innerJoin(gitRepositories, eq(gitStacks.repositoryId, gitRepositories.id))
			.orderBy(asc(gitStacks.stackName));
	}

	return rows.map(row => ({
		id: row.id,
		stackName: row.stackName,
		environmentId: row.environmentId,
		repositoryId: row.repositoryId,
		composePath: row.composePath,
		envFilePath: row.envFilePath,
		autoUpdate: row.autoUpdate,
		autoUpdateSchedule: row.autoUpdateSchedule,
		autoUpdateCron: row.autoUpdateCron,
		webhookEnabled: row.webhookEnabled,
		webhookSecret: row.webhookSecret,
		lastSync: row.lastSync,
		lastCommit: row.lastCommit,
		syncStatus: row.syncStatus,
		syncError: row.syncError,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		repository: {
			id: row.repositoryId,
			name: row.repoName,
			url: row.repoUrl,
			branch: row.repoBranch,
			credentialId: row.repoCredentialId
		}
	})) as GitStackWithRepo[];
}

// Get git stacks for a specific environment only (excludes stacks with null environment)
export async function getGitStacksForEnvironmentOnly(environmentId: number): Promise<GitStackWithRepo[]> {
	const rows = await db.select({
		id: gitStacks.id,
		stackName: gitStacks.stackName,
		environmentId: gitStacks.environmentId,
		repositoryId: gitStacks.repositoryId,
		composePath: gitStacks.composePath,
		envFilePath: gitStacks.envFilePath,
		autoUpdate: gitStacks.autoUpdate,
		autoUpdateSchedule: gitStacks.autoUpdateSchedule,
		autoUpdateCron: gitStacks.autoUpdateCron,
		webhookEnabled: gitStacks.webhookEnabled,
		webhookSecret: gitStacks.webhookSecret,
		lastSync: gitStacks.lastSync,
		lastCommit: gitStacks.lastCommit,
		syncStatus: gitStacks.syncStatus,
		syncError: gitStacks.syncError,
		createdAt: gitStacks.createdAt,
		updatedAt: gitStacks.updatedAt,
		repoName: gitRepositories.name,
		repoUrl: gitRepositories.url,
		repoBranch: gitRepositories.branch,
		repoCredentialId: gitRepositories.credentialId
	})
		.from(gitStacks)
		.innerJoin(gitRepositories, eq(gitStacks.repositoryId, gitRepositories.id))
		.where(eq(gitStacks.environmentId, environmentId))
		.orderBy(asc(gitStacks.stackName));

	return rows.map((row) => ({
		id: row.id,
		stackName: row.stackName,
		environmentId: row.environmentId,
		repositoryId: row.repositoryId,
		composePath: row.composePath,
		envFilePath: row.envFilePath,
		autoUpdate: row.autoUpdate,
		autoUpdateSchedule: row.autoUpdateSchedule,
		autoUpdateCron: row.autoUpdateCron,
		webhookEnabled: row.webhookEnabled,
		webhookSecret: row.webhookSecret,
		lastSync: row.lastSync,
		lastCommit: row.lastCommit,
		syncStatus: row.syncStatus,
		syncError: row.syncError,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		repository: {
			id: row.repositoryId,
			name: row.repoName,
			url: row.repoUrl,
			branch: row.repoBranch,
			credentialId: row.repoCredentialId
		}
	})) as GitStackWithRepo[];
}

export async function getGitStack(id: number): Promise<GitStackWithRepo | null> {
	const rows = await db.select({
		id: gitStacks.id,
		stackName: gitStacks.stackName,
		environmentId: gitStacks.environmentId,
		repositoryId: gitStacks.repositoryId,
		composePath: gitStacks.composePath,
		envFilePath: gitStacks.envFilePath,
		autoUpdate: gitStacks.autoUpdate,
		autoUpdateSchedule: gitStacks.autoUpdateSchedule,
		autoUpdateCron: gitStacks.autoUpdateCron,
		webhookEnabled: gitStacks.webhookEnabled,
		webhookSecret: gitStacks.webhookSecret,
		lastSync: gitStacks.lastSync,
		lastCommit: gitStacks.lastCommit,
		syncStatus: gitStacks.syncStatus,
		syncError: gitStacks.syncError,
		createdAt: gitStacks.createdAt,
		updatedAt: gitStacks.updatedAt,
		repoName: gitRepositories.name,
		repoUrl: gitRepositories.url,
		repoBranch: gitRepositories.branch,
		repoCredentialId: gitRepositories.credentialId
	})
		.from(gitStacks)
		.innerJoin(gitRepositories, eq(gitStacks.repositoryId, gitRepositories.id))
		.where(eq(gitStacks.id, id));

	if (!rows[0]) return null;
	const row = rows[0];
	return {
		id: row.id,
		stackName: row.stackName,
		environmentId: row.environmentId,
		repositoryId: row.repositoryId,
		composePath: row.composePath,
		envFilePath: row.envFilePath,
		autoUpdate: row.autoUpdate,
		autoUpdateSchedule: row.autoUpdateSchedule,
		autoUpdateCron: row.autoUpdateCron,
		webhookEnabled: row.webhookEnabled,
		webhookSecret: row.webhookSecret,
		lastSync: row.lastSync,
		lastCommit: row.lastCommit,
		syncStatus: row.syncStatus,
		syncError: row.syncError,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		repository: {
			id: row.repositoryId,
			name: row.repoName,
			url: row.repoUrl,
			branch: row.repoBranch,
			credentialId: row.repoCredentialId
		}
	} as GitStackWithRepo;
}

export async function getGitStackByName(stackName: string, environmentId?: number | null): Promise<GitStackWithRepo | null> {
	const rows = await db.select({
		id: gitStacks.id,
		stackName: gitStacks.stackName,
		environmentId: gitStacks.environmentId,
		repositoryId: gitStacks.repositoryId,
		composePath: gitStacks.composePath,
		envFilePath: gitStacks.envFilePath,
		autoUpdate: gitStacks.autoUpdate,
		autoUpdateSchedule: gitStacks.autoUpdateSchedule,
		autoUpdateCron: gitStacks.autoUpdateCron,
		webhookEnabled: gitStacks.webhookEnabled,
		webhookSecret: gitStacks.webhookSecret,
		lastSync: gitStacks.lastSync,
		lastCommit: gitStacks.lastCommit,
		syncStatus: gitStacks.syncStatus,
		syncError: gitStacks.syncError,
		createdAt: gitStacks.createdAt,
		updatedAt: gitStacks.updatedAt,
		repoName: gitRepositories.name,
		repoUrl: gitRepositories.url,
		repoBranch: gitRepositories.branch,
		repoCredentialId: gitRepositories.credentialId
	})
		.from(gitStacks)
		.innerJoin(gitRepositories, eq(gitStacks.repositoryId, gitRepositories.id))
		.where(and(
			eq(gitStacks.stackName, stackName),
			environmentId !== undefined && environmentId !== null
				? eq(gitStacks.environmentId, environmentId)
				: isNull(gitStacks.environmentId)
		));

	if (!rows[0]) return null;
	const row = rows[0];
	return {
		id: row.id,
		stackName: row.stackName,
		environmentId: row.environmentId,
		repositoryId: row.repositoryId,
		composePath: row.composePath,
		envFilePath: row.envFilePath,
		autoUpdate: row.autoUpdate,
		autoUpdateSchedule: row.autoUpdateSchedule,
		autoUpdateCron: row.autoUpdateCron,
		webhookEnabled: row.webhookEnabled,
		webhookSecret: row.webhookSecret,
		lastSync: row.lastSync,
		lastCommit: row.lastCommit,
		syncStatus: row.syncStatus,
		syncError: row.syncError,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		repository: {
			id: row.repositoryId,
			name: row.repoName,
			url: row.repoUrl,
			branch: row.repoBranch,
			credentialId: row.repoCredentialId
		}
	} as GitStackWithRepo;
}

export async function getGitStackByWebhookSecret(secret: string): Promise<GitStackWithRepo | null> {
	const rows = await db.select({
		id: gitStacks.id,
		stackName: gitStacks.stackName,
		environmentId: gitStacks.environmentId,
		repositoryId: gitStacks.repositoryId,
		composePath: gitStacks.composePath,
		envFilePath: gitStacks.envFilePath,
		autoUpdate: gitStacks.autoUpdate,
		autoUpdateSchedule: gitStacks.autoUpdateSchedule,
		autoUpdateCron: gitStacks.autoUpdateCron,
		webhookEnabled: gitStacks.webhookEnabled,
		webhookSecret: gitStacks.webhookSecret,
		lastSync: gitStacks.lastSync,
		lastCommit: gitStacks.lastCommit,
		syncStatus: gitStacks.syncStatus,
		syncError: gitStacks.syncError,
		createdAt: gitStacks.createdAt,
		updatedAt: gitStacks.updatedAt,
		repoName: gitRepositories.name,
		repoUrl: gitRepositories.url,
		repoBranch: gitRepositories.branch,
		repoCredentialId: gitRepositories.credentialId
	})
		.from(gitStacks)
		.innerJoin(gitRepositories, eq(gitStacks.repositoryId, gitRepositories.id))
		.where(and(eq(gitStacks.webhookSecret, secret), eq(gitStacks.webhookEnabled, true)));

	if (!rows[0]) return null;
	const row = rows[0];
	return {
		id: row.id,
		stackName: row.stackName,
		environmentId: row.environmentId,
		repositoryId: row.repositoryId,
		composePath: row.composePath,
		envFilePath: row.envFilePath,
		autoUpdate: row.autoUpdate,
		autoUpdateSchedule: row.autoUpdateSchedule,
		autoUpdateCron: row.autoUpdateCron,
		webhookEnabled: row.webhookEnabled,
		webhookSecret: row.webhookSecret,
		lastSync: row.lastSync,
		lastCommit: row.lastCommit,
		syncStatus: row.syncStatus,
		syncError: row.syncError,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		repository: {
			id: row.repositoryId,
			name: row.repoName,
			url: row.repoUrl,
			branch: row.repoBranch,
			credentialId: row.repoCredentialId
		}
	} as GitStackWithRepo;
}

export async function createGitStack(data: {
	stackName: string;
	environmentId?: number | null;
	repositoryId: number;
	composePath?: string;
	envFilePath?: string | null;
	autoUpdate?: boolean;
	autoUpdateSchedule?: 'daily' | 'weekly' | 'custom';
	autoUpdateCron?: string;
	webhookEnabled?: boolean;
	webhookSecret?: string | null;
}): Promise<GitStackWithRepo> {
	const result = await db.insert(gitStacks).values({
		stackName: data.stackName,
		environmentId: data.environmentId ?? null,
		repositoryId: data.repositoryId,
		composePath: data.composePath || 'compose.yaml',
		envFilePath: data.envFilePath || null,
		autoUpdate: data.autoUpdate || false,
		autoUpdateSchedule: data.autoUpdateSchedule || 'daily',
		autoUpdateCron: data.autoUpdateCron || '0 3 * * *',
		webhookEnabled: data.webhookEnabled || false,
		webhookSecret: data.webhookSecret || null
	}).returning();
	return getGitStack(result[0].id) as Promise<GitStackWithRepo>;
}

export async function updateGitStack(id: number, data: Partial<GitStackData>): Promise<GitStackWithRepo | null> {
	const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };

	if (data.stackName !== undefined) updateData.stackName = data.stackName;
	if (data.repositoryId !== undefined) updateData.repositoryId = data.repositoryId;
	if (data.composePath !== undefined) updateData.composePath = data.composePath;
	if (data.envFilePath !== undefined) updateData.envFilePath = data.envFilePath;
	if (data.autoUpdate !== undefined) updateData.autoUpdate = data.autoUpdate;
	if (data.autoUpdateSchedule !== undefined) updateData.autoUpdateSchedule = data.autoUpdateSchedule;
	if (data.autoUpdateCron !== undefined) updateData.autoUpdateCron = data.autoUpdateCron;
	if (data.webhookEnabled !== undefined) updateData.webhookEnabled = data.webhookEnabled;
	if (data.webhookSecret !== undefined) updateData.webhookSecret = data.webhookSecret;
	if (data.lastSync !== undefined) updateData.lastSync = data.lastSync;
	if (data.lastCommit !== undefined) updateData.lastCommit = data.lastCommit;
	if (data.syncStatus !== undefined) updateData.syncStatus = data.syncStatus;
	if (data.syncError !== undefined) updateData.syncError = data.syncError;

	await db.update(gitStacks).set(updateData).where(eq(gitStacks.id, id));
	return getGitStack(id);
}

export async function deleteGitStack(id: number): Promise<boolean> {
	await db.delete(gitStacks).where(eq(gitStacks.id, id));
	return true;
}

export async function renameGitStack(id: number, newName: string): Promise<boolean> {
	await db.update(gitStacks)
		.set({ stackName: newName, updatedAt: new Date().toISOString() })
		.where(eq(gitStacks.id, id));
	return true;
}

export async function getEnabledAutoUpdateGitStacks(): Promise<GitStackWithRepo[]> {
	const rows = await db.select({
		id: gitStacks.id,
		stackName: gitStacks.stackName,
		environmentId: gitStacks.environmentId,
		repositoryId: gitStacks.repositoryId,
		composePath: gitStacks.composePath,
		envFilePath: gitStacks.envFilePath,
		autoUpdate: gitStacks.autoUpdate,
		autoUpdateSchedule: gitStacks.autoUpdateSchedule,
		autoUpdateCron: gitStacks.autoUpdateCron,
		webhookEnabled: gitStacks.webhookEnabled,
		webhookSecret: gitStacks.webhookSecret,
		lastSync: gitStacks.lastSync,
		lastCommit: gitStacks.lastCommit,
		syncStatus: gitStacks.syncStatus,
		syncError: gitStacks.syncError,
		createdAt: gitStacks.createdAt,
		updatedAt: gitStacks.updatedAt,
		repoName: gitRepositories.name,
		repoUrl: gitRepositories.url,
		repoBranch: gitRepositories.branch,
		repoCredentialId: gitRepositories.credentialId
	})
		.from(gitStacks)
		.innerJoin(gitRepositories, eq(gitStacks.repositoryId, gitRepositories.id))
		.where(eq(gitStacks.autoUpdate, true));

	return rows.map(row => ({
		id: row.id,
		stackName: row.stackName,
		environmentId: row.environmentId,
		repositoryId: row.repositoryId,
		composePath: row.composePath,
		envFilePath: row.envFilePath,
		autoUpdate: row.autoUpdate,
		autoUpdateSchedule: row.autoUpdateSchedule,
		autoUpdateCron: row.autoUpdateCron,
		webhookEnabled: row.webhookEnabled,
		webhookSecret: row.webhookSecret,
		lastSync: row.lastSync,
		lastCommit: row.lastCommit,
		syncStatus: row.syncStatus,
		syncError: row.syncError,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		repository: {
			id: row.repositoryId,
			name: row.repoName,
			url: row.repoUrl,
			branch: row.repoBranch,
			credentialId: row.repoCredentialId
		}
	})) as GitStackWithRepo[];
}

export async function getAllAutoUpdateGitStacks(): Promise<GitStackWithRepo[]> {
	const rows = await db.select({
		id: gitStacks.id,
		stackName: gitStacks.stackName,
		environmentId: gitStacks.environmentId,
		repositoryId: gitStacks.repositoryId,
		composePath: gitStacks.composePath,
		autoUpdate: gitStacks.autoUpdate,
		autoUpdateSchedule: gitStacks.autoUpdateSchedule,
		autoUpdateCron: gitStacks.autoUpdateCron,
		webhookEnabled: gitStacks.webhookEnabled,
		webhookSecret: gitStacks.webhookSecret,
		lastSync: gitStacks.lastSync,
		lastCommit: gitStacks.lastCommit,
		syncStatus: gitStacks.syncStatus,
		syncError: gitStacks.syncError,
		createdAt: gitStacks.createdAt,
		updatedAt: gitStacks.updatedAt,
		repoName: gitRepositories.name,
		repoUrl: gitRepositories.url,
		repoBranch: gitRepositories.branch,
		repoCredentialId: gitRepositories.credentialId
	})
		.from(gitStacks)
		.innerJoin(gitRepositories, eq(gitStacks.repositoryId, gitRepositories.id))
		.where(eq(gitStacks.autoUpdate, true));

	return rows.map(row => ({
		id: row.id,
		stackName: row.stackName,
		environmentId: row.environmentId,
		repositoryId: row.repositoryId,
		composePath: row.composePath,
		autoUpdate: row.autoUpdate,
		autoUpdateSchedule: row.autoUpdateSchedule,
		autoUpdateCron: row.autoUpdateCron,
		webhookEnabled: row.webhookEnabled,
		webhookSecret: row.webhookSecret,
		lastSync: row.lastSync,
		lastCommit: row.lastCommit,
		syncStatus: row.syncStatus,
		syncError: row.syncError,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		repository: {
			id: row.repositoryId,
			name: row.repoName,
			url: row.repoUrl,
			branch: row.repoBranch,
			credentialId: row.repoCredentialId
		}
	})) as GitStackWithRepo[];
}

// =============================================================================
// STACK SOURCES OPERATIONS
// =============================================================================

export type StackSourceType = 'external' | 'internal' | 'git';

export interface StackSourceData {
	id: number;
	stackName: string;
	environmentId: number | null;
	sourceType: StackSourceType;
	gitRepositoryId: number | null;
	gitStackId: number | null;
	composePath: string | null;
	envPath: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface StackSourceWithRepo extends StackSourceData {
	repository?: GitRepositoryData | null;
	gitStack?: GitStackWithRepo | null;
}

export async function getStackSource(stackName: string, environmentId?: number | null): Promise<StackSourceWithRepo | null> {
	const results = await db.select().from(stackSources)
		.where(and(
			eq(stackSources.stackName, stackName),
			environmentId !== undefined && environmentId !== null
				? eq(stackSources.environmentId, environmentId)
				: isNull(stackSources.environmentId)
		));

	if (!results[0]) return null;
	const row = results[0];

	let repository = null;
	let gitStackData = null;

	if (row.gitRepositoryId) {
		repository = await getGitRepository(row.gitRepositoryId);
	}
	if (row.gitStackId) {
		gitStackData = await getGitStack(row.gitStackId);
	}

	return {
		...row,
		repository,
		gitStack: gitStackData
	} as StackSourceWithRepo;
}

export async function getStackSourceByComposePath(composePath: string, environmentId?: number | null): Promise<StackSourceWithRepo | null> {
	const envCondition = environmentId !== undefined && environmentId !== null
		? eq(stackSources.environmentId, environmentId)
		: isNull(stackSources.environmentId);

	const results = await db.select().from(stackSources)
		.where(and(eq(stackSources.composePath, composePath), envCondition));

	if (!results[0]) return null;
	const row = results[0];

	let repository = null;
	let gitStackData = null;

	if (row.gitRepositoryId) {
		repository = await getGitRepository(row.gitRepositoryId);
	}
	if (row.gitStackId) {
		gitStackData = await getGitStack(row.gitStackId);
	}

	return {
		...row,
		repository,
		gitStack: gitStackData
	} as StackSourceWithRepo;
}

export async function getStackSources(environmentId?: number | null): Promise<StackSourceWithRepo[]> {
	let results;
	if (environmentId !== undefined && environmentId !== null) {
		// Only get stacks for the specific environment
		results = await db.select().from(stackSources)
			.where(eq(stackSources.environmentId, environmentId))
			.orderBy(asc(stackSources.stackName));
	} else {
		results = await db.select().from(stackSources).orderBy(asc(stackSources.stackName));
	}

	const enrichedResults: StackSourceWithRepo[] = [];
	for (const row of results) {
		let repository = null;
		let gitStackData = null;

		if (row.gitRepositoryId) {
			repository = await getGitRepository(row.gitRepositoryId);
		}
		if (row.gitStackId) {
			gitStackData = await getGitStack(row.gitStackId);
		}

		enrichedResults.push({
			...row,
			repository,
			gitStack: gitStackData
		} as StackSourceWithRepo);
	}

	return enrichedResults;
}

export async function upsertStackSource(data: {
	stackName: string;
	environmentId?: number | null;
	sourceType: StackSourceType;
	gitRepositoryId?: number | null;
	gitStackId?: number | null;
	composePath?: string | null;
	envPath?: string | null;
}): Promise<StackSourceData> {
	const existing = await getStackSource(data.stackName, data.environmentId);

	if (existing) {
		await db.update(stackSources)
			.set({
				sourceType: data.sourceType,
				gitRepositoryId: data.gitRepositoryId || null,
				gitStackId: data.gitStackId || null,
				composePath: data.composePath ?? null,
				envPath: data.envPath ?? null,
				updatedAt: new Date().toISOString()
			})
			.where(eq(stackSources.id, existing.id));
		return getStackSource(data.stackName, data.environmentId) as Promise<StackSourceData>;
	} else {
		await db.insert(stackSources).values({
			stackName: data.stackName,
			environmentId: data.environmentId ?? null,
			sourceType: data.sourceType,
			gitRepositoryId: data.gitRepositoryId || null,
			gitStackId: data.gitStackId || null,
			composePath: data.composePath ?? null,
			envPath: data.envPath ?? null
		});
		return getStackSource(data.stackName, data.environmentId) as Promise<StackSourceData>;
	}
}

export async function updateStackSource(
	stackName: string,
	environmentId: number | null,
	updates: { composePath?: string | null; envPath?: string | null }
): Promise<boolean> {
	const existing = await getStackSource(stackName, environmentId);
	if (!existing) return false;

	await db.update(stackSources)
		.set({
			composePath: updates.composePath !== undefined ? updates.composePath : existing.composePath,
			envPath: updates.envPath !== undefined ? updates.envPath : existing.envPath,
			updatedAt: new Date().toISOString()
		})
		.where(eq(stackSources.id, existing.id));

	return true;
}

export async function deleteStackSource(stackName: string, environmentId?: number | null): Promise<boolean> {
	// Delete matching record (either with specific envId or NULL)
	await db.delete(stackSources)
		.where(and(
			eq(stackSources.stackName, stackName),
			environmentId !== undefined && environmentId !== null
				? eq(stackSources.environmentId, environmentId)
				: isNull(stackSources.environmentId)
		));

	// Also cleanup any orphaned records with NULL environment_id for this stack
	// This handles cases where stacks were created with wrong/missing environment association
	if (environmentId !== undefined && environmentId !== null) {
		await db.delete(stackSources)
			.where(and(
				eq(stackSources.stackName, stackName),
				isNull(stackSources.environmentId)
			));
	}
	return true;
}

export async function updateStackSourceName(
	oldStackName: string,
	newStackName: string,
	environmentId?: number | null
): Promise<boolean> {
	await db.update(stackSources)
		.set({
			stackName: newStackName,
			updatedAt: new Date().toISOString()
		})
		.where(and(
			eq(stackSources.stackName, oldStackName),
			environmentId !== undefined && environmentId !== null
				? eq(stackSources.environmentId, environmentId)
				: isNull(stackSources.environmentId)
		));
	return true;
}

// =============================================================================
// VULNERABILITY SCAN RESULTS
// =============================================================================

export interface VulnerabilityScanData {
	id: number;
	environmentId: number | null;
	imageId: string;
	imageName: string;
	scanner: 'grype' | 'trivy';
	scannedAt: string;
	scanDuration: number;
	criticalCount: number;
	highCount: number;
	mediumCount: number;
	lowCount: number;
	negligibleCount: number;
	unknownCount: number;
	vulnerabilities: any[];
	error: string | null;
	createdAt: string;
}

export async function saveVulnerabilityScan(data: {
	environmentId?: number | null;
	imageId: string;
	imageName: string;
	scanner: 'grype' | 'trivy';
	scannedAt: string;
	scanDuration: number;
	criticalCount: number;
	highCount: number;
	mediumCount: number;
	lowCount: number;
	negligibleCount: number;
	unknownCount: number;
	vulnerabilities: any[];
	error?: string | null;
}): Promise<VulnerabilityScanData> {
	const result = await db.insert(vulnerabilityScans).values({
		environmentId: data.environmentId ?? null,
		imageId: data.imageId,
		imageName: data.imageName,
		scanner: data.scanner,
		scannedAt: data.scannedAt,
		scanDuration: data.scanDuration,
		criticalCount: data.criticalCount,
		highCount: data.highCount,
		mediumCount: data.mediumCount,
		lowCount: data.lowCount,
		negligibleCount: data.negligibleCount,
		unknownCount: data.unknownCount,
		vulnerabilities: JSON.stringify(data.vulnerabilities),
		error: data.error ?? null
	}).returning();
	return getVulnerabilityScan(result[0].id) as Promise<VulnerabilityScanData>;
}

export async function getVulnerabilityScan(id: number): Promise<VulnerabilityScanData | null> {
	const results = await db.select().from(vulnerabilityScans).where(eq(vulnerabilityScans.id, id));
	if (!results[0]) return null;
	return {
		...results[0],
		vulnerabilities: results[0].vulnerabilities ? JSON.parse(results[0].vulnerabilities) : []
	} as VulnerabilityScanData;
}

export async function getLatestScanForImage(
	imageId: string,
	scanner?: string,
	environmentId?: number | null
): Promise<VulnerabilityScanData | null> {
	let conditions = [eq(vulnerabilityScans.imageId, imageId)];

	if (scanner) {
		conditions.push(eq(vulnerabilityScans.scanner, scanner as 'grype' | 'trivy'));
	}

	if (environmentId !== undefined) {
		if (environmentId === null) {
			conditions.push(isNull(vulnerabilityScans.environmentId));
		} else {
			conditions.push(eq(vulnerabilityScans.environmentId, environmentId));
		}
	}

	const results = await db.select().from(vulnerabilityScans)
		.where(and(...conditions))
		.orderBy(desc(vulnerabilityScans.scannedAt))
		.limit(1);

	if (!results[0]) return null;
	return {
		...results[0],
		vulnerabilities: results[0].vulnerabilities ? JSON.parse(results[0].vulnerabilities) : []
	} as VulnerabilityScanData;
}

export async function getScansForImage(imageId: string, limit = 10): Promise<VulnerabilityScanData[]> {
	const results = await db.select().from(vulnerabilityScans)
		.where(eq(vulnerabilityScans.imageId, imageId))
		.orderBy(desc(vulnerabilityScans.scannedAt))
		.limit(limit);

	return results.map(row => ({
		...row,
		vulnerabilities: row.vulnerabilities ? JSON.parse(row.vulnerabilities) : []
	})) as VulnerabilityScanData[];
}

/**
 * Get the combined scan summary for an image across all scanners.
 * When using "both" scanners, this returns the MAX counts per severity
 * from the latest scan of each scanner type.
 */
export async function getCombinedScanForImage(
	imageId: string,
	environmentId?: number | null
): Promise<{ critical: number; high: number; medium: number; low: number; negligible: number; unknown: number } | null> {
	let conditions = [eq(vulnerabilityScans.imageId, imageId)];

	if (environmentId !== undefined) {
		if (environmentId === null) {
			conditions.push(isNull(vulnerabilityScans.environmentId));
		} else {
			conditions.push(eq(vulnerabilityScans.environmentId, environmentId));
		}
	}

	// Get all scans for this image (we'll group by scanner in JS)
	const results = await db.select().from(vulnerabilityScans)
		.where(and(...conditions))
		.orderBy(desc(vulnerabilityScans.scannedAt));

	if (results.length === 0) return null;

	// Get the latest scan for each scanner
	const latestByScanner = new Map<string, typeof results[0]>();
	for (const scan of results) {
		if (!latestByScanner.has(scan.scanner)) {
			latestByScanner.set(scan.scanner, scan);
		}
	}

	// Combine using MAX per severity (same logic as combineScanSummaries)
	let combined = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
	for (const scan of latestByScanner.values()) {
		combined.critical = Math.max(combined.critical, scan.criticalCount ?? 0);
		combined.high = Math.max(combined.high, scan.highCount ?? 0);
		combined.medium = Math.max(combined.medium, scan.mediumCount ?? 0);
		combined.low = Math.max(combined.low, scan.lowCount ?? 0);
		combined.negligible = Math.max(combined.negligible, scan.negligibleCount ?? 0);
		combined.unknown = Math.max(combined.unknown, scan.unknownCount ?? 0);
	}

	return combined;
}

export async function getAllLatestScans(environmentId?: number | null): Promise<VulnerabilityScanData[]> {
	// This complex query requires raw SQL or multiple queries
	// For simplicity, we'll fetch all and filter in JS
	let results;
	if (environmentId !== undefined) {
		if (environmentId === null) {
			results = await db.select().from(vulnerabilityScans)
				.where(isNull(vulnerabilityScans.environmentId))
				.orderBy(desc(vulnerabilityScans.scannedAt));
		} else {
			results = await db.select().from(vulnerabilityScans)
				.where(eq(vulnerabilityScans.environmentId, environmentId))
				.orderBy(desc(vulnerabilityScans.scannedAt));
		}
	} else {
		results = await db.select().from(vulnerabilityScans)
			.orderBy(desc(vulnerabilityScans.scannedAt));
	}

	// Group by imageId + scanner and take latest
	const latestMap = new Map<string, typeof results[0]>();
	for (const row of results) {
		const key = `${row.imageId}:${row.scanner}`;
		if (!latestMap.has(key)) {
			latestMap.set(key, row);
		}
	}

	return Array.from(latestMap.values()).map(row => ({
		...row,
		vulnerabilities: row.vulnerabilities ? JSON.parse(row.vulnerabilities) : []
	})) as VulnerabilityScanData[];
}

export async function deleteOldScans(keepDays = 30): Promise<number> {
	const cutoffDate = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
	await db.delete(vulnerabilityScans)
		.where(sql`scanned_at < ${cutoffDate}`);
	return 0;
}

// =============================================================================
// AUDIT LOGGING (Enterprise Feature)
// =============================================================================

export type AuditAction =
	| 'create' | 'update' | 'delete' | 'start' | 'stop' | 'restart' | 'down'
	| 'pause' | 'unpause' | 'pull' | 'push' | 'prune' | 'login'
	| 'logout' | 'view' | 'exec' | 'connect' | 'disconnect' | 'deploy' | 'sync' | 'rename' | 'webhook';

export type AuditEntityType =
	| 'container' | 'image' | 'stack' | 'volume' | 'network'
	| 'user' | 'role' | 'settings' | 'environment' | 'registry' | 'git_repository' | 'git_credential'
	| 'config_set' | 'notification' | 'oidc_provider' | 'ldap_config' | 'git_stack';

export interface AuditLogData {
	id: number;
	userId: number | null;
	username: string;
	action: AuditAction;
	entityType: AuditEntityType;
	entityId: string | null;
	entityName: string | null;
	environmentId: number | null;
	description: string | null;
	details: any | null;
	ipAddress: string | null;
	userAgent: string | null;
	createdAt: string;
}

export interface AuditLogCreateData {
	userId?: number | null;
	username: string;
	action: AuditAction;
	entityType: AuditEntityType;
	entityId?: string | null;
	entityName?: string | null;
	environmentId?: number | null;
	description?: string | null;
	details?: any | null;
	ipAddress?: string | null;
	userAgent?: string | null;
}

export interface AuditLogFilters {
	username?: string;
	usernames?: string[];
	entityType?: AuditEntityType;
	entityTypes?: AuditEntityType[];
	action?: AuditAction;
	actions?: AuditAction[];
	environmentId?: number;
	labels?: string[];  // Filter by environment labels (audit entries from envs with ANY of these labels)
	fromDate?: string;
	toDate?: string;
	limit?: number;
	offset?: number;
}

export interface AuditLogResult {
	logs: AuditLogData[];
	total: number;
	limit: number;
	offset: number;
}

export async function logAuditEvent(data: AuditLogCreateData): Promise<AuditLogData> {
	const result = await db.insert(auditLogs).values({
		userId: data.userId ?? null,
		username: data.username,
		action: data.action,
		entityType: data.entityType,
		entityId: data.entityId ?? null,
		entityName: data.entityName ?? null,
		environmentId: data.environmentId ?? null,
		description: data.description ?? null,
		details: data.details ? JSON.stringify(data.details) : null,
		ipAddress: data.ipAddress ?? null,
		userAgent: data.userAgent ?? null
	}).returning();

	const auditLog = await getAuditLog(result[0].id);

	// Broadcast the new audit event to connected SSE clients
	try {
		const { broadcastAuditEvent } = await import('./audit-events.js');
		broadcastAuditEvent(auditLog!);
	} catch (e) {
		// Ignore broadcast errors
	}

	return auditLog!;
}

export async function getAuditLog(id: number): Promise<(AuditLogData & { environmentName?: string | null; environmentIcon?: string | null }) | undefined> {
	const results = await db.select({
		id: auditLogs.id,
		userId: auditLogs.userId,
		username: auditLogs.username,
		action: auditLogs.action,
		entityType: auditLogs.entityType,
		entityId: auditLogs.entityId,
		entityName: auditLogs.entityName,
		environmentId: auditLogs.environmentId,
		description: auditLogs.description,
		details: auditLogs.details,
		ipAddress: auditLogs.ipAddress,
		userAgent: auditLogs.userAgent,
		createdAt: auditLogs.createdAt,
		environmentName: environments.name,
		environmentIcon: environments.icon
	})
		.from(auditLogs)
		.leftJoin(environments, eq(auditLogs.environmentId, environments.id))
		.where(eq(auditLogs.id, id));
	if (!results[0]) return undefined;
	return {
		...results[0],
		details: results[0].details ? JSON.parse(results[0].details) : null
	} as AuditLogData & { environmentName?: string | null; environmentIcon?: string | null };
}

export async function getAuditLogs(filters: AuditLogFilters = {}): Promise<AuditLogResult> {
	let conditions: any[] = [];

	// Labels filter - find environments with matching labels first
	let labelFilteredEnvIds: number[] | undefined;
	if (filters.labels && filters.labels.length > 0) {
		// Get environments that have ANY of the specified labels
		const allEnvs = await db.select({ id: environments.id, labels: environments.labels }).from(environments);
		labelFilteredEnvIds = allEnvs
			.filter(env => {
				if (!env.labels) return false;
				try {
					const envLabels = JSON.parse(env.labels) as string[];
					return filters.labels!.some(label => envLabels.includes(label));
				} catch {
					return false;
				}
			})
			.map(env => env.id);

		// If no environments match the labels, return empty result
		if (labelFilteredEnvIds.length === 0) {
			return { logs: [], total: 0, limit: filters.limit || 50, offset: filters.offset || 0 };
		}
	}

	if (filters.usernames && filters.usernames.length > 0) {
		conditions.push(inArray(auditLogs.username, filters.usernames));
	} else if (filters.username) {
		conditions.push(eq(auditLogs.username, filters.username));
	}

	if (filters.entityTypes && filters.entityTypes.length > 0) {
		conditions.push(inArray(auditLogs.entityType, filters.entityTypes));
	} else if (filters.entityType) {
		conditions.push(eq(auditLogs.entityType, filters.entityType));
	}

	if (filters.actions && filters.actions.length > 0) {
		conditions.push(inArray(auditLogs.action, filters.actions));
	} else if (filters.action) {
		conditions.push(eq(auditLogs.action, filters.action));
	}

	if (filters.environmentId !== undefined && filters.environmentId !== null) {
		// If we also have label filtering, verify this environment has matching labels
		if (labelFilteredEnvIds && !labelFilteredEnvIds.includes(filters.environmentId)) {
			return { logs: [], total: 0, limit: filters.limit || 50, offset: filters.offset || 0 };
		}
		conditions.push(eq(auditLogs.environmentId, filters.environmentId));
	} else if (labelFilteredEnvIds) {
		// Only label filter (no specific environment filter)
		conditions.push(inArray(auditLogs.environmentId, labelFilteredEnvIds));
	}

	if (filters.fromDate) {
		conditions.push(sql`${auditLogs.createdAt} >= ${filters.fromDate}`);
	}

	if (filters.toDate) {
		conditions.push(sql`${auditLogs.createdAt} <= ${filters.toDate}`);
	}

	const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

	// Get total count
	const countResult = await db.select({ count: sql<number>`count(*)` }).from(auditLogs)
		.where(whereClause);
	const total = Number(countResult[0]?.count) || 0;

	// Get paginated results
	const limit = filters.limit || 50;
	const offset = filters.offset || 0;

	const rows = await db.select({
		id: auditLogs.id,
		userId: auditLogs.userId,
		username: auditLogs.username,
		action: auditLogs.action,
		entityType: auditLogs.entityType,
		entityId: auditLogs.entityId,
		entityName: auditLogs.entityName,
		environmentId: auditLogs.environmentId,
		description: auditLogs.description,
		details: auditLogs.details,
		ipAddress: auditLogs.ipAddress,
		userAgent: auditLogs.userAgent,
		createdAt: auditLogs.createdAt,
		environmentName: environments.name,
		environmentIcon: environments.icon
	})
		.from(auditLogs)
		.leftJoin(environments, eq(auditLogs.environmentId, environments.id))
		.where(whereClause)
		.orderBy(desc(auditLogs.createdAt))
		.limit(limit)
		.offset(offset);

	const logs = rows.map(row => ({
		...row,
		details: row.details ? JSON.parse(row.details) : null,
		timestamp: row.createdAt
	})) as AuditLogData[];

	return { logs, total, limit, offset };
}

export async function getAuditLogUsers(): Promise<string[]> {
	const results = await db.selectDistinct({ username: auditLogs.username }).from(auditLogs).orderBy(asc(auditLogs.username));
	return results.map(row => row.username);
}

export async function deleteOldAuditLogs(keepDays = 90): Promise<number> {
	const cutoffDate = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
	await db.delete(auditLogs)
		.where(sql`created_at < ${cutoffDate}`);
	return 0;
}

// =============================================================================
// CONTAINER ACTIVITY (Docker Events) - Free Feature
// =============================================================================

export type ContainerEventAction =
	| 'create' | 'start' | 'stop' | 'die' | 'kill' | 'restart'
	| 'pause' | 'unpause' | 'destroy' | 'rename' | 'update'
	| 'attach' | 'detach' | 'exec_create' | 'exec_start' | 'exec_die'
	| 'health_status' | 'oom';

export interface ContainerEventData {
	id: number;
	environmentId: number | null;
	containerId: string;
	containerName: string | null;
	image: string | null;
	action: ContainerEventAction;
	actorAttributes: Record<string, string> | null;
	timestamp: string;
	createdAt: string;
}

export interface ContainerEventCreateData {
	environmentId?: number | null;
	containerId: string;
	containerName?: string | null;
	image?: string | null;
	action: ContainerEventAction;
	actorAttributes?: Record<string, string> | null;
	timestamp: string; // ISO string with nanosecond precision for proper event ordering
}

export interface ContainerEventFilters {
	environmentId?: number | null;
	environmentIds?: number[];  // Filter by multiple environments (for permission filtering)
	labels?: string[];  // Filter by environment labels (events from envs with ANY of these labels)
	containerId?: string;
	containerName?: string;
	actions?: ContainerEventAction[];
	fromDate?: string;
	toDate?: string;
	limit?: number;
	offset?: number;
}

export interface ContainerEventResult {
	events: ContainerEventData[];
	total: number;
	limit: number;
	offset: number;
}

export async function logContainerEvent(data: ContainerEventCreateData): Promise<ContainerEventData> {
	// Timestamp is already an ISO-8601 string from event-subprocess
	// Both SQLite and PostgreSQL schemas use mode: 'string' so we pass it directly
	const result = await db.insert(containerEvents).values({
		environmentId: data.environmentId ?? null,
		containerId: data.containerId,
		containerName: data.containerName ?? null,
		image: data.image ?? null,
		action: data.action,
		actorAttributes: data.actorAttributes ? JSON.stringify(data.actorAttributes) : null,
		timestamp: data.timestamp
	}).returning();

	return getContainerEvent(result[0].id) as Promise<ContainerEventData>;
}

export async function getContainerEvent(id: number): Promise<ContainerEventData | undefined> {
	const rows = await db.select({
		id: containerEvents.id,
		environmentId: containerEvents.environmentId,
		containerId: containerEvents.containerId,
		containerName: containerEvents.containerName,
		image: containerEvents.image,
		action: containerEvents.action,
		actorAttributes: containerEvents.actorAttributes,
		timestamp: containerEvents.timestamp,
		createdAt: containerEvents.createdAt,
		environmentName: environments.name,
		environmentIcon: environments.icon
	})
		.from(containerEvents)
		.leftJoin(environments, eq(containerEvents.environmentId, environments.id))
		.where(eq(containerEvents.id, id));

	if (!rows[0]) return undefined;
	return {
		...rows[0],
		actorAttributes: rows[0].actorAttributes ? JSON.parse(rows[0].actorAttributes) : null
	} as ContainerEventData;
}

export async function getContainerEvents(filters: ContainerEventFilters = {}): Promise<ContainerEventResult> {
	let conditions: any[] = [];

	// Labels filter - find environments with matching labels first
	let labelFilteredEnvIds: number[] | undefined;
	if (filters.labels && filters.labels.length > 0) {
		// Get environments that have ANY of the specified labels
		const allEnvs = await db.select({ id: environments.id, labels: environments.labels }).from(environments);
		labelFilteredEnvIds = allEnvs
			.filter(env => {
				if (!env.labels) return false;
				try {
					const envLabels = JSON.parse(env.labels) as string[];
					return filters.labels!.some(label => envLabels.includes(label));
				} catch {
					return false;
				}
			})
			.map(env => env.id);

		// If no environments match the labels, return empty result
		if (labelFilteredEnvIds.length === 0) {
			return { events: [], total: 0, limit: filters.limit || 100, offset: filters.offset || 0 };
		}
	}

	// Single environment filter takes precedence
	if (filters.environmentId !== undefined && filters.environmentId !== null) {
		conditions.push(eq(containerEvents.environmentId, filters.environmentId));
	} else if (filters.environmentIds && filters.environmentIds.length > 0) {
		// Multiple environments filter (for permission-based filtering)
		// If we also have label filtering, intersect the two sets
		if (labelFilteredEnvIds) {
			const intersected = filters.environmentIds.filter(id => labelFilteredEnvIds!.includes(id));
			if (intersected.length === 0) {
				return { events: [], total: 0, limit: filters.limit || 100, offset: filters.offset || 0 };
			}
			conditions.push(inArray(containerEvents.environmentId, intersected));
		} else {
			conditions.push(inArray(containerEvents.environmentId, filters.environmentIds));
		}
	} else if (labelFilteredEnvIds) {
		// Only label filter (no environment filter)
		conditions.push(inArray(containerEvents.environmentId, labelFilteredEnvIds));
	}

	if (filters.containerId) {
		conditions.push(eq(containerEvents.containerId, filters.containerId));
	}

	if (filters.containerName) {
		conditions.push(like(containerEvents.containerName, `%${filters.containerName}%`));
	}

	if (filters.actions && filters.actions.length > 0) {
		conditions.push(inArray(containerEvents.action, filters.actions));
	}

	if (filters.fromDate) {
		conditions.push(sql`${containerEvents.timestamp} >= ${filters.fromDate}`);
	}

	if (filters.toDate) {
		conditions.push(sql`${containerEvents.timestamp} <= ${filters.toDate}`);
	}

	const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

	// Get total count
	const countResult = await db.select({ count: sql<number>`count(*)` }).from(containerEvents)
		.where(whereClause);
	const total = Number(countResult[0]?.count) || 0;

	// Get paginated results
	const limit = filters.limit || 100;
	const offset = filters.offset || 0;

	const rows = await db.select({
		id: containerEvents.id,
		environmentId: containerEvents.environmentId,
		containerId: containerEvents.containerId,
		containerName: containerEvents.containerName,
		image: containerEvents.image,
		action: containerEvents.action,
		actorAttributes: containerEvents.actorAttributes,
		timestamp: containerEvents.timestamp,
		createdAt: containerEvents.createdAt,
		environmentName: environments.name,
		environmentIcon: environments.icon
	})
		.from(containerEvents)
		.leftJoin(environments, eq(containerEvents.environmentId, environments.id))
		.where(whereClause)
		.orderBy(desc(containerEvents.timestamp))
		.limit(limit)
		.offset(offset);

	const events = rows.map(row => ({
		...row,
		actorAttributes: row.actorAttributes ? JSON.parse(row.actorAttributes) : null
	})) as ContainerEventData[];

	return { events, total, limit, offset };
}

export async function getContainerEventContainers(environmentId?: number | null, environmentIds?: number[]): Promise<string[]> {
	let whereClause;
	if (environmentId !== undefined && environmentId !== null) {
		whereClause = and(isNotNull(containerEvents.containerName), eq(containerEvents.environmentId, environmentId));
	} else if (environmentIds && environmentIds.length > 0) {
		whereClause = and(isNotNull(containerEvents.containerName), inArray(containerEvents.environmentId, environmentIds));
	} else {
		whereClause = isNotNull(containerEvents.containerName);
	}

	const results = await db.selectDistinct({ containerName: containerEvents.containerName })
		.from(containerEvents)
		.where(whereClause)
		.orderBy(asc(containerEvents.containerName));

	return results.map(row => row.containerName!).filter(Boolean);
}

export async function getContainerEventActions(): Promise<string[]> {
	const results = await db.selectDistinct({ action: containerEvents.action })
		.from(containerEvents)
		.orderBy(asc(containerEvents.action));

	return results.map(row => row.action);
}

export async function deleteOldContainerEvents(keepDays = 30): Promise<number> {
	const cutoffDate = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
	await db.delete(containerEvents)
		.where(sql`timestamp < ${cutoffDate}`);
	return 0;
}

/**
 * Run volume helper cleanup (wrapper for scheduler).
 * Dynamically imports docker.ts to avoid circular dependencies.
 */
export async function runVolumeHelperCleanup(): Promise<void> {
	const { cleanupStaleVolumeHelpers, cleanupExpiredVolumeHelpers } = await import('./docker');
	await cleanupStaleVolumeHelpers();
	await cleanupExpiredVolumeHelpers();
}

export async function clearContainerEvents(): Promise<void> {
	await db.delete(containerEvents);
}

export async function getContainerEventStats(environmentId?: number | null, environmentIds?: number[]): Promise<{
	total: number;
	today: number;
	byAction: Record<string, number>;
}> {
	let baseConditions: any[] = [];
	if (environmentId !== undefined && environmentId !== null) {
		baseConditions.push(eq(containerEvents.environmentId, environmentId));
	} else if (environmentIds && environmentIds.length > 0) {
		baseConditions.push(inArray(containerEvents.environmentId, environmentIds));
	}

	const baseWhere = baseConditions.length > 0 ? and(...baseConditions) : undefined;

	// Total count
	const totalResult = await db.select({ count: sql<number>`count(*)` })
		.from(containerEvents)
		.where(baseWhere);

	// Today's count - use start of today in ISO format
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const todayConditions = [...baseConditions, sql`timestamp >= ${todayStart.toISOString()}`];
	const todayResult = await db.select({ count: sql<number>`count(*)` })
		.from(containerEvents)
		.where(and(...todayConditions));

	// Count by action
	const actionResults = await db.select({
		action: containerEvents.action,
		count: sql<number>`count(*)`
	})
		.from(containerEvents)
		.where(baseWhere)
		.groupBy(containerEvents.action);

	const byAction: Record<string, number> = {};
	for (const row of actionResults) {
		byAction[row.action] = Number(row.count) || 0;
	}

	return {
		total: Number(totalResult[0]?.count) || 0,
		today: Number(todayResult[0]?.count) || 0,
		byAction
	};
}

// =============================================================================
// DASHBOARD PREFERENCES
// =============================================================================

export interface GridItem {
	id: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

// =============================================================================
// USER PREFERENCES OPERATIONS (unified key-value store)
// =============================================================================

export interface UserPreferenceIdentifier {
	userId?: number | null; // NULL = shared (free edition)
	environmentId?: number | null; // NULL = global preference
	key: string;
}

/**
 * Get a user preference value
 */
export async function getUserPreference<T>(
	identifier: UserPreferenceIdentifier
): Promise<T | null> {
	const { userId, environmentId, key } = identifier;

	let query = db.select().from(userPreferences).where(eq(userPreferences.key, key));

	if (userId) {
		query = query.where(eq(userPreferences.userId, userId));
	} else {
		query = query.where(isNull(userPreferences.userId));
	}

	if (environmentId) {
		query = query.where(eq(userPreferences.environmentId, environmentId));
	} else {
		query = query.where(isNull(userPreferences.environmentId));
	}

	const results = await query;
	if (!results[0]) return null;

	try {
		return JSON.parse(results[0].value) as T;
	} catch {
		return results[0].value as T;
	}
}

/**
 * Set a user preference value (upsert)
 */
export async function setUserPreference<T>(
	identifier: UserPreferenceIdentifier,
	value: T
): Promise<void> {
	const { userId, environmentId, key } = identifier;
	const jsonValue = JSON.stringify(value);
	const now = new Date().toISOString();

	// Check if exists
	const existing = await getUserPreference(identifier);

	if (existing !== null) {
		// Update
		let updateQuery = db.update(userPreferences)
			.set({ value: jsonValue, updatedAt: now })
			.where(eq(userPreferences.key, key));

		if (userId) {
			updateQuery = updateQuery.where(eq(userPreferences.userId, userId));
		} else {
			updateQuery = updateQuery.where(isNull(userPreferences.userId));
		}

		if (environmentId) {
			updateQuery = updateQuery.where(eq(userPreferences.environmentId, environmentId));
		} else {
			updateQuery = updateQuery.where(isNull(userPreferences.environmentId));
		}

		await updateQuery;
	} else {
		// Insert
		await db.insert(userPreferences).values({
			userId: userId ?? null,
			environmentId: environmentId ?? null,
			key,
			value: jsonValue
		});
	}
}

/**
 * Delete a user preference
 */
export async function deleteUserPreference(
	identifier: UserPreferenceIdentifier
): Promise<void> {
	const { userId, environmentId, key } = identifier;

	let query = db.delete(userPreferences).where(eq(userPreferences.key, key));

	if (userId) {
		query = query.where(eq(userPreferences.userId, userId));
	} else {
		query = query.where(isNull(userPreferences.userId));
	}

	if (environmentId) {
		query = query.where(eq(userPreferences.environmentId, environmentId));
	} else {
		query = query.where(isNull(userPreferences.environmentId));
	}

	await query;
}

// =============================================================================
// DASHBOARD PREFERENCES (uses unified userPreferences table)
// =============================================================================

export interface DashboardPreferencesData {
	userId: number | null;
	gridLayout: GridItem[];
}

const DASHBOARD_LAYOUT_KEY = 'dashboard_layout';

export async function getDashboardPreferences(userId?: number | null): Promise<DashboardPreferencesData | null> {
	const gridLayout = await getUserPreference<GridItem[]>({
		userId,
		environmentId: null,
		key: DASHBOARD_LAYOUT_KEY
	});

	if (!gridLayout) return null;

	return {
		userId: userId ?? null,
		gridLayout
	};
}

export async function saveDashboardPreferences(data: {
	userId?: number | null;
	gridLayout: GridItem[];
}): Promise<DashboardPreferencesData> {
	await setUserPreference(
		{ userId: data.userId, environmentId: null, key: DASHBOARD_LAYOUT_KEY },
		data.gridLayout
	);

	return {
		userId: data.userId ?? null,
		gridLayout: data.gridLayout
	};
}

// =============================================================================
// SCHEDULE EXECUTION OPERATIONS
// =============================================================================

export type ScheduleType = 'container_update' | 'git_stack_sync' | 'system_cleanup' | 'env_update_check';
export type ScheduleTrigger = 'cron' | 'webhook' | 'manual' | 'startup';
export type ScheduleStatus = 'queued' | 'running' | 'success' | 'failed' | 'skipped';

export interface ScheduleExecutionData {
	id: number;
	scheduleType: ScheduleType;
	scheduleId: number;
	environmentId: number | null;
	entityName: string;
	triggeredBy: ScheduleTrigger;
	triggeredAt: string;
	startedAt: string | null;
	completedAt: string | null;
	duration: number | null;
	status: ScheduleStatus;
	errorMessage: string | null;
	details: any | null;
	logs: string | null;
	createdAt: string | null;
}

export interface ScheduleExecutionCreateData {
	scheduleType: ScheduleType;
	scheduleId: number;
	environmentId?: number | null;
	entityName: string;
	triggeredBy: ScheduleTrigger;
	status?: ScheduleStatus;
	details?: any;
}

export interface ScheduleExecutionUpdateData {
	status?: ScheduleStatus;
	startedAt?: string;
	completedAt?: string;
	duration?: number;
	errorMessage?: string | null;
	details?: any;
	logs?: string;
}

export interface ScheduleExecutionFilters {
	scheduleType?: ScheduleType;
	scheduleId?: number;
	environmentId?: number | null;
	status?: ScheduleStatus;
	statuses?: ScheduleStatus[];
	triggeredBy?: ScheduleTrigger;
	fromDate?: string;
	toDate?: string;
	limit?: number;
	offset?: number;
}

export interface ScheduleExecutionResult {
	executions: ScheduleExecutionData[];
	total: number;
	limit: number;
	offset: number;
}

export async function createScheduleExecution(data: ScheduleExecutionCreateData): Promise<ScheduleExecutionData> {
	const now = new Date().toISOString();
	const result = await db.insert(scheduleExecutions).values({
		scheduleType: data.scheduleType,
		scheduleId: data.scheduleId,
		environmentId: data.environmentId ?? null,
		entityName: data.entityName,
		triggeredBy: data.triggeredBy,
		triggeredAt: now,
		status: data.status || 'queued',
		details: data.details ? JSON.stringify(data.details) : null
	}).returning();

	return {
		...result[0],
		details: data.details || null
	} as ScheduleExecutionData;
}

export async function updateScheduleExecution(id: number, data: ScheduleExecutionUpdateData): Promise<ScheduleExecutionData | undefined> {
	const updateData: Record<string, any> = {};

	if (data.status !== undefined) updateData.status = data.status;
	if (data.startedAt !== undefined) updateData.startedAt = data.startedAt;
	if (data.completedAt !== undefined) updateData.completedAt = data.completedAt;
	if (data.duration !== undefined) updateData.duration = data.duration;
	if (data.errorMessage !== undefined) updateData.errorMessage = data.errorMessage;
	if (data.details !== undefined) updateData.details = JSON.stringify(data.details);
	if (data.logs !== undefined) updateData.logs = data.logs;

	await db.update(scheduleExecutions).set(updateData).where(eq(scheduleExecutions.id, id));
	return getScheduleExecution(id);
}

export async function appendScheduleExecutionLog(id: number, logLine: string): Promise<void> {
	const execution = await getScheduleExecution(id);
	if (!execution) return;

	const newLogs = execution.logs ? execution.logs + '\n' + logLine : logLine;
	await db.update(scheduleExecutions).set({ logs: newLogs }).where(eq(scheduleExecutions.id, id));
}

export async function getScheduleExecution(id: number): Promise<ScheduleExecutionData | undefined> {
	const results = await db.select().from(scheduleExecutions).where(eq(scheduleExecutions.id, id));
	if (!results[0]) return undefined;
	return {
		...results[0],
		details: results[0].details ? JSON.parse(results[0].details) : null
	} as ScheduleExecutionData;
}

export async function deleteScheduleExecution(id: number): Promise<void> {
	await db.delete(scheduleExecutions).where(eq(scheduleExecutions.id, id));
}

export async function getScheduleExecutions(filters: ScheduleExecutionFilters = {}): Promise<ScheduleExecutionResult> {
	const conditions: any[] = [];

	if (filters.scheduleType) {
		conditions.push(eq(scheduleExecutions.scheduleType, filters.scheduleType));
	}
	if (filters.scheduleId !== undefined) {
		conditions.push(eq(scheduleExecutions.scheduleId, filters.scheduleId));
	}
	if (filters.environmentId !== undefined) {
		if (filters.environmentId === null) {
			conditions.push(isNull(scheduleExecutions.environmentId));
		} else {
			conditions.push(eq(scheduleExecutions.environmentId, filters.environmentId));
		}
	}
	if (filters.status) {
		conditions.push(eq(scheduleExecutions.status, filters.status));
	}
	if (filters.statuses && filters.statuses.length > 0) {
		conditions.push(inArray(scheduleExecutions.status, filters.statuses));
	}
	if (filters.triggeredBy) {
		conditions.push(eq(scheduleExecutions.triggeredBy, filters.triggeredBy));
	}
	if (filters.fromDate) {
		conditions.push(sql`triggered_at >= ${filters.fromDate}`);
	}
	if (filters.toDate) {
		conditions.push(sql`triggered_at <= ${filters.toDate}`);
	}

	const limit = filters.limit || 50;
	const offset = filters.offset || 0;

	// Get total count
	const countResult = await db
		.select({ count: sql<number>`count(*)` })
		.from(scheduleExecutions)
		.where(conditions.length > 0 ? and(...conditions) : undefined);
	const total = Number(countResult[0]?.count || 0);

	// Get paginated results (without full logs for list view)
	const results = await db
		.select({
			id: scheduleExecutions.id,
			scheduleType: scheduleExecutions.scheduleType,
			scheduleId: scheduleExecutions.scheduleId,
			environmentId: scheduleExecutions.environmentId,
			entityName: scheduleExecutions.entityName,
			triggeredBy: scheduleExecutions.triggeredBy,
			triggeredAt: scheduleExecutions.triggeredAt,
			startedAt: scheduleExecutions.startedAt,
			completedAt: scheduleExecutions.completedAt,
			duration: scheduleExecutions.duration,
			status: scheduleExecutions.status,
			errorMessage: scheduleExecutions.errorMessage,
			details: scheduleExecutions.details,
			createdAt: scheduleExecutions.createdAt
		})
		.from(scheduleExecutions)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(scheduleExecutions.triggeredAt))
		.limit(limit)
		.offset(offset);

	return {
		executions: results.map(row => ({
			...row,
			details: row.details ? JSON.parse(row.details) : null,
			logs: null // Don't include logs in list view
		})) as ScheduleExecutionData[],
		total,
		limit,
		offset
	};
}

export async function getLastExecutionForSchedule(
	scheduleType: ScheduleType,
	scheduleId: number
): Promise<ScheduleExecutionData | undefined> {
	const results = await db
		.select()
		.from(scheduleExecutions)
		.where(and(
			eq(scheduleExecutions.scheduleType, scheduleType),
			eq(scheduleExecutions.scheduleId, scheduleId)
		))
		.orderBy(desc(scheduleExecutions.triggeredAt))
		.limit(1);

	if (!results[0]) return undefined;
	return {
		...results[0],
		details: results[0].details ? JSON.parse(results[0].details) : null
	} as ScheduleExecutionData;
}

export async function getRecentExecutionsForSchedule(
	scheduleType: ScheduleType,
	scheduleId: number,
	limit = 5
): Promise<ScheduleExecutionData[]> {
	const results = await db
		.select({
			id: scheduleExecutions.id,
			scheduleType: scheduleExecutions.scheduleType,
			scheduleId: scheduleExecutions.scheduleId,
			environmentId: scheduleExecutions.environmentId,
			entityName: scheduleExecutions.entityName,
			triggeredBy: scheduleExecutions.triggeredBy,
			triggeredAt: scheduleExecutions.triggeredAt,
			startedAt: scheduleExecutions.startedAt,
			completedAt: scheduleExecutions.completedAt,
			duration: scheduleExecutions.duration,
			status: scheduleExecutions.status,
			errorMessage: scheduleExecutions.errorMessage,
			details: scheduleExecutions.details,
			createdAt: scheduleExecutions.createdAt
		})
		.from(scheduleExecutions)
		.where(and(
			eq(scheduleExecutions.scheduleType, scheduleType),
			eq(scheduleExecutions.scheduleId, scheduleId)
		))
		.orderBy(desc(scheduleExecutions.triggeredAt))
		.limit(limit);

	return results.map(row => ({
		...row,
		details: row.details ? JSON.parse(row.details) : null,
		logs: null
	})) as ScheduleExecutionData[];
}

export async function cleanupOldExecutions(retentionDays: number): Promise<number> {
	const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
	const result = await db.delete(scheduleExecutions)
		.where(sql`triggered_at < ${cutoffDate}`);
	return 0; // SQLite/PG don't return count consistently
}

// Settings helpers for retention
const SCHEDULE_RETENTION_KEY = 'schedule_retention_days';
const EVENT_RETENTION_KEY = 'event_retention_days';
const DEFAULT_RETENTION_DAYS = 30;
const SCHEDULE_CLEANUP_CRON_KEY = 'schedule_cleanup_cron';
const EVENT_CLEANUP_CRON_KEY = 'event_cleanup_cron';
const SCHEDULE_CLEANUP_ENABLED_KEY = 'schedule_cleanup_enabled';
const EVENT_CLEANUP_ENABLED_KEY = 'event_cleanup_enabled';
const DEFAULT_SCHEDULE_CLEANUP_CRON = '0 3 * * *'; // Daily at 3 AM
const DEFAULT_EVENT_CLEANUP_CRON = '30 3 * * *'; // Daily at 3:30 AM

export async function getScheduleRetentionDays(): Promise<number> {
	const result = await db.select().from(settings).where(eq(settings.key, SCHEDULE_RETENTION_KEY));
	if (result[0]) {
		return parseInt(result[0].value, 10) || DEFAULT_RETENTION_DAYS;
	}
	return DEFAULT_RETENTION_DAYS;
}

export async function setScheduleRetentionDays(days: number): Promise<void> {
	const existing = await db.select().from(settings).where(eq(settings.key, SCHEDULE_RETENTION_KEY));
	if (existing.length > 0) {
		await db.update(settings)
			.set({ value: String(days), updatedAt: new Date().toISOString() })
			.where(eq(settings.key, SCHEDULE_RETENTION_KEY));
	} else {
		await db.insert(settings).values({
			key: SCHEDULE_RETENTION_KEY,
			value: String(days)
		});
	}
}

export async function getEventRetentionDays(): Promise<number> {
	const result = await db.select().from(settings).where(eq(settings.key, EVENT_RETENTION_KEY));
	if (result[0]) {
		return parseInt(result[0].value, 10) || DEFAULT_RETENTION_DAYS;
	}
	return DEFAULT_RETENTION_DAYS;
}

export async function setEventRetentionDays(days: number): Promise<void> {
	const existing = await db.select().from(settings).where(eq(settings.key, EVENT_RETENTION_KEY));
	if (existing.length > 0) {
		await db.update(settings)
			.set({ value: String(days), updatedAt: new Date().toISOString() })
			.where(eq(settings.key, EVENT_RETENTION_KEY));
	} else {
		await db.insert(settings).values({
			key: EVENT_RETENTION_KEY,
			value: String(days)
		});
	}
}

export async function getScheduleCleanupCron(): Promise<string> {
	const result = await db.select().from(settings).where(eq(settings.key, SCHEDULE_CLEANUP_CRON_KEY));
	if (result[0]) {
		return result[0].value || DEFAULT_SCHEDULE_CLEANUP_CRON;
	}
	return DEFAULT_SCHEDULE_CLEANUP_CRON;
}

export async function setScheduleCleanupCron(cron: string): Promise<void> {
	const existing = await db.select().from(settings).where(eq(settings.key, SCHEDULE_CLEANUP_CRON_KEY));
	if (existing.length > 0) {
		await db.update(settings)
			.set({ value: cron, updatedAt: new Date().toISOString() })
			.where(eq(settings.key, SCHEDULE_CLEANUP_CRON_KEY));
	} else {
		await db.insert(settings).values({
			key: SCHEDULE_CLEANUP_CRON_KEY,
			value: cron
		});
	}
}

export async function getEventCleanupCron(): Promise<string> {
	const result = await db.select().from(settings).where(eq(settings.key, EVENT_CLEANUP_CRON_KEY));
	if (result[0]) {
		return result[0].value || DEFAULT_EVENT_CLEANUP_CRON;
	}
	return DEFAULT_EVENT_CLEANUP_CRON;
}

export async function setEventCleanupCron(cron: string): Promise<void> {
	const existing = await db.select().from(settings).where(eq(settings.key, EVENT_CLEANUP_CRON_KEY));
	if (existing.length > 0) {
		await db.update(settings)
			.set({ value: cron, updatedAt: new Date().toISOString() })
			.where(eq(settings.key, EVENT_CLEANUP_CRON_KEY));
	} else {
		await db.insert(settings).values({
			key: EVENT_CLEANUP_CRON_KEY,
			value: cron
		});
	}
}

export async function getScheduleCleanupEnabled(): Promise<boolean> {
	const result = await db.select().from(settings).where(eq(settings.key, SCHEDULE_CLEANUP_ENABLED_KEY));
	if (result[0]) {
		return result[0].value === 'true';
	}
	return true; // Enabled by default
}

export async function setScheduleCleanupEnabled(enabled: boolean): Promise<void> {
	const existing = await db.select().from(settings).where(eq(settings.key, SCHEDULE_CLEANUP_ENABLED_KEY));
	if (existing.length > 0) {
		await db.update(settings)
			.set({ value: enabled ? 'true' : 'false', updatedAt: new Date().toISOString() })
			.where(eq(settings.key, SCHEDULE_CLEANUP_ENABLED_KEY));
	} else {
		await db.insert(settings).values({
			key: SCHEDULE_CLEANUP_ENABLED_KEY,
			value: enabled ? 'true' : 'false'
		});
	}
}

export async function getEventCleanupEnabled(): Promise<boolean> {
	const result = await db.select().from(settings).where(eq(settings.key, EVENT_CLEANUP_ENABLED_KEY));
	if (result[0]) {
		return result[0].value === 'true';
	}
	return true; // Enabled by default
}

export async function setEventCleanupEnabled(enabled: boolean): Promise<void> {
	const existing = await db.select().from(settings).where(eq(settings.key, EVENT_CLEANUP_ENABLED_KEY));
	if (existing.length > 0) {
		await db.update(settings)
			.set({ value: enabled ? 'true' : 'false', updatedAt: new Date().toISOString() })
			.where(eq(settings.key, EVENT_CLEANUP_ENABLED_KEY));
	} else {
		await db.insert(settings).values({
			key: EVENT_CLEANUP_ENABLED_KEY,
			value: enabled ? 'true' : 'false'
		});
	}
}

// =============================================================================
// EXTERNAL STACK PATHS
// =============================================================================

const EXTERNAL_STACK_PATHS_KEY = 'external_stack_paths';

export async function getExternalStackPaths(): Promise<string[]> {
	const result = await db.select().from(settings).where(eq(settings.key, EXTERNAL_STACK_PATHS_KEY));
	if (result[0]) {
		try {
			const parsed = JSON.parse(result[0].value);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return [];
}

export async function setExternalStackPaths(paths: string[]): Promise<void> {
	const jsonValue = JSON.stringify(paths);
	const existing = await db.select().from(settings).where(eq(settings.key, EXTERNAL_STACK_PATHS_KEY));
	if (existing.length > 0) {
		await db.update(settings)
			.set({ value: jsonValue, updatedAt: new Date().toISOString() })
			.where(eq(settings.key, EXTERNAL_STACK_PATHS_KEY));
	} else {
		await db.insert(settings).values({
			key: EXTERNAL_STACK_PATHS_KEY,
			value: jsonValue
		});
	}
}

// =============================================================================
// PRIMARY STACK LOCATION
// =============================================================================

const PRIMARY_STACK_LOCATION_KEY = 'primary_stack_location';

export async function getPrimaryStackLocation(): Promise<string | null> {
	const result = await db.select().from(settings).where(eq(settings.key, PRIMARY_STACK_LOCATION_KEY));
	if (result[0]?.value) {
		return result[0].value;
	}
	return null;
}

export async function setPrimaryStackLocation(path: string | null): Promise<void> {
	const existing = await db.select().from(settings).where(eq(settings.key, PRIMARY_STACK_LOCATION_KEY));
	if (path === null) {
		// Delete the setting if path is null
		if (existing.length > 0) {
			await db.delete(settings).where(eq(settings.key, PRIMARY_STACK_LOCATION_KEY));
		}
	} else if (existing.length > 0) {
		await db.update(settings)
			.set({ value: path, updatedAt: new Date().toISOString() })
			.where(eq(settings.key, PRIMARY_STACK_LOCATION_KEY));
	} else {
		await db.insert(settings).values({
			key: PRIMARY_STACK_LOCATION_KEY,
			value: path
		});
	}
}

// =============================================================================
// ENVIRONMENT UPDATE CHECK SETTINGS
// =============================================================================

export interface EnvUpdateCheckSettings {
	enabled: boolean;
	cron: string;
	autoUpdate: boolean;
	vulnerabilityCriteria: VulnerabilityCriteria;
}

export async function getEnvUpdateCheckSettings(envId: number): Promise<EnvUpdateCheckSettings | null> {
	const key = `env_${envId}_update_check`;
	const result = await db.select().from(settings).where(eq(settings.key, key));
	if (!result[0]) return null;
	try {
		return JSON.parse(result[0].value);
	} catch {
		return null;
	}
}

export async function setEnvUpdateCheckSettings(envId: number, config: EnvUpdateCheckSettings): Promise<void> {
	const key = `env_${envId}_update_check`;
	const value = JSON.stringify(config);
	const existing = await db.select().from(settings).where(eq(settings.key, key));
	if (existing.length > 0) {
		await db.update(settings)
			.set({ value, updatedAt: new Date().toISOString() })
			.where(eq(settings.key, key));
	} else {
		await db.insert(settings).values({ key, value });
	}
}

export async function deleteEnvUpdateCheckSettings(envId: number): Promise<void> {
	const key = `env_${envId}_update_check`;
	await db.delete(settings).where(eq(settings.key, key));
}

export async function getAllEnvUpdateCheckSettings(): Promise<Array<{ envId: number; settings: EnvUpdateCheckSettings }>> {
	const rows = await db.select().from(settings).where(sql`${settings.key} LIKE 'env_%_update_check'`);
	const results: Array<{ envId: number; settings: EnvUpdateCheckSettings }> = [];
	for (const row of rows) {
		try {
			const match = row.key.match(/^env_(\d+)_update_check$/);
			if (!match) continue;
			const envId = parseInt(match[1]);
			const config = JSON.parse(row.value) as EnvUpdateCheckSettings;
			if (config.enabled) {
				results.push({ envId, settings: config });
			}
		} catch {
			// Skip invalid entries
		}
	}
	return results;
}

// =============================================================================
// IMAGE PRUNE SCHEDULE SETTINGS
// =============================================================================

export interface ImagePruneSettings {
	enabled: boolean;
	cronExpression: string;
	pruneMode: 'dangling' | 'all';
	lastPruned?: string;
	lastResult?: {
		spaceReclaimed: number;
		imagesRemoved: number;
	};
}

export async function getImagePruneSettings(envId: number): Promise<ImagePruneSettings | null> {
	const key = `env_${envId}_image_prune`;
	const result = await db.select().from(settings).where(eq(settings.key, key));
	if (!result[0]) return null;
	try {
		return JSON.parse(result[0].value);
	} catch {
		return null;
	}
}

export async function setImagePruneSettings(envId: number, config: ImagePruneSettings): Promise<void> {
	const key = `env_${envId}_image_prune`;
	const value = JSON.stringify(config);
	const existing = await db.select().from(settings).where(eq(settings.key, key));
	if (existing.length > 0) {
		await db.update(settings)
			.set({ value, updatedAt: new Date().toISOString() })
			.where(eq(settings.key, key));
	} else {
		await db.insert(settings).values({ key, value });
	}
}

export async function deleteImagePruneSettings(envId: number): Promise<void> {
	const key = `env_${envId}_image_prune`;
	await db.delete(settings).where(eq(settings.key, key));
}

export async function getAllImagePruneSettings(): Promise<Array<{ envId: number; settings: ImagePruneSettings }>> {
	const rows = await db.select().from(settings).where(sql`${settings.key} LIKE 'env_%_image_prune'`);
	const results: Array<{ envId: number; settings: ImagePruneSettings }> = [];
	for (const row of rows) {
		try {
			const match = row.key.match(/^env_(\d+)_image_prune$/);
			if (!match) continue;
			const envId = parseInt(match[1]);
			const config = JSON.parse(row.value) as ImagePruneSettings;
			// Return all settings, not just enabled ones (UI needs to show disabled schedules too)
			results.push({ envId, settings: config });
		} catch {
			// Skip invalid entries
		}
	}
	return results;
}

// =============================================================================
// ENVIRONMENT TIMEZONE SETTINGS
// =============================================================================

export async function getEnvironmentTimezone(envId: number): Promise<string> {
	const value = await getSetting(`env_${envId}_timezone`);
	return value || 'UTC';
}

export async function setEnvironmentTimezone(envId: number, timezone: string): Promise<void> {
	await setSetting(`env_${envId}_timezone`, timezone);
}

// =============================================================================
// GLOBAL DEFAULT TIMEZONE
// =============================================================================

/**
 * Get the global default timezone (used as default for new environments).
 * Falls back to 'UTC' if not set.
 */
export async function getDefaultTimezone(): Promise<string> {
	const value = await getSetting('default_timezone');
	return value || 'UTC';
}

/**
 * Set the global default timezone.
 */
export async function setDefaultTimezone(timezone: string): Promise<void> {
	await setSetting('default_timezone', timezone);
}

// =============================================================================
// BACKGROUND MONITORING SETTINGS
// =============================================================================

/**
 * Get event collection mode ('stream' or 'poll').
 * Defaults to 'stream' for real-time event streaming.
 */
export async function getEventCollectionMode(): Promise<'stream' | 'poll'> {
	const value = await getSetting('event_collection_mode');
	return value || 'stream';
}

/**
 * Set event collection mode.
 */
export async function setEventCollectionMode(mode: 'stream' | 'poll'): Promise<void> {
	await setSetting('event_collection_mode', mode);
}

/**
 * Get event poll interval in milliseconds.
 * Defaults to 60000ms (60 seconds).
 */
export async function getEventPollInterval(): Promise<number> {
	const value = await getSetting('event_poll_interval');
	return value || 60000;
}

/**
 * Set event poll interval in milliseconds.
 * Valid range: 30000ms (30s) to 300000ms (5min).
 */
export async function setEventPollInterval(interval: number): Promise<void> {
	if (interval < 30000 || interval > 300000) {
		throw new Error('Event poll interval must be between 30s and 300s');
	}
	await setSetting('event_poll_interval', interval);
}

/**
 * Get metrics collection interval in milliseconds.
 * Defaults to 30000ms (30 seconds) - changed from hardcoded 10s.
 */
export async function getMetricsCollectionInterval(): Promise<number> {
	const value = await getSetting('metrics_collection_interval');
	return value || 30000;
}

/**
 * Set metrics collection interval in milliseconds.
 * Valid range: 10000ms (10s) to 300000ms (5min).
 */
export async function setMetricsCollectionInterval(interval: number): Promise<void> {
	if (interval < 10000 || interval > 300000) {
		throw new Error('Metrics collection interval must be between 10s and 300s');
	}
	await setSetting('metrics_collection_interval', interval);
}

// =============================================================================
// STACK ENVIRONMENT VARIABLES OPERATIONS
// =============================================================================

export interface StackEnvVarData {
	id: number;
	stackName: string;
	environmentId: number | null;
	key: string;
	value: string;
	isSecret: boolean;
	createdAt: string;
	updatedAt: string;
}

/**
 * Get all environment variables for a stack.
 * @param stackName - Name of the stack
 * @param environmentId - Optional environment ID to filter by
 * @param maskSecrets - If true, masks secret values with '***' (default: true)
 */
export async function getStackEnvVars(
	stackName: string,
	environmentId?: number | null,
	maskSecrets: boolean = true
): Promise<StackEnvVarData[]> {
	let results;

	if (environmentId !== undefined) {
		if (environmentId === null) {
			results = await db.select().from(stackEnvironmentVariables)
				.where(and(
					eq(stackEnvironmentVariables.stackName, stackName),
					isNull(stackEnvironmentVariables.environmentId)
				))
				.orderBy(asc(stackEnvironmentVariables.key));
		} else {
			results = await db.select().from(stackEnvironmentVariables)
				.where(and(
					eq(stackEnvironmentVariables.stackName, stackName),
					eq(stackEnvironmentVariables.environmentId, environmentId)
				))
				.orderBy(asc(stackEnvironmentVariables.key));
		}
	} else {
		results = await db.select().from(stackEnvironmentVariables)
			.where(eq(stackEnvironmentVariables.stackName, stackName))
			.orderBy(asc(stackEnvironmentVariables.key));
	}

	return results.map(row => {
		// Decrypt secret values (decrypt handles both encrypted and plain text)
		const decryptedValue = row.isSecret ? (decrypt(row.value) ?? '') : row.value;
		return {
			id: row.id,
			stackName: row.stackName,
			environmentId: row.environmentId,
			key: row.key,
			value: maskSecrets && row.isSecret ? '***' : decryptedValue,
			isSecret: row.isSecret ?? false,
			createdAt: row.createdAt ?? new Date().toISOString(),
			updatedAt: row.updatedAt ?? new Date().toISOString()
		};
	});
}

/**
 * Get stack environment variables as a key-value record (for deployment).
 * Does NOT mask secrets - returns raw values for use in Docker deployment.
 * @param stackName - Name of the stack
 * @param environmentId - Optional environment ID
 */
export async function getStackEnvVarsAsRecord(
	stackName: string,
	environmentId?: number | null
): Promise<Record<string, string>> {
	const vars = await getStackEnvVars(stackName, environmentId, false);
	return Object.fromEntries(vars.map(v => [v.key, v.value]));
}

/**
 * Get only SECRET environment variables as a key-value record (for shell injection).
 * Returns unmasked real values - used to inject secrets via shell environment at runtime.
 * These secrets are NEVER written to .env files on disk.
 * @param stackName - Name of the stack
 * @param environmentId - Optional environment ID
 */
export async function getSecretEnvVarsAsRecord(
	stackName: string,
	environmentId?: number | null
): Promise<Record<string, string>> {
	const vars = await getStackEnvVars(stackName, environmentId, false);
	return Object.fromEntries(
		vars.filter(v => v.isSecret).map(v => [v.key, v.value])
	);
}

/**
 * Get only NON-SECRET environment variables as a key-value record.
 * Used for .env file operations where secrets should be excluded.
 * @param stackName - Name of the stack
 * @param environmentId - Optional environment ID
 */
export async function getNonSecretEnvVarsAsRecord(
	stackName: string,
	environmentId?: number | null
): Promise<Record<string, string>> {
	const vars = await getStackEnvVars(stackName, environmentId, false);
	return Object.fromEntries(
		vars.filter(v => !v.isSecret).map(v => [v.key, v.value])
	);
}

/**
 * Set/replace all environment variables for a stack.
 * Deletes existing vars and inserts new ones in a transaction-like manner.
 * @param stackName - Name of the stack
 * @param environmentId - Optional environment ID
 * @param variables - Array of {key, value, isSecret} objects
 */
export async function setStackEnvVars(
	stackName: string,
	environmentId: number | null,
	variables: Array<{ key: string; value: string; isSecret?: boolean }>
): Promise<void> {
	// Delete existing vars for this stack/environment combo
	if (environmentId === null) {
		await db.delete(stackEnvironmentVariables)
			.where(and(
				eq(stackEnvironmentVariables.stackName, stackName),
				isNull(stackEnvironmentVariables.environmentId)
			));
	} else {
		await db.delete(stackEnvironmentVariables)
			.where(and(
				eq(stackEnvironmentVariables.stackName, stackName),
				eq(stackEnvironmentVariables.environmentId, environmentId)
			));
	}

	// Insert new vars
	if (variables.length > 0) {
		const now = new Date().toISOString();
		await db.insert(stackEnvironmentVariables).values(
			variables.map(v => ({
				stackName,
				environmentId,
				key: v.key,
				// Encrypt values that are marked as secrets
				value: v.isSecret ? (encrypt(v.value) ?? '') : v.value,
				isSecret: v.isSecret ?? false,
				createdAt: now,
				updatedAt: now
			}))
		);
	}
}

/**
 * Get count of environment variables for a stack.
 * @param stackName - Name of the stack
 * @param environmentId - Optional environment ID
 */
export async function getStackEnvVarsCount(
	stackName: string,
	environmentId?: number | null
): Promise<number> {
	const vars = await getStackEnvVars(stackName, environmentId, false);
	return vars.length;
}

/**
 * Delete all environment variables for a stack.
 * @param stackName - Name of the stack
 * @param environmentId - Optional environment ID (null = delete for all envs)
 */
export async function deleteStackEnvVars(
	stackName: string,
	environmentId?: number | null
): Promise<void> {
	if (environmentId === undefined) {
		// Delete all env vars for this stack (all environments)
		await db.delete(stackEnvironmentVariables)
			.where(eq(stackEnvironmentVariables.stackName, stackName));
	} else if (environmentId === null) {
		await db.delete(stackEnvironmentVariables)
			.where(and(
				eq(stackEnvironmentVariables.stackName, stackName),
				isNull(stackEnvironmentVariables.environmentId)
			));
	} else {
		await db.delete(stackEnvironmentVariables)
			.where(and(
				eq(stackEnvironmentVariables.stackName, stackName),
				eq(stackEnvironmentVariables.environmentId, environmentId)
			));
	}
}

/**
 * Update stack name in environment variables (for stack rename operations).
 * @param oldStackName - Current stack name
 * @param newStackName - New stack name
 * @param environmentId - Optional environment ID (null = no environment, undefined = all environments)
 */
export async function updateStackEnvVarsName(
	oldStackName: string,
	newStackName: string,
	environmentId?: number | null
): Promise<void> {
	if (environmentId === undefined) {
		// Update all env vars for this stack (all environments)
		await db.update(stackEnvironmentVariables)
			.set({ stackName: newStackName })
			.where(eq(stackEnvironmentVariables.stackName, oldStackName));
	} else if (environmentId === null) {
		await db.update(stackEnvironmentVariables)
			.set({ stackName: newStackName })
			.where(and(
				eq(stackEnvironmentVariables.stackName, oldStackName),
				isNull(stackEnvironmentVariables.environmentId)
			));
	} else {
		await db.update(stackEnvironmentVariables)
			.set({ stackName: newStackName })
			.where(and(
				eq(stackEnvironmentVariables.stackName, oldStackName),
				eq(stackEnvironmentVariables.environmentId, environmentId)
			));
	}
}

/**
 * Get all stacks with their environment variable counts.
 * Useful for displaying env var badges in the stacks list.
 */
export async function getAllStacksEnvVarsCounts(): Promise<Map<string, number>> {
	const results = await db.select({
		stackName: stackEnvironmentVariables.stackName
	}).from(stackEnvironmentVariables);

	const counts = new Map<string, number>();
	for (const row of results) {
		counts.set(row.stackName, (counts.get(row.stackName) || 0) + 1);
	}
	return counts;
}

// =============================================================================
// PENDING CONTAINER UPDATES OPERATIONS
// =============================================================================

/**
 * Get all pending container updates for an environment.
 */
export async function getPendingContainerUpdates(environmentId: number): Promise<PendingContainerUpdate[]> {
	return await db.select().from(pendingContainerUpdates)
		.where(eq(pendingContainerUpdates.environmentId, environmentId));
}

/**
 * Clear all pending container updates for an environment.
 * Called before checking for updates to ensure fresh state.
 */
export async function clearPendingContainerUpdates(environmentId: number): Promise<void> {
	await db.delete(pendingContainerUpdates)
		.where(eq(pendingContainerUpdates.environmentId, environmentId));
}

/**
 * Add a pending container update.
 * Uses upsert to avoid duplicates.
 */
export async function addPendingContainerUpdate(
	environmentId: number,
	containerId: string,
	containerName: string,
	currentImage: string
): Promise<void> {
	// Use insert with onConflictDoUpdate for upsert behavior
	await db.insert(pendingContainerUpdates)
		.values({
			environmentId,
			containerId,
			containerName,
			currentImage,
			checkedAt: new Date().toISOString()
		})
		.onConflictDoUpdate({
			target: [pendingContainerUpdates.environmentId, pendingContainerUpdates.containerId],
			set: {
				containerName,
				currentImage,
				checkedAt: new Date().toISOString()
			}
		});
}

/**
 * Remove a pending container update (after the container is updated).
 */
export async function removePendingContainerUpdate(environmentId: number, containerId: string): Promise<void> {
	await db.delete(pendingContainerUpdates)
		.where(and(
			eq(pendingContainerUpdates.environmentId, environmentId),
			eq(pendingContainerUpdates.containerId, containerId)
		));
}
