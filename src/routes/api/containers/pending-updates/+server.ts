import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getPendingContainerUpdates, removePendingContainerUpdate, clearPendingContainerUpdates } from '$lib/server/db';

/**
 * Get pending container updates for an environment.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (!envIdNum) {
		return json({ error: 'Environment ID required' }, { status: 400 });
	}

	// Need at least view permission
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const pendingUpdates = await getPendingContainerUpdates(envIdNum);
		return json({
			environmentId: envIdNum,
			pendingUpdates: pendingUpdates.map(u => ({
				containerId: u.containerId,
				containerName: u.containerName,
				currentImage: u.currentImage,
				checkedAt: u.checkedAt
			}))
		});
	} catch (error: any) {
		console.error('Error getting pending updates:', error);
		return json({ error: 'Failed to get pending updates', details: error.message }, { status: 500 });
	}
};

/**
 * Remove a pending container update (e.g., after manual update).
 */
export const DELETE: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const containerId = url.searchParams.get('containerId');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (!envIdNum) {
		return json({ error: 'Environment ID required' }, { status: 400 });
	}

	// Need manage permission to delete
	if (auth.authEnabled && !await auth.can('containers', 'manage', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		if (containerId) {
			await removePendingContainerUpdate(envIdNum, containerId);
		} else {
			await clearPendingContainerUpdates(envIdNum);
		}
		return json({ success: true });
	} catch (error: any) {
		console.error('Error removing pending update:', error);
		return json({ error: 'Failed to remove pending update', details: error.message }, { status: 500 });
	}
};
