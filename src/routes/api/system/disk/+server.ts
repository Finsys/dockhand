import { json } from '@sveltejs/kit';
import { getDiskUsage } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

// Skip disk usage collection (Synology NAS performance fix)
const SKIP_DF_COLLECTION = process.env.SKIP_DF_COLLECTION === 'true' || process.env.SKIP_DF_COLLECTION === '1';

const DISK_USAGE_TIMEOUT = 15000; // 15 second timeout

/**
 * GET /api/system/disk - Docker disk usage for an environment
 *
 * @openapi
 * summary: Return Docker disk usage (df) for an environment, or null when collection is disabled, times out, or fails
 * query: env:integer! ID of the environment to query disk usage for (from GET /api/environments)
 * resp-200: {diskUsage:object}
 * resp-200-desc: diskUsage is null when SKIP_DF_COLLECTION is set, or the query times out or errors
 * resp-200-example: {"diskUsage":{"LayersSize":1420000000,"Images":[],"Containers":[],"Volumes":[]}}
 * resp-400: Environment ID is required
 * resp-403: Permission denied, or (enterprise) no access to this environment
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !await auth.can('environments', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const envId = url.searchParams.get('env') ? parseInt(url.searchParams.get('env')!) : null;

	if (!envId) {
		return json({ error: 'Environment ID required' }, { status: 400 });
	}

	// Check environment access in enterprise mode
	if (auth.authEnabled && auth.isEnterprise && !await auth.canAccessEnvironment(envId)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	// Skip disk usage when disabled (Synology NAS performance fix)
	if (SKIP_DF_COLLECTION) {
		return json({ diskUsage: null });
	}

	try {
		// Fetch disk usage with timeout
		const diskUsagePromise = getDiskUsage(envId);
		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error('Disk usage timeout')), DISK_USAGE_TIMEOUT)
		);

		const diskUsage = await Promise.race([diskUsagePromise, timeoutPromise]);
		return json({ diskUsage });
	} catch (error) {
		// Return null on timeout or error - UI will show loading/unavailable state
		console.log(`Disk usage fetch failed for env ${envId}:`, error instanceof Error ? error.message : String(error));
		return json({ diskUsage: null });
	}
};
