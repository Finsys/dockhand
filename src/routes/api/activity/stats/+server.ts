import { json } from '@sveltejs/kit';
import { getContainerEventStats } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Get aggregate container activity statistics (totals and counts by action)
 * query: environment_id:integer Filter to a single environment (from GET /api/environments)
 * resp-200: {total:integer!, today:integer!, byAction:{}}
 * resp-200-example: {"total":128,"today":7,"byAction":{"start":40,"stop":30}}
 * resp-403: Permission denied (requires the activity:view permission)
 * resp-500: Failed to fetch stats
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('environment_id');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check for activity viewing
	if (auth.authEnabled && !await auth.can('activity', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		let environmentIds: number[] | undefined;

		if (envIdNum) {
			// Specific environment requested
			const stats = await getContainerEventStats(envIdNum);
			return json(stats);
		} else if (auth.isEnterprise && auth.authEnabled && !auth.isAdmin) {
			// Enterprise with auth enabled and non-admin: filter by accessible environments
			const accessibleEnvIds = await auth.getAccessibleEnvironmentIds();
			if (accessibleEnvIds !== null) {
				if (accessibleEnvIds.length === 0) {
					// No access to any environment - return empty stats
					return json({ total: 0, today: 0, byAction: {} });
				}
				environmentIds = accessibleEnvIds;
			}
		}

		const stats = await getContainerEventStats(undefined, environmentIds);
		return json(stats);
	} catch (error) {
		console.error('Error fetching container event stats:', error);
		return json({ error: 'Failed to fetch stats' }, { status: 500 });
	}
};
