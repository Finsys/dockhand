import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { revokeApiToken } from '$lib/server/api-tokens';
import { isAuthEnabled } from '$lib/server/auth';
import { getRequestContext } from '$lib/server/request-context';
import { audit } from '$lib/server/audit';

/**
 * DELETE /api/auth/tokens/[id] - Revoke an API token
 *
 * @openapi
 * summary: Revoke (permanently delete) one of the authenticated user's API tokens
 * path: id:integer! Token id (from GET /api/auth/tokens)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-400: Authentication not enabled, or id is not a valid integer
 * resp-401: Not authenticated
 * resp-403: Attempted via Bearer auth (a leaked token cannot revoke other tokens — session required)
 * resp-404: Token not found, or belongs to a different (non-admin) user
 */
export const DELETE: RequestHandler = async (event) => {
	const { cookies, params } = event;

	const authEnabled = await isAuthEnabled();
	if (!authEnabled) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	// Bearer tokens cannot manage tokens (prevent leaked token from revoking others)
	const reqCtx = getRequestContext();
	if (reqCtx?.authMethod === 'bearer') {
		return json({ error: 'Token management requires a cookie session' }, { status: 403 });
	}

	const auth = await authorize(cookies);
	if (!auth.isAuthenticated || !auth.user) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	const tokenId = parseInt(params.id);
	if (isNaN(tokenId)) {
		return json({ error: 'Invalid token ID' }, { status: 400 });
	}

	const success = await revokeApiToken(tokenId, auth.user.id, auth.isAdmin);
	if (!success) {
		return json({ error: 'Token not found or access denied' }, { status: 404 });
	}

	await audit(event, 'delete', 'api_token', {
		entityId: params.id,
		description: `API token revoked`
	});

	return json({ success: true });
};
