import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { getAuthSettings, updateAuthSettings, countAdminUsers } from '$lib/server/db';
import { isEnterprise } from '$lib/server/license';
import { authorize } from '$lib/server/authorize';

// GET /api/auth/settings - Get auth settings
// Public when auth is disabled, requires authentication when enabled
/**
 * @openapi
 * summary: Get the global authentication settings (whether auth is enabled and the default provider)
 * resp-200: {authEnabled:boolean!, defaultProvider:string}
 * resp-200-example: {"authEnabled":true,"defaultProvider":"local"}
 * resp-401: Authentication required (auth is enabled and the caller is not authenticated)
 * resp-403: Permission denied (missing settings:view)
 * resp-500: Failed to read the auth settings
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	// When auth is enabled, require authentication first, then settings:view permission
	if (auth.authEnabled) {
		if (!auth.isAuthenticated) {
			return json({ error: 'Authentication required' }, { status: 401 });
		}
		if (!await auth.can('settings', 'view')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
	}

	try {
		const settings = await getAuthSettings();
		return json(settings);
	} catch (error) {
		console.error('Failed to get auth settings:', error);
		return json({ error: 'Failed to get auth settings' }, { status: 500 });
	}
};

// PUT /api/auth/settings - Update auth settings
// Requires authentication and settings:edit permission
/**
 * @openapi
 * summary: Update the global authentication settings (enabling auth requires at least one admin/user to exist)
 * body: {authEnabled:boolean, defaultProvider:string}
 * body-example: {"authEnabled":true,"defaultProvider":"local"}
 * resp-200: {authEnabled:boolean!, defaultProvider:string}
 * resp-400: Cannot enable authentication without an existing user/admin (response includes requiresUser:true)
 * resp-401: Authentication required (auth is enabled and the caller is not authenticated)
 * resp-403: Permission denied (missing settings:edit)
 * resp-500: Failed to update the auth settings
 */
export const PUT: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);

	// When auth is enabled, require authentication first, then settings:edit permission
	if (auth.authEnabled) {
		if (!auth.isAuthenticated) {
			return json({ error: 'Authentication required' }, { status: 401 });
		}
		if (!await auth.can('settings', 'edit')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
	}

	try {
		const data = await request.json();

		// Check if trying to enable auth without required users
		if (data.authEnabled === true) {
			const userCount = await countAdminUsers();
			// PostgreSQL returns bigint for count(*), convert to number for comparison
			if (Number(userCount) === 0) {
				const enterprise = await isEnterprise();
				const errorMessage = enterprise
					? 'Cannot enable authentication without an admin user. Create a user and assign them the Admin role first.'
					: 'Cannot enable authentication without any users. Create a user first.';
				return json({
					error: errorMessage,
					requiresUser: true
				}, { status: 400 });
			}
		}

		// Enforce minimum session timeout of 1 hour
		if (data.sessionTimeout !== undefined) {
			data.sessionTimeout = Math.max(3600, Math.min(604800, parseInt(data.sessionTimeout) || 86400));
		}

		const settings = await updateAuthSettings(data);
		return json(settings);
	} catch (error) {
		console.error('Failed to update auth settings:', error);
		return json({ error: 'Failed to update auth settings' }, { status: 500 });
	}
};
