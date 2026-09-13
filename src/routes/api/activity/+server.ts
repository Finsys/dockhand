import { json } from '@sveltejs/kit';
import { getContainerEvents, getContainerEventContainers, getContainerEventActions, getContainerEventStats, clearContainerEvents, type ContainerEventFilters, type ContainerEventAction } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Query container activity events with filters and pagination
 * query: environmentId:integer Filter to a single environment (from GET /api/environments)
 * query: containerId:string Filter by container ID (from GET /api/containers)
 * query: containerName:string Filter by container name
 * query: actions:string Comma-separated event actions to filter by
 * query: labels:string Comma-separated labels to filter by
 * query: fromDate:string Start of the date range (ISO 8601)
 * query: toDate:string End of the date range (ISO 8601)
 * query: limit:integer Maximum number of events to return
 * query: offset:integer Number of events to skip (pagination)
 * resp-200: {events:array<{id:integer!, containerName:string, action:string, timestamp:string}>, total:integer!, limit:integer!, offset:integer!}
 * resp-403: Permission denied (requires the activity:view permission)
 * resp-500: Failed to fetch container events
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	// Parse query parameters
	const filters: ContainerEventFilters = {};

	const envId = url.searchParams.get('environmentId');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('activity', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		if (envIdNum) {
			// Specific environment requested - use it
			filters.environmentId = envIdNum;
		} else if (auth.isEnterprise && auth.authEnabled && !auth.isAdmin) {
			// Enterprise with auth enabled and non-admin: filter by accessible environments
			const accessibleEnvIds = await auth.getAccessibleEnvironmentIds();
			if (accessibleEnvIds !== null) {
				// User has limited access - filter by their accessible environments
				if (accessibleEnvIds.length === 0) {
					// No access to any environment - return empty
					return json({ events: [], total: 0, limit: 100, offset: 0 });
				}
				filters.environmentIds = accessibleEnvIds;
			}
			// If accessibleEnvIds is null, user has access to all environments
		}

		const containerId = url.searchParams.get('containerId');
		if (containerId) filters.containerId = containerId;

		const containerName = url.searchParams.get('containerName');
		if (containerName) filters.containerName = containerName;

		// Support multi-select actions filter (comma-separated)
		const actions = url.searchParams.get('actions');
		if (actions) filters.actions = actions.split(',').filter(Boolean) as ContainerEventAction[];

		// Labels filter (comma-separated)
		const labels = url.searchParams.get('labels');
		if (labels) filters.labels = labels.split(',').filter(Boolean);

		const fromDate = url.searchParams.get('fromDate');
		if (fromDate) filters.fromDate = fromDate;

		const toDate = url.searchParams.get('toDate');
		if (toDate) filters.toDate = toDate;

		const limit = url.searchParams.get('limit');
		if (limit) filters.limit = parseInt(limit);

		const offset = url.searchParams.get('offset');
		if (offset) filters.offset = parseInt(offset);

		const result = await getContainerEvents(filters);
		return json(result);
	} catch (error) {
		console.error('Error fetching container events:', error);
		return json({ error: 'Failed to fetch container events' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Clear all stored container activity events
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-403: Permission denied (requires the activity:delete permission)
 * resp-500: Failed to clear container events
 */
export const DELETE: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	// Check permission - admins or users with activity delete permission
	// In free edition, all authenticated users can delete
	if (auth.authEnabled && !await auth.can('activity', 'delete')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		await clearContainerEvents();
		return json({ success: true });
	} catch (error) {
		console.error('Error clearing container events:', error);
		return json({ error: 'Failed to clear container events' }, { status: 500 });
	}
};
