import { json } from '@sveltejs/kit';
import { getContainerEventContainers } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: List distinct container names that appear in the activity log, for filter dropdowns
 * query: environment_id:integer Filter to a single environment (from GET /api/environments)
 * resp-200: array<string>
 * resp-200-example: ["web-1","db-1","cache-1"]
 * resp-403: Permission denied (requires the activity:view permission)
 * resp-500: Failed to fetch container names
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
			const containers = await getContainerEventContainers(envIdNum);
			return json(containers);
		} else if (auth.isEnterprise && auth.authEnabled && !auth.isAdmin) {
			// Enterprise with auth enabled and non-admin: filter by accessible environments
			const accessibleEnvIds = await auth.getAccessibleEnvironmentIds();
			if (accessibleEnvIds !== null) {
				if (accessibleEnvIds.length === 0) {
					// No access to any environment - return empty list
					return json([]);
				}
				environmentIds = accessibleEnvIds;
			}
		}

		const containers = await getContainerEventContainers(undefined, environmentIds);
		return json(containers);
	} catch (error) {
		console.error('Error fetching container names:', error);
		return json({ error: 'Failed to fetch container names' }, { status: 500 });
	}
};
