/**
 * Schedule Execution Detail API
 *
 * GET /api/schedules/executions/[id] - Returns execution details including logs
 * DELETE /api/schedules/executions/[id] - Delete a schedule execution
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getScheduleExecution, deleteScheduleExecution } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';

/**
 * @openapi
 * summary: Get a single schedule execution, including its logs
 * path: id:integer! Execution id (from GET /api/schedules/executions)
 * resp-200: {id:integer!, scheduleType:string!, status:string!, startedAt:string!, log:string}
 * resp-400: Invalid execution id
 * resp-404: Execution not found
 * resp-500: Unexpected error while loading the execution
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const id = parseInt(params.id, 10);
		if (isNaN(id)) {
			return json({ error: 'Invalid execution ID' }, { status: 400 });
		}

		const execution = await getScheduleExecution(id);
		if (!execution) {
			return json({ error: 'Execution not found' }, { status: 404 });
		}

		return json(execution);
	} catch (error: any) {
		console.error('Failed to get schedule execution:', error);
		return json({ error: error.message }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Delete a single schedule execution record
 * path: id:integer! Execution id (from GET /api/schedules/executions)
 * resp-200: {success:boolean!}
 * resp-400: Invalid execution id
 * resp-403: Permission denied (RBAC 'schedules:edit' missing)
 * resp-500: Unexpected error while deleting the execution
 */
export const DELETE: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('schedules', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id, 10);
		if (isNaN(id)) {
			return json({ error: 'Invalid execution ID' }, { status: 400 });
		}

		await deleteScheduleExecution(id);

		return json({ success: true });
	} catch (error: any) {
		console.error('Failed to delete schedule execution:', error);
		return json({ error: error.message }, { status: 500 });
	}
};
