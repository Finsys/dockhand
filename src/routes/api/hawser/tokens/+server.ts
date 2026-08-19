/**
 * Hawser Token Management API
 *
 * Handles CRUD operations for Hawser agent tokens.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { db, hawserTokens, eq, desc } from '$lib/server/db/drizzle';
import { generateHawserToken, revokeHawserToken } from '$lib/server/hawser';

/**
 * GET /api/hawser/tokens
 * List all Hawser tokens (without revealing full token values)
 */
/**
 * @openapi
 * summary: List all Hawser agent tokens (only the prefix is returned, never the full token)
 * resp-200: array<{id:integer!, tokenPrefix:string!, name:string!, environmentId:integer!, isActive:boolean!, lastUsed:string, createdAt:string!, expiresAt:string}>
 * resp-200-example: [{"id":1,"tokenPrefix":"hw_abc123","name":"edge-01","environmentId":1,"isActive":true,"lastUsed":null,"createdAt":"2026-06-01T10:00:00Z","expiresAt":null}]
 * resp-401: Not authenticated
 * resp-403: Admin access required
 * resp-500: Failed to read the tokens
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	try {
		const tokens = await db
			.select({
				id: hawserTokens.id,
				tokenPrefix: hawserTokens.tokenPrefix,
				name: hawserTokens.name,
				environmentId: hawserTokens.environmentId,
				isActive: hawserTokens.isActive,
				lastUsed: hawserTokens.lastUsed,
				createdAt: hawserTokens.createdAt,
				expiresAt: hawserTokens.expiresAt
			})
			.from(hawserTokens)
			.orderBy(desc(hawserTokens.createdAt));

		return json(tokens);
	} catch (error) {
		console.error('Error fetching Hawser tokens:', error);
		return json({ error: 'Failed to fetch tokens' }, { status: 500 });
	}
};

/**
 * POST /api/hawser/tokens
 * Generate a new Hawser token
 *
 * Body: { name: string, environmentId: number, expiresAt?: string }
 * Returns: { token: string, tokenId: number } - token is only shown ONCE
 */
/**
 * @openapi
 * summary: Generate a new Hawser agent token for an environment (the plaintext token is returned only once)
 * description: environmentId from GET /api/environments.
 * body: {name:string!, environmentId:integer!, expiresAt:string, rawToken:string}
 * body-example: {"name":"edge-01","environmentId":1,"expiresAt":"2027-01-01T00:00:00Z"}
 * resp-200: {token:string!, tokenId:integer!, message:string!}
 * resp-200-desc: Token generated — the plaintext token is shown only once and cannot be retrieved again
 * resp-200-example: {"token":"***","tokenId":42,"message":"Token generated successfully. Save this token - it will not be shown again."}
 * resp-400: The name or environmentId field is missing or of the wrong type
 * resp-401: Not authenticated
 * resp-403: Admin access required
 * resp-500: Failed to generate the token
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { name, environmentId, expiresAt, rawToken } = body;

		if (!name || typeof name !== 'string') {
			return json({ error: 'Token name is required' }, { status: 400 });
		}

		if (!environmentId || typeof environmentId !== 'number') {
			return json({ error: 'Environment ID is required' }, { status: 400 });
		}

		const result = await generateHawserToken(name, environmentId, expiresAt, rawToken);

		return json({
			token: result.token,
			tokenId: result.tokenId,
			message: 'Token generated successfully. Save this token - it will not be shown again.'
		});
	} catch (error) {
		console.error('Error generating Hawser token:', error);
		return json({ error: 'Failed to generate token' }, { status: 500 });
	}
};

/**
 * DELETE /api/hawser/tokens
 * Delete (revoke) a token by ID
 *
 * Query: ?id=<token_id>
 */
/**
 * @openapi
 * summary: Revoke a Hawser agent token by ID
 * query: id:integer! ID of the token to revoke (from GET /api/hawser/tokens)
 * resp-200: {success:boolean!, message:string!}
 * resp-200-example: {"success":true,"message":"Token revoked"}
 * resp-400: The id query parameter is missing
 * resp-401: Not authenticated
 * resp-403: Admin access required
 * resp-500: Failed to revoke the token
 */
export const DELETE: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	const tokenId = url.searchParams.get('id');
	if (!tokenId) {
		return json({ error: 'Token ID is required' }, { status: 400 });
	}

	try {
		await revokeHawserToken(parseInt(tokenId, 10));
		return json({ success: true, message: 'Token revoked' });
	} catch (error) {
		console.error('Error revoking Hawser token:', error);
		return json({ error: 'Failed to revoke token' }, { status: 500 });
	}
};
