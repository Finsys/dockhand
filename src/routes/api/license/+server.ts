import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getLicenseStatus,
	activateLicense,
	deactivateLicense,
	getHostname
} from '$lib/server/license';
import { authorize } from '$lib/server/authorize';
import { clearTokenCache } from '$lib/server/api-tokens';

// GET /api/license - Get current license status
// Any authenticated user can view license status (needed to determine if RBAC applies)
/**
 * @openapi
 * summary: Get the current license status plus the server hostname the license is bound to
 * resp-200: The license status object merged with the current hostname
 * resp-401: Authentication required (auth is enabled and the caller is not authenticated)
 * resp-500: Failed to read the license status
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	try {
		const status = await getLicenseStatus();
		const hostname = getHostname();

		return json({
			...status,
			hostname
		});
	} catch (error) {
		console.error('Error getting license status:', error);
		return json(
			{ error: 'Failed to get license status' },
			{ status: 500 }
		);
	}
};

// POST /api/license - Activate a license
/**
 * @openapi
 * summary: Activate a license by name and key
 * body: {name:string!, key:string!}
 * body-example: {"name":"ACME Corp","key":"***"}
 * resp-200: {success:boolean!, license:{}}
 * resp-400: Name and key are required, or activation was rejected (invalid key)
 * resp-403: Permission denied (missing license:manage)
 * resp-500: Failed to activate the license
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('license', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const { name, key } = await request.json();

		if (!name || !key) {
			return json(
				{ error: 'Name and key are required' },
				{ status: 400 }
			);
		}

		const result = await activateLicense(name, key);

		if (!result.success) {
			return json(
				{ error: result.error },
				{ status: 400 }
			);
		}

		// Permission model changes between free/enterprise — clear cached tokens
		clearTokenCache();

		return json({
			success: true,
			license: result.license
		});
	} catch (error) {
		console.error('Error activating license:', error);
		return json(
			{ error: 'Failed to activate license' },
			{ status: 500 }
		);
	}
};

// DELETE /api/license - Deactivate license
/**
 * @openapi
 * summary: Deactivate the currently active license
 * resp-200: {success:boolean!}
 * resp-403: Permission denied (missing license:manage)
 * resp-500: Failed to deactivate the license
 */
export const DELETE: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('license', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		await deactivateLicense();
		// Permission model changes between free/enterprise — clear cached tokens
		clearTokenCache();
		return json({ success: true });
	} catch (error) {
		console.error('Error deactivating license:', error);
		return json(
			{ error: 'Failed to deactivate license' },
			{ status: 500 }
		);
	}
};
