/**
 * Schedules API - List all active schedules
 *
 * GET /api/schedules - Returns all enabled schedules (container auto-updates, git repository syncs, and system jobs)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { buildSchedulesList, type ScheduleInfo } from '$lib/server/schedules-list';

export type { ScheduleInfo };

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
		const schedules = await buildSchedulesList();

		// Filter by per-env access (enterprise): caller sees only schedules
		// for envs they can access, plus all system/global schedules (env null).
		// Free edition / admin: getAccessibleEnvironmentIds returns null,
		// no filtering applied.
		const accessibleEnvIds = await auth.getAccessibleEnvironmentIds();
		const filtered = accessibleEnvIds === null
			? schedules
			: schedules.filter(s =>
				s.environmentId === null || accessibleEnvIds.includes(s.environmentId));

		return json({ schedules: filtered });
	} catch (error: any) {
		console.error('Failed to get schedules:', error);
		return json({ error: error.message }, { status: 500 });
	}
};
