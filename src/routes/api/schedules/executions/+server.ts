/**
 * Schedule Executions API - List execution history
 *
 * GET /api/schedules/executions - Returns paginated execution history
 *
 * Query params:
 *   - scheduleType: 'container_update' | 'git_stack_sync'
 *   - scheduleId: number
 *   - environmentId: number
 *   - status: 'queued' | 'running' | 'success' | 'warning' | 'failed' | 'skipped'
 *   - triggeredBy: 'cron' | 'webhook' | 'manual'
 *   - fromDate: ISO date string
 *   - toDate: ISO date string
 *   - limit: number (default 50)
 *   - offset: number (default 0)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getScheduleExecutions,
	type ScheduleType,
	type ScheduleTrigger,
	type ScheduleStatus
} from '$lib/server/db';

/**
 * @openapi
 * summary: List schedule execution history, filterable and paginated
 * query: scheduleType:string Filter by schedule type (container_update, git_stack_sync, ...)
 * query: scheduleId:integer Filter by the numeric id of the schedule (from GET /api/schedules)
 * query: environmentId:integer Filter by environment id ("null" for global/system schedules) (from GET /api/environments)
 * query: status:string Filter by execution status (queued/running/success/warning/failed/skipped)
 * query: statuses:string Comma-separated list of statuses (alternative to status)
 * query: triggeredBy:string Filter by trigger (cron/webhook/manual)
 * query: fromDate:string ISO date lower bound
 * query: toDate:string ISO date upper bound
 * query: limit:integer Page size (default 50)
 * query: offset:integer Page offset (default 0)
 * resp-200: {executions:array<{id:integer!, scheduleType:string!, status:string!, startedAt:string!}>!, total:integer!, limit:integer!, offset:integer!}
 * resp-500: Unexpected error while loading execution history
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const scheduleType = url.searchParams.get('scheduleType') as ScheduleType | null;
		const scheduleIdParam = url.searchParams.get('scheduleId');
		const environmentIdParam = url.searchParams.get('environmentId');
		const status = url.searchParams.get('status') as ScheduleStatus | null;
		const statusesParam = url.searchParams.get('statuses');
		const triggeredBy = url.searchParams.get('triggeredBy') as ScheduleTrigger | null;
		const fromDate = url.searchParams.get('fromDate');
		const toDate = url.searchParams.get('toDate');
		const limitParam = url.searchParams.get('limit');
		const offsetParam = url.searchParams.get('offset');

		const filters: any = {};

		if (scheduleType) filters.scheduleType = scheduleType;
		if (scheduleIdParam) filters.scheduleId = parseInt(scheduleIdParam, 10);
		if (environmentIdParam) {
			filters.environmentId = environmentIdParam === 'null' ? null : parseInt(environmentIdParam, 10);
		}
		if (status) filters.status = status;
		if (statusesParam) filters.statuses = statusesParam.split(',') as ScheduleStatus[];
		if (triggeredBy) filters.triggeredBy = triggeredBy;
		if (fromDate) filters.fromDate = fromDate;
		if (toDate) filters.toDate = toDate;
		if (limitParam) filters.limit = parseInt(limitParam, 10);
		if (offsetParam) filters.offset = parseInt(offsetParam, 10);

		const result = await getScheduleExecutions(filters);

		return json(result);
	} catch (error: any) {
		console.error('Failed to get schedule executions:', error);
		return json({ error: error.message }, { status: 500 });
	}
};
