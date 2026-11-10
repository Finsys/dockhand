import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getScheduledContainerAction,
	upsertScheduledContainerAction,
	deleteScheduledContainerActionById
} from '$lib/server/db';
import { listContainers } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { registerContainerActionSchedules, unregisterContainerActionSchedules } from '$lib/server/scheduler';
import { isSystemContainer } from '$lib/server/scheduler/tasks/update-utils';
import { actionTimeToCron, labelActionTimes } from '$lib/server/scheduled-actions-core';

function envIdOf(value: string | null): number | null {
	const id = Number(value);
	return Number.isInteger(id) && id > 0 ? id : null;
}

async function findContainer(name: string, envId: number) {
	return (await listContainers(true, envId)).find((c) => c.name === name) ?? null;
}

/**
 * The schedule as it applies now: the container's labels when it carries them,
 * otherwise the stored row.
 */
async function effectiveSchedule(containerName: string, envId: number) {
	const [row, container] = await Promise.all([
		getScheduledContainerAction(containerName, envId),
		findContainer(containerName, envId)
	]);
	const labels = labelActionTimes(container?.labels);
	const fromLabels = labels.startAt !== null || labels.stopAt !== null;
	return {
		row,
		container,
		schedule: {
			startAt: fromLabels ? labels.startAt : (row?.startAt ?? null),
			stopAt: fromLabels ? labels.stopAt : (row?.stopAt ?? null),
			enabled: row?.enabled ?? true,
			source: fromLabels ? 'label' : (row?.source ?? 'ui'),
			labelErrors: labels.errors,
			systemContainer: container ? isSystemContainer(container.image) !== null : false,
			lastStarted: row?.lastStarted ?? null,
			lastStopped: row?.lastStopped ?? null
		}
	};
}

/**
 * @openapi
 * summary: Get a container's scheduled start and stop times, from its dockhand.start.at / dockhand.stop.at labels when it carries them
 * path: containerName:string! Container name (URL-encoded)
 * query: env:integer! Environment the container belongs to (from GET /api/environments)
 * resp-200: {startAt:string, stopAt:string, enabled:boolean!, source:string!, labelErrors:array<string>!, systemContainer:boolean!, lastStarted:string, lastStopped:string}
 * resp-200-example: {"startAt":"07:00","stopAt":"23:00","enabled":true,"source":"ui","labelErrors":[],"systemContainer":false,"lastStarted":null,"lastStopped":null}
 * resp-400: The env query parameter is missing
 * resp-403: Permission denied, or no access to the environment
 * resp-500: Failed to read the schedule
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = envIdOf(url.searchParams.get('env'));
	if (envId === null) return json({ error: 'env is required' }, { status: 400 });

	const denied = (await auth.requirePermission('schedules', 'view', envId)) ?? (await auth.requireEnvAccess(envId));
	if (denied) return denied;

	try {
		return json((await effectiveSchedule(params.containerName, envId)).schedule);
	} catch (error) {
		console.error('Failed to read scheduled container actions:', error);
		return json({ error: 'Failed to read the schedule' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Set a container's scheduled start and stop times (HH:MM every day, or a five-field cron expression); both empty removes the schedule
 * path: containerName:string! Container name (URL-encoded)
 * query: env:integer! Environment the container belongs to (from GET /api/environments)
 * body: {startAt:string, stopAt:string, enabled:boolean}
 * body-example: {"startAt":"07:00","stopAt":"0 23 * * 1-5","enabled":true}
 * resp-200: {startAt:string, stopAt:string, enabled:boolean!, source:string!, labelErrors:array<string>!, systemContainer:boolean!, lastStarted:string, lastStopped:string}
 * resp-400: The env query parameter is missing, or a time is neither HH:MM nor a cron expression
 * resp-403: Permission denied (needs schedules:edit and containers start and stop), no access to the environment, or a system container
 * resp-404: Container not found
 * resp-409: The container's labels set its schedule
 * resp-500: Failed to save the schedule
 */
export const PUT: RequestHandler = async ({ params, url, request, cookies }) => {
	const auth = await authorize(cookies);
	const envId = envIdOf(url.searchParams.get('env'));
	if (envId === null) return json({ error: 'env is required' }, { status: 400 });

	// Scheduling a start or stop is starting or stopping, so it needs those rights too.
	const denied =
		(await auth.requirePermission('schedules', 'edit', envId)) ??
		(await auth.requirePermission('containers', 'start', envId)) ??
		(await auth.requirePermission('containers', 'stop', envId)) ??
		(await auth.requireEnvAccess(envId));
	if (denied) return denied;

	try {
		const containerName = params.containerName;
		const body = await request.json();
		const read = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
		const startAt = read(body.startAt);
		const stopAt = read(body.stopAt);

		for (const value of [startAt, stopAt]) {
			if (value === null) continue;
			const parsed = actionTimeToCron(value);
			if ('error' in parsed) return json({ error: parsed.error }, { status: 400 });
		}

		const current = await effectiveSchedule(containerName, envId);
		if (!current.container) return json({ error: 'Container not found' }, { status: 404 });
		if (current.schedule.systemContainer) {
			return json({ error: 'System containers cannot be started or stopped on a schedule' }, { status: 403 });
		}
		if (current.schedule.source === 'label') {
			return json({ error: 'This container is scheduled by its dockhand.start.at / dockhand.stop.at labels' }, { status: 409 });
		}

		if (startAt === null && stopAt === null) {
			if (current.row) {
				unregisterContainerActionSchedules(current.row.id);
				await deleteScheduledContainerActionById(current.row.id);
			}
		} else {
			const row = await upsertScheduledContainerAction(containerName, envId, {
				startAt,
				stopAt,
				source: 'ui',
				// Without an explicit value an existing row keeps its on/off state.
				enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined
			});
			await registerContainerActionSchedules(row.id, envId);
		}

		return json((await effectiveSchedule(containerName, envId)).schedule);
	} catch (error) {
		console.error('Failed to save scheduled container actions:', error);
		return json({ error: 'Failed to save the schedule' }, { status: 500 });
	}
};
