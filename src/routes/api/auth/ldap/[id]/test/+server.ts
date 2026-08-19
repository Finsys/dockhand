import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { testLdapConnection } from '$lib/server/auth';
import { authorize } from '$lib/server/authorize';
import { getLdapConfig } from '$lib/server/db';

// POST /api/auth/ldap/[id]/test - Test LDAP connection
/**
 * @openapi
 * summary: Test connectivity of a stored LDAP configuration by id (enterprise only)
 * path: id:integer! Numeric id of the LDAP configuration to test (from GET /api/auth/ldap)
 * resp-200: Connection test result (success flag plus diagnostic detail from the LDAP server)
 * resp-400: Invalid id (not a number)
 * resp-401: Authentication required (auth is enabled and the caller is not an authenticated admin)
 * resp-403: Enterprise license required
 * resp-404: LDAP configuration not found
 * resp-500: Failed to test the LDAP connection
 */
export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	// Allow access when auth is disabled (setup mode) or when user is admin
	if (auth.authEnabled && (!auth.isAuthenticated || !auth.isAdmin)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!auth.isEnterprise) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	const id = parseInt(params.id!, 10);
	if (isNaN(id)) {
		return json({ error: 'Invalid ID' }, { status: 400 });
	}

	try {
		const config = await getLdapConfig(id);
		if (!config) {
			return json({ error: 'LDAP configuration not found' }, { status: 404 });
		}

		const result = await testLdapConnection(id);
		return json(result);
	} catch (error) {
		console.error('Failed to test LDAP connection:', error);
		return json({ error: 'Failed to test LDAP connection' }, { status: 500 });
	}
};
