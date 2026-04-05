/**
 * API Token Revoke Endpoint
 *
 * DELETE /api/auth/tokens/{id} — Revoke token
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { revokeApiToken } from '$lib/server/api-tokens';
import { audit } from '$lib/server/audit';

/**
 * DELETE /api/auth/tokens/{id}
 */
export const DELETE: RequestHandler = async (event) => {
	const { cookies, params } = event;
	const auth = await authorize(cookies);

	if (!auth.authEnabled) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	if (!auth.isAuthenticated || !auth.user) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	const tokenId = parseInt(params.id, 10);
	if (isNaN(tokenId) || tokenId <= 0) {
		return json({ error: 'Invalid token ID' }, { status: 400 });
	}

	try {
		const success = await revokeApiToken(tokenId, auth.user.id, auth.isAdmin);

		if (!success) {
			return json({ error: 'Token not found or access denied' }, { status: 404 });
		}

		// Audit log (entity is the user, token details in description)
		await audit(event, 'delete', 'user', {
			entityId: String(auth.user.id),
			entityName: auth.user.username,
			description: `API token ${tokenId} revoked by ${auth.user.username}`,
			details: { tokenId, revokedBy: auth.user.id }
		});

		return json({ success: true });
	} catch (error) {
		console.error('[ApiToken] Error revoking token:', error);
		return json({ error: 'Failed to revoke token' }, { status: 500 });
	}
};
