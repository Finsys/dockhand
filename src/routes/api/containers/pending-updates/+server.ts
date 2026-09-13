import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getPendingContainerUpdates, removePendingContainerUpdate, clearPendingContainerUpdates } from '$lib/server/db';

function safeParse(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

/**
 * Get pending container updates for an environment.
 *
 * @openapi
 * summary: List the containers in an environment that have a pending image update recorded (requires the 'view' permission)
 * query: env:integer! The target environment ID (required) (from GET /api/environments)
 * resp-200: {environmentId:integer!, pendingUpdates:array<{containerId:string!, containerName:string!, currentImage:string!, checkedAt:string!, hasImageUpdate:boolean!, newerVersion:object}>!}
 * resp-400: Environment ID is required
 * resp-403: Permission denied
 * resp-500: Failed to get the pending updates
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
				checkedAt: u.checkedAt,
				hasImageUpdate: u.hasImageUpdate,
				newerVersion: u.newerVersion ? safeParse(u.newerVersion) : null
			}))
		});
	} catch (error: any) {
		console.error('Error getting pending updates:', error);
		return json({ error: 'Failed to get pending updates', details: error.message }, { status: 500 });
	}
};

/**
 * Remove a pending container update (e.g., after manual update).
 *
 * @openapi
 * summary: Clear pending-update records for an environment, or for a single container when containerId is given
 * query: env:integer! The target environment ID (required) (from GET /api/environments)
 * query: containerId:string The container to clear; omit to clear ALL pending updates in the environment (from GET /api/containers)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-400: Environment ID is required
 * resp-403: Permission denied
 * resp-500: Failed to remove the pending update
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
