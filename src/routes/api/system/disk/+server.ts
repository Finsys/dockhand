import { json } from '@sveltejs/kit';
import { getCachedDiskUsage, SKIP_DF_COLLECTION } from '$lib/server/disk-usage-cache';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

const DISK_USAGE_WAIT_MS = 15000; // how long this request waits for a scan to finish

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

	// Shared cache: one /system/df per environment, reused for 5 minutes. If the scan
	// takes longer than we wait here it keeps running and fills the cache, so the next
	// request gets the result instead of starting another scan.
	const diskUsage = await getCachedDiskUsage(envId, DISK_USAGE_WAIT_MS);
	return json({ diskUsage });
};
