import { json } from '@sveltejs/kit';
import { getDiskUsage } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

// Skip disk usage collection (Synology NAS performance fix)
const SKIP_DF_COLLECTION = process.env.SKIP_DF_COLLECTION === 'true' || process.env.SKIP_DF_COLLECTION === '1';

const DISK_USAGE_TIMEOUT = 15000; // 15 second timeout

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
