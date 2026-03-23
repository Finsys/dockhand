/**
 * API Token CRUD Endpoints
 *
 * GET  /api/auth/tokens     — List own tokens
 * POST /api/auth/tokens     — Create new token
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { generateApiToken, listUserApiTokens } from '$lib/server/api-tokens';
import { audit } from '$lib/server/audit';

/**
 * GET /api/auth/tokens — List own tokens
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	if (!auth.authEnabled) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	if (!auth.isAuthenticated || !auth.user) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	try {
		const tokens = await listUserApiTokens(auth.user.id);
		return json({ tokens });
	} catch (error) {
		console.error('[ApiToken] Error listing tokens:', error);
		return json({ error: 'Failed to list tokens' }, { status: 500 });
	}
};

/**
 * POST /api/auth/tokens — Create new token
 */
export const POST: RequestHandler = async (event) => {
	const { cookies, request } = event;
	const auth = await authorize(cookies);

	if (!auth.authEnabled) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	if (!auth.isAuthenticated || !auth.user) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	let body: { name?: string; expiresAt?: string | null };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid request body' }, { status: 400 });
	}

	const { name, expiresAt } = body;

	// Validation
	if (!name || typeof name !== 'string' || name.trim().length === 0) {
		return json({ error: 'Name is required' }, { status: 400 });
	}

	if (name.length > 255) {
		return json({ error: 'Name too long (max 255 characters)' }, { status: 400 });
	}

	if (expiresAt !== undefined && expiresAt !== null) {
		const expDate = new Date(expiresAt);
		if (isNaN(expDate.getTime())) {
			return json({ error: 'Invalid date for expiresAt' }, { status: 400 });
		}
		if (expDate <= new Date()) {
			return json({ error: 'expiresAt must be in the future' }, { status: 400 });
		}
	}

	try {
		const result = await generateApiToken(
			auth.user.id,
			name.trim(),
			expiresAt ?? null
		);

		// Audit log (entity is the user, token details in description)
		await audit(event, 'create', 'user', {
			entityId: String(auth.user.id),
			entityName: auth.user.username,
			description: `API token "${name.trim()}" created (prefix: ${result.tokenPrefix})`,
			details: { tokenId: result.tokenId, tokenPrefix: result.tokenPrefix, expiresAt: expiresAt ?? 'never' }
		});

		return json(
			{
				token: result.token,
				id: result.tokenId,
				name: name.trim(),
				tokenPrefix: result.tokenPrefix,
				expiresAt: expiresAt ?? null,
				createdAt: new Date().toISOString(),
				warning: 'This token will not be shown again. Please save it now.'
			},
			{ status: 201 }
		);
	} catch (error) {
		console.error('[ApiToken] Error creating token:', error);
		return json({ error: 'Failed to create token' }, { status: 500 });
	}
};
