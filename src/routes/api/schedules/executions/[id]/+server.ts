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
import { resourceForScheduleType } from '$lib/server/schedule-execution-access-core';

/**
 * @openapi
 * summary: Get a single schedule execution, including its logs
 * path: id:integer! Execution id (from GET /api/schedules/executions)
 * resp-200: {id:integer!, scheduleType:string!, status:string!, startedAt:string!, log:string}
 * resp-400: Invalid execution id
 * resp-401: Authentication required
 * resp-403: Permission denied (the :view permission for the row's resource), or no access to its environment (enterprise)
 * resp-404: Execution not found
 * resp-500: Unexpected error while loading the execution
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	try {
		const id = parseInt(params.id, 10);
		if (isNaN(id)) {
			return json({ error: 'Invalid execution ID' }, { status: 400 });
		}

		const execution = await getScheduleExecution(id);
		if (!execution) {
			return json({ error: 'Execution not found' }, { status: 404 });
		}

		// The row's logs/errorMessage are as sensitive as the feature that ran, so
		// gate on that resource's :view (and, in enterprise, on access to the row's
		// own environment -- a null env is unattributed and not env-scoped, matching
		// deploy-run-access.ts).
		if (auth.authEnabled) {
			const resource = resourceForScheduleType(execution.scheduleType);
			if (!(await auth.can(resource, 'view'))) {
				return json({ error: 'Permission denied' }, { status: 403 });
			}
			if (
				execution.environmentId != null &&
				auth.isEnterprise &&
				!(await auth.canAccessEnvironment(execution.environmentId))
			) {
				return json({ error: 'Access denied to this environment' }, { status: 403 });
			}
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
 * resp-401: Authentication required
 * resp-403: Permission denied (the :edit permission for the row's resource), or no access to its environment (enterprise)
 * resp-404: Execution not found
 * resp-500: Unexpected error while deleting the execution
 */
export const DELETE: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	try {
		const id = parseInt(params.id, 10);
		if (isNaN(id)) {
			return json({ error: 'Invalid execution ID' }, { status: 400 });
		}

		const execution = await getScheduleExecution(id);
		if (!execution) {
			return json({ error: 'Execution not found' }, { status: 404 });
		}

		// Deleting a run record is gated by the :edit of the feature that ran it
		// (a stack_deploy needs stacks:edit, a backup needs backups:edit), plus
		// env access in enterprise -- symmetric with the GET above.
		if (auth.authEnabled) {
			const resource = resourceForScheduleType(execution.scheduleType);
			if (!(await auth.can(resource, 'edit'))) {
				return json({ error: 'Permission denied' }, { status: 403 });
			}
			if (
				execution.environmentId != null &&
				auth.isEnterprise &&
				!(await auth.canAccessEnvironment(execution.environmentId))
			) {
				return json({ error: 'Access denied to this environment' }, { status: 403 });
			}
		}

		await deleteScheduleExecution(id);

		return json({ success: true });
	} catch (error: any) {
		console.error('Failed to delete schedule execution:', error);
		return json({ error: error.message }, { status: 500 });
	}
};
