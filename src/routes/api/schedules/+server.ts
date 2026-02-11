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
	getLastExecutionForSchedule,
	getRecentExecutionsForSchedule,
	getEnvironment,
	getEnvironmentTimezone,
	type ScheduleExecutionData,
	type VulnerabilityCriteria
} from '$lib/server/db';
import { getNextRun, getSystemSchedules } from '$lib/server/scheduler';
import { getGlobalScannerDefaults, getScannerSettingsWithDefaults } from '$lib/server/scanner';

export interface ScheduleInfo {
	id: number;
	type: 'container_update' | 'git_stack_sync' | 'system_cleanup' | 'env_update_check' | 'image_prune';
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

export const GET: RequestHandler = async () => {
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

		// Sort: system jobs last, then by name
		schedules.sort((a, b) => {
			if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
			return a.name.localeCompare(b.name);
		});

		return json({ schedules });
	} catch (error: any) {
		console.error('Failed to get schedules:', error);
		return json({ error: error.message }, { status: 500 });
	}
};
