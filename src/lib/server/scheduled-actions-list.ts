/**
 * The Schedules-tab rows for scheduled container start and stop: one row per time a
 * container has, typed container_start or container_stop. Shared by the list
 * endpoint and its stream so both show the same thing.
 */
import {
	getScheduledContainerActions,
	getEnvironment,
	getEnvironmentTimezone,
	getLastExecutionForSchedule,
	getRecentExecutionsForSchedule
} from './db';
import { getNextRun } from './scheduler/cron-utils';
import { actionTimeToCron } from './scheduled-actions-core';

export async function containerActionScheduleRows() {
	const rows = await getScheduledContainerActions();
	const out = [];
	for (const row of rows) {
		const [env, timezone] = await Promise.all([getEnvironment(row.environmentId), getEnvironmentTimezone(row.environmentId)]);
		for (const [type, at] of [['container_start', row.startAt], ['container_stop', row.stopAt]] as const) {
			if (!at) continue;
			const parsed = actionTimeToCron(at);
			const cron = 'cron' in parsed ? parsed.cron : null;
			const [lastExecution, recentExecutions] = await Promise.all([
				getLastExecutionForSchedule(type, row.id),
				getRecentExecutionsForSchedule(type, row.id, 5)
			]);
			out.push({
				id: row.id,
				type,
				name: `${type === 'container_start' ? 'Start' : 'Stop'} container: ${row.containerName}`,
				entityName: row.containerName,
				description: row.source === 'label' ? 'Set by container labels' : undefined,
				environmentId: row.environmentId,
				environmentName: env?.name ?? null,
				enabled: row.enabled,
				scheduleType: 'custom',
				cronExpression: cron,
				nextRun: row.enabled && cron ? (getNextRun(cron, timezone)?.toISOString() ?? null) : null,
				lastExecution: lastExecution ?? null,
				recentExecutions,
				isSystem: false,
				source: row.source as 'ui' | 'label'
			});
		}
	}
	return out;
}
