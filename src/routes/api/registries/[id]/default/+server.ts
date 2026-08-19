import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setDefaultRegistry, getRegistry } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';

/**
 * @openapi
 * summary: Mark a registry as the default registry
 * path: id:integer! Registry ID (from GET /api/registries)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-400: The id path segment is not a valid integer
 * resp-403: Caller lacks the settings:edit permission
 * resp-404: No registry exists with that ID
 * resp-500: Failed to set the default registry
 */
export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid registry ID' }, { status: 400 });
		}

		const registry = await getRegistry(id);
		if (!registry) {
			return json({ error: 'Registry not found' }, { status: 404 });
		}

		await setDefaultRegistry(id);
		return json({ success: true });
	} catch (error) {
		console.error('Error setting default registry:', error);
		return json({ error: 'Failed to set default registry' }, { status: 500 });
	}
};
