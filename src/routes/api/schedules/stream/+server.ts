/**
 * Schedules Stream API - Real-time schedule updates via SSE
 *
 * GET /api/schedules/stream - Server-Sent Events stream for schedule updates
 */

import type { RequestHandler } from './$types';
import {
	getAllAutoUpdateSettings,
	getAllAutoUpdateGitStacks,
	getAllEnvUpdateCheckSettings,
	getAllImagePruneSettings,
	getLastExecutionForSchedule,
	getRecentExecutionsForSchedule,
	getEnvironment,
	getEnvironmentTimezone,
	type VulnerabilityCriteria
} from '$lib/server/db';
import { getNextRun, getSystemSchedules } from '$lib/server/scheduler';
import { getGlobalScannerDefaults, getScannerSettingsWithDefaults } from '$lib/server/scanner';
import { authorize } from '$lib/server/authorize';
import type { ScheduleInfo } from '../+server';

async function getSchedulesData(): Promise<ScheduleInfo[]> {
	const schedules: ScheduleInfo[] = [];

	// Pre-fetch global scanner defaults ONCE (CLI args are global, not per-environment)
	const globalScannerDefaults = await getGlobalScannerDefaults();

	// Get container auto-update schedules
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

	return schedules;
}

export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('schedules', 'view')) {
		return new Response(JSON.stringify({ error: 'Permission denied' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	let controllerClosed = false;
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let isPolling = false; // Guard against concurrent poll executions
	let initialDataSent = false; // Track if initial data was successfully sent

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			console.log('[Schedules Stream] New connection opened');

			// Returns true if data was successfully enqueued
			const safeEnqueue = (data: string): boolean => {
				if (controllerClosed) {
					return false;
				}
				try {
					controller.enqueue(encoder.encode(data));
					return true;
				} catch (err) {
					console.log('[Schedules Stream] Controller closed during enqueue, cleaning up');
					controllerClosed = true;
					if (intervalId) {
						clearInterval(intervalId);
						intervalId = null;
					}
					return false;
				}
			};

			// Send immediate connection confirmation so client knows stream is alive
			if (!safeEnqueue(`event: connected\ndata: {}\n\n`)) {
				return; // Connection already closed, abort
			}

			// Send initial data - this is critical, retry logic if needed
			let retryCount = 0;
			const maxRetries = 2;

			while (!initialDataSent && retryCount <= maxRetries && !controllerClosed) {
				try {
					const schedules = await getSchedulesData();

					// Check if still connected before sending
					if (controllerClosed) {
						console.log('[Schedules Stream] Connection closed before initial data could be sent');
						return;
					}

					if (safeEnqueue(`event: schedules\ndata: ${JSON.stringify({ schedules })}\n\n`)) {
						initialDataSent = true;
						console.log('[Schedules Stream] Initial data sent successfully');
					} else {
						console.log('[Schedules Stream] Failed to enqueue initial data, connection closed');
						return;
					}
				} catch (error) {
					console.error(`[Schedules Stream] Failed to get initial schedules (attempt ${retryCount + 1}):`, error);
					retryCount++;

					if (retryCount > maxRetries) {
						// Send error event to client so they can show an error state
						safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: String(error), fatal: true })}\n\n`);
						return;
					}

					// Brief delay before retry
					await new Promise(resolve => setTimeout(resolve, 500));
				}
			}

			// Only start polling if initial data was sent successfully
			if (!initialDataSent) {
				console.log('[Schedules Stream] Initial data was never sent, not starting polling');
				return;
			}

			// Poll every 2 seconds for updates (with guard against concurrent executions)
			intervalId = setInterval(async () => {
				// Skip if already polling or controller closed
				if (isPolling || controllerClosed) {
					if (controllerClosed && intervalId) {
						clearInterval(intervalId);
						intervalId = null;
					}
					return;
				}

				isPolling = true;
				try {
					const schedules = await getSchedulesData();
					safeEnqueue(`event: schedules\ndata: ${JSON.stringify({ schedules })}\n\n`);
				} catch (error) {
					console.error('[Schedules Stream] Failed to get schedules during poll:', error);
					// Don't send error event for poll failures, just log
				} finally {
					isPolling = false;
				}
			}, 2000);
		},
		cancel() {
			console.log('[Schedules Stream] Connection cancelled, cleaning up');
			controllerClosed = true;
			if (intervalId) {
				clearInterval(intervalId);
				intervalId = null;
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive'
		}
	});
};
