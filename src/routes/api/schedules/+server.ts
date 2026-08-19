/**
 * Schedules API - List all active schedules
 *
 * GET /api/schedules - Returns all enabled schedules (container auto-updates, git stack syncs, and system jobs)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getEnabledAutoUpdateSettings,
	getEnabledAutoUpdateGitStacks,
	getAllAutoUpdateSettings,
	getAllAutoUpdateGitStacks,
	getAllEnvUpdateCheckSettings,
	getAllImagePruneSettings,
	getBackupConfigs,
	getBackupDestination,
	getBackupDestinations,
	getLastExecutionForSchedule,
	getRecentExecutionsForSchedule,
	getEnvironment,
	getEnvironmentTimezone,
	type ScheduleExecutionData,
	type VulnerabilityCriteria
} from '$lib/server/db';
import { getNextRun, getSystemSchedules } from '$lib/server/scheduler';
import { getGlobalScannerDefaults, getScannerSettingsWithDefaults } from '$lib/server/scanner';
import { authorize } from '$lib/server/authorize';

export interface ScheduleInfo {
	id: number;
	type: 'container_update' | 'git_stack_sync' | 'system_cleanup' | 'env_update_check' | 'image_prune' | 'backup' | 'repo_prune' | 'repo_check' | 'repo_verify';
	name: string;
	entityName: string;
	description?: string;
	environmentId: number | null;
	environmentName: string | null;
	enabled: boolean;
	scheduleType: string;
	cronExpression: string | null;
	nextRun: string | null;
	lastExecution: ScheduleExecutionData | null;
	recentExecutions: ScheduleExecutionData[];
	isSystem: boolean;
	// Container update specific fields
	envHasScanning?: boolean;
	vulnerabilityCriteria?: VulnerabilityCriteria | null;
}

/**
 * @openapi
 * summary: List all schedules (container/env auto-updates, git syncs, image-prune, backups, repo maintenance, system jobs)
 * resp-200: {schedules:array<{id:integer!, type:string!, name:string!, entityName:string!, environmentId:integer, enabled:boolean!, cronExpression:string, nextRun:string, isSystem:boolean!}>!}
 * resp-500: Unexpected error while assembling the schedule list
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	const permDenied = await auth.requirePermission('schedules', 'view');
	if (permDenied) return permDenied;

	try {
		const schedules: ScheduleInfo[] = [];

		// Pre-fetch global scanner defaults ONCE (CLI args are global, not per-environment)
		const globalScannerDefaults = await getGlobalScannerDefaults();

		// Get container auto-update schedules (get all, not just enabled, so we can show them in the grid)
		const containerSettings = await getAllAutoUpdateSettings();
		const containerSchedules = await Promise.all(
			containerSettings.map(async (setting) => {
				const [env, lastExecution, recentExecutions, scannerSettings, timezone] = await Promise.all([
					setting.environmentId ? getEnvironment(setting.environmentId) : null,
					getLastExecutionForSchedule('container_update', setting.id),
					getRecentExecutionsForSchedule('container_update', setting.id, 5),
					getScannerSettingsWithDefaults(setting.environmentId ?? undefined, globalScannerDefaults),
					setting.environmentId ? getEnvironmentTimezone(setting.environmentId) : 'UTC'
				]);
				const isEnabled = setting.enabled ?? false;
				const nextRun = isEnabled && setting.cronExpression ? getNextRun(setting.cronExpression, timezone) : null;
				// Check if env has scanning enabled
				const envHasScanning = scannerSettings.scanner !== 'none';

				return {
					id: setting.id,
					type: 'container_update' as const,
					name: `Update container: ${setting.containerName}`,
					entityName: setting.containerName,
					environmentId: setting.environmentId ?? null,
					environmentName: env?.name ?? null,
					enabled: isEnabled,
					scheduleType: setting.scheduleType ?? 'daily',
					cronExpression: setting.cronExpression ?? null,
					nextRun: nextRun?.toISOString() ?? null,
					lastExecution: lastExecution ?? null,
					recentExecutions,
					isSystem: false,
					envHasScanning,
					vulnerabilityCriteria: setting.vulnerabilityCriteria ?? null
				};
			})
		);
		schedules.push(...containerSchedules);

		// Get git stack auto-sync schedules
		const gitStacks = await getAllAutoUpdateGitStacks();
		const gitSchedules = await Promise.all(
			gitStacks.map(async (stack) => {
				const [env, lastExecution, recentExecutions, timezone] = await Promise.all([
					stack.environmentId ? getEnvironment(stack.environmentId) : null,
					getLastExecutionForSchedule('git_stack_sync', stack.id),
					getRecentExecutionsForSchedule('git_stack_sync', stack.id, 5),
					stack.environmentId ? getEnvironmentTimezone(stack.environmentId) : 'UTC'
				]);
				const isEnabled = stack.autoUpdate ?? false;
				const nextRun = isEnabled && stack.autoUpdateCron ? getNextRun(stack.autoUpdateCron, timezone) : null;

				return {
					id: stack.id,
					type: 'git_stack_sync' as const,
					name: `Git sync: ${stack.stackName}`,
					entityName: stack.stackName,
					environmentId: stack.environmentId ?? null,
					environmentName: env?.name ?? null,
					enabled: isEnabled,
					scheduleType: stack.autoUpdateSchedule ?? 'daily',
					cronExpression: stack.autoUpdateCron ?? null,
					nextRun: nextRun?.toISOString() ?? null,
					lastExecution: lastExecution ?? null,
					recentExecutions,
					isSystem: false
				};
			})
		);
		schedules.push(...gitSchedules);

		// Get environment update check schedules
		const envUpdateCheckConfigs = await getAllEnvUpdateCheckSettings();
		const envUpdateCheckSchedules = await Promise.all(
			envUpdateCheckConfigs.map(async ({ envId, settings }) => {
				const [env, lastExecution, recentExecutions, scannerSettings, timezone] = await Promise.all([
					getEnvironment(envId),
					getLastExecutionForSchedule('env_update_check', envId),
					getRecentExecutionsForSchedule('env_update_check', envId, 5),
					getScannerSettingsWithDefaults(envId, globalScannerDefaults),
					getEnvironmentTimezone(envId)
				]);
				const isEnabled = settings.enabled ?? false;
				const nextRun = isEnabled && settings.cron ? getNextRun(settings.cron, timezone) : null;
				const envHasScanning = scannerSettings.scanner !== 'none';

				// Build description based on autoUpdate and scanning status
				let description: string;
				if (settings.autoUpdate) {
					description = envHasScanning ? 'Check, scan & auto-update containers' : 'Check & auto-update containers';
				} else {
					description = 'Check containers for updates (notify only)';
				}

				return {
					id: envId,
					type: 'env_update_check' as const,
					name: `Update environment: ${env?.name || 'Unknown'}`,
					entityName: env?.name || 'Unknown',
					description,
					environmentId: envId,
					environmentName: env?.name ?? null,
					enabled: isEnabled,
					scheduleType: 'custom',
					cronExpression: settings.cron ?? null,
					nextRun: nextRun?.toISOString() ?? null,
					lastExecution: lastExecution ?? null,
					recentExecutions,
					isSystem: false,
					autoUpdate: settings.autoUpdate,
					envHasScanning,
					vulnerabilityCriteria: settings.autoUpdate ? (settings.vulnerabilityCriteria ?? null) : null
				};
			})
		);
		schedules.push(...envUpdateCheckSchedules);

		// Get image prune schedules
		const imagePruneConfigs = await getAllImagePruneSettings();
		const imagePruneSchedules = await Promise.all(
			imagePruneConfigs.map(async ({ envId, settings }) => {
				const [env, lastExecution, recentExecutions, timezone] = await Promise.all([
					getEnvironment(envId),
					getLastExecutionForSchedule('image_prune', envId),
					getRecentExecutionsForSchedule('image_prune', envId, 5),
					getEnvironmentTimezone(envId)
				]);
				const isEnabled = settings.enabled ?? false;
				const nextRun = isEnabled && settings.cronExpression ? getNextRun(settings.cronExpression, timezone) : null;

				// Build description based on prune mode
				const description = settings.pruneMode === 'all'
					? 'Prune all unused images'
					: 'Prune dangling images only';

				return {
					id: envId,
					type: 'image_prune' as const,
					name: `Prune images: ${env?.name || 'Unknown'}`,
					entityName: env?.name || 'Unknown',
					description,
					environmentId: envId,
					environmentName: env?.name ?? null,
					enabled: isEnabled,
					scheduleType: 'custom',
					cronExpression: settings.cronExpression ?? null,
					nextRun: nextRun?.toISOString() ?? null,
					lastExecution: lastExecution ?? null,
					recentExecutions,
					isSystem: false,
					pruneMode: settings.pruneMode
				};
			})
		);
		schedules.push(...imagePruneSchedules);

		// Get backup schedules (audit #17 — GET must match the SSE stream listing)
		const allBackupConfigs = await getBackupConfigs();
		const backupSchedules = await Promise.all(
			allBackupConfigs
				.filter(c => c.schedule)
				.map(async (config) => {
					const [env, dest, lastExecution, recentExecutions] = await Promise.all([
						config.environmentId ? getEnvironment(config.environmentId) : null,
						getBackupDestination(config.destinationId),
						getLastExecutionForSchedule('backup', config.id),
						getRecentExecutionsForSchedule('backup', config.id, 5)
					]);
					const timezone = config.environmentId ? await getEnvironmentTimezone(config.environmentId) : 'UTC';
					const isEnabled = config.enabled ?? false;
					const nextRun = isEnabled && config.schedule ? getNextRun(config.schedule, timezone) : null;

					return {
						id: config.id,
						type: 'backup' as const,
						name: `Backup: ${config.targetName}`,
						entityName: config.targetName,
						description: `Back up ${config.type} to ${dest?.name || 'unknown destination'}`,
						environmentId: config.environmentId,
						environmentName: env?.name ?? null,
						enabled: isEnabled,
						scheduleType: 'custom',
						cronExpression: config.schedule ?? null,
						nextRun: nextRun?.toISOString() ?? null,
						lastExecution: lastExecution ?? null,
						recentExecutions,
						isSystem: false
					};
				})
		);
		schedules.push(...backupSchedules);

		// Get repo maintenance schedules (prune + check + verify from destination
		// policies). Synthetic ids: dest.id + 100000/200000/300000 (matches the
		// stream endpoint and the run/toggle/delete REPO_ID_OFFSET decoding).
		const allDestinations = await getBackupDestinations();
		for (const dest of allDestinations) {
			const policies = dest.policies ? (() => { try { return JSON.parse(dest.policies); } catch { return {}; } })() : {};
			if (policies.pruneEnabled && policies.pruneSchedule) {
				const [lastExec, recentExecs] = await Promise.all([
					getLastExecutionForSchedule('repo_prune', dest.id),
					getRecentExecutionsForSchedule('repo_prune', dest.id, 5)
				]);
				const nextRun = getNextRun(policies.pruneSchedule);
				const maxUnused = policies.pruneMaxUnused ?? '10';
				schedules.push({
					id: dest.id + 100000,
					type: 'repo_prune' as const,
					name: `Prune: ${dest.name}`,
					entityName: dest.name,
					description: `Prune unused data from ${dest.name} (max unused ${maxUnused}%)`,
					environmentId: null,
					environmentName: null,
					enabled: true,
					scheduleType: 'custom',
					cronExpression: policies.pruneSchedule,
					nextRun: nextRun?.toISOString() ?? null,
					lastExecution: lastExec ?? null,
					recentExecutions: recentExecs,
					isSystem: false
				});
			}
			if (policies.checkEnabled && policies.checkSchedule) {
				const [lastExec, recentExecs] = await Promise.all([
					getLastExecutionForSchedule('repo_check', dest.id),
					getRecentExecutionsForSchedule('repo_check', dest.id, 5)
				]);
				const nextRun = getNextRun(policies.checkSchedule);
				schedules.push({
					id: dest.id + 200000,
					type: 'repo_check' as const,
					name: `Check: ${dest.name}`,
					entityName: dest.name,
					description: `Check integrity of ${dest.name}`,
					environmentId: null,
					environmentName: null,
					enabled: true,
					scheduleType: 'custom',
					cronExpression: policies.checkSchedule,
					nextRun: nextRun?.toISOString() ?? null,
					lastExecution: lastExec ?? null,
					recentExecutions: recentExecs,
					isSystem: false
				});
			}
			if (policies.verifyEnabled && policies.verifySchedule) {
				const [lastExec, recentExecs] = await Promise.all([
					getLastExecutionForSchedule('repo_verify', dest.id),
					getRecentExecutionsForSchedule('repo_verify', dest.id, 5)
				]);
				const nextRun = getNextRun(policies.verifySchedule);
				const subset = policies.verifyDataSubset || '5%';
				schedules.push({
					id: dest.id + 300000,
					type: 'repo_verify' as const,
					name: `Verify: ${dest.name}`,
					entityName: dest.name,
					description: `Verify ${subset} of data in ${dest.name}`,
					environmentId: null,
					environmentName: null,
					enabled: true,
					scheduleType: 'custom',
					cronExpression: policies.verifySchedule,
					nextRun: nextRun?.toISOString() ?? null,
					lastExecution: lastExec ?? null,
					recentExecutions: recentExecs,
					isSystem: false
				});
			}
		}

		// Get system schedules
		const systemSchedules = await getSystemSchedules();
		const sysSchedules = await Promise.all(
			systemSchedules.map(async (sys) => {
				const [lastExecution, recentExecutions] = await Promise.all([
					getLastExecutionForSchedule(sys.type, sys.id),
					getRecentExecutionsForSchedule(sys.type, sys.id, 5)
				]);

				return {
					id: sys.id,
					type: sys.type,
					name: sys.name,
					entityName: sys.name,
					description: sys.description,
					environmentId: null,
					environmentName: null,
					enabled: sys.enabled,
					scheduleType: 'custom',
					cronExpression: sys.cronExpression,
					nextRun: sys.nextRun,
					lastExecution: lastExecution ?? null,
					recentExecutions,
					isSystem: true
				};
			})
		);
		schedules.push(...sysSchedules);

		// Filter by per-env access (enterprise): caller sees only schedules
		// for envs they can access, plus all system schedules (env null).
		// Free edition / admin: getAccessibleEnvironmentIds returns null,
		// no filtering applied.
		const accessibleEnvIds = await auth.getAccessibleEnvironmentIds();
		const filtered = accessibleEnvIds === null
			? schedules
			: schedules.filter(s =>
				s.environmentId === null || accessibleEnvIds.includes(s.environmentId));

		// Sort: system jobs last, then by name
		filtered.sort((a, b) => {
			if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
			return a.name.localeCompare(b.name);
		});

		return json({ schedules: filtered });
	} catch (error: any) {
		console.error('Failed to get schedules:', error);
		return json({ error: error.message }, { status: 500 });
	}
};
