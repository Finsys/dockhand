/**
 * Shared schedule list builder used by REST and SSE endpoints.
 */

import {
	getAllAutoUpdateSettings,
	getAllAutoUpdateRepositories,
	getAllAutoUpdateGitStacks,
	getGitStacks,
	getAllEnvUpdateCheckSettings,
	getAllImagePruneSettings,
	getBackupConfigs,
	getBackupDestination,
	getBackupDestinations,
	getLastExecutionForSchedule,
	getRecentExecutionsForSchedule,
	getEnvironment,
	getEnvironmentTimezone,
	getDefaultTimezone,
	type ScheduleExecutionData,
	type VulnerabilityCriteria
} from '$lib/server/db';
import { getNextRun, getSystemSchedules } from '$lib/server/scheduler';
import { getGlobalScannerDefaults, getScannerSettingsWithDefaults } from '$lib/server/scanner';
import { filterReposWithCentralizedMember } from '$lib/utils/git-model-routing';
import { BACKUPS_ENABLED } from '$lib/server/features';

export interface ScheduleInfo {
	id: number;
	type: 'container_update' | 'git_repository_sync' | 'git_stack_sync' | 'system_cleanup' | 'env_update_check' | 'image_prune' | 'backup' | 'repo_prune' | 'repo_check' | 'repo_verify';
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
	envHasScanning?: boolean;
	vulnerabilityCriteria?: VulnerabilityCriteria | null;
	autoUpdate?: boolean;
	pruneMode?: string;
}

export async function buildSchedulesList(): Promise<ScheduleInfo[]> {
	const schedules: ScheduleInfo[] = [];

	const globalScannerDefaults = await getGlobalScannerDefaults();

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

	const gitRepos = await getAllAutoUpdateRepositories();
	const gitStacks = await getAllAutoUpdateGitStacks();
	const defaultTimezone = await getDefaultTimezone();
	// Mixed mode lists BOTH families: git_repository_sync for repositories that
	// have at least one centralized-model stack, git_stack_sync for stack-model
	// stacks. getAllAutoUpdateGitStacks is filtered to stack-model rows, so the
	// stack family is already correct. Repos with zero centralized members must
	// not appear as git_repository_sync rows (the scheduler never registers them,
	// and slotting a stack-mode repo here would be a ghost schedule).
	const gitRepoList = filterReposWithCentralizedMember(gitRepos, await getGitStacks());
	const gitSchedules = await Promise.all([
		...gitRepoList.map(async (repo) => {
			const [lastExecution, recentExecutions] = await Promise.all([
				getLastExecutionForSchedule('git_repository_sync', repo.id),
				getRecentExecutionsForSchedule('git_repository_sync', repo.id, 5)
			]);
			const isEnabled = repo.autoUpdate ?? false;
			const nextRun = isEnabled && repo.autoUpdateCron ? getNextRun(repo.autoUpdateCron, defaultTimezone) : null;

			return {
				id: repo.id,
				type: 'git_repository_sync' as const,
				name: `Git sync: ${repo.name}`,
				entityName: repo.name,
				environmentId: null,
				environmentName: null,
				enabled: isEnabled,
				scheduleType: repo.autoUpdateSchedule ?? 'daily',
				cronExpression: repo.autoUpdateCron ?? null,
				nextRun: nextRun?.toISOString() ?? null,
				lastExecution: lastExecution ?? null,
				recentExecutions,
				isSystem: false
			};
		}),
		...gitStacks.map(async (stack) => {
			const [env, lastExecution, recentExecutions, timezone] = await Promise.all([
				stack.environmentId ? getEnvironment(stack.environmentId) : null,
				getLastExecutionForSchedule('git_stack_sync', stack.id),
				getRecentExecutionsForSchedule('git_stack_sync', stack.id, 5),
				stack.environmentId ? getEnvironmentTimezone(stack.environmentId) : defaultTimezone
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
	]);
	schedules.push(...gitSchedules);

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

	// Backup schedules (audit #17 — GET must match the SSE stream listing)
	if (BACKUPS_ENABLED) {
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

		// Repo maintenance schedules (prune + check + verify from destination policies).
		// Synthetic ids: dest.id + 100000/200000/300000 (matches the stream endpoint
		// and the run/toggle/delete REPO_ID_OFFSET decoding).
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
	}

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

	schedules.sort((a, b) => {
		if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
		return a.name.localeCompare(b.name);
	});

	return schedules;
}
