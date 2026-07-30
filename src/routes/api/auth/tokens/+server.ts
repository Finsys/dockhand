import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { generateApiToken, listUserTokens } from '$lib/server/api-tokens';
import { isAuthEnabled, verifyPassword } from '$lib/server/auth';
import { getUser } from '$lib/server/db';
import { audit } from '$lib/server/audit';
import { getRequestContext } from '$lib/server/request-context';

// Password confirmation rate limiting (per userId)
const pwFailCounts = new Map<number, { count: number; firstFail: number }>();
const pwCooldowns = new Map<number, number>();
const PW_FAIL_WINDOW = 60_000; // 1-minute sliding window
const PW_FAIL_MAX = 5; // max failures per window
const PW_COOLDOWN = 5 * 60 * 1000; // 5-minute cooldown

const MAX_TOKENS_PER_USER = 25;

// Periodic cleanup
setInterval(() => {
	const now = Date.now();
	for (const [id, until] of pwCooldowns) {
		if (now > until) pwCooldowns.delete(id);
	}
	for (const [id, entry] of pwFailCounts) {
		if (now - entry.firstFail > PW_FAIL_WINDOW) pwFailCounts.delete(id);
	}
}, PW_COOLDOWN).unref?.();

function isPwRateLimited(userId: number): boolean {
	const until = pwCooldowns.get(userId);
	if (!until) return false;
	if (Date.now() > until) {
		pwCooldowns.delete(userId);
		return false;
	}
	return true;
}

function recordPwFailure(userId: number): void {
	const now = Date.now();
	const entry = pwFailCounts.get(userId);
	if (!entry || now - entry.firstFail > PW_FAIL_WINDOW) {
		pwFailCounts.set(userId, { count: 1, firstFail: now });
		return;
	}
	entry.count++;
	if (entry.count >= PW_FAIL_MAX) {
		pwCooldowns.set(userId, now + PW_COOLDOWN);
		pwFailCounts.delete(userId);
	}
}

/**
 * GET /api/auth/tokens - List the current user's API tokens
 *
 * @openapi
 * summary: List the authenticated user's API tokens (never returns the hash/secret)
 * resp-200: array<{id:integer!, name:string!, tokenPrefix:string!, lastUsed:string, expiresAt:string, createdAt:string!}>
 * resp-200-example: [{"id":1,"name":"CI/CD Pipeline","tokenPrefix":"a1b2c3d4","lastUsed":"2027-01-02T08:00:00Z","expiresAt":"2027-01-01T00:00:00Z","createdAt":"2026-06-01T10:00:00Z"}]
 * resp-400: Authentication is not enabled
 * resp-401: Not authenticated
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const authEnabled = await isAuthEnabled();
	if (!authEnabled) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const auth = await authorize(cookies);
	if (!auth.isAuthenticated || !auth.user) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	const tokens = await listUserTokens(auth.user.id);
	return json(tokens);
};

/**
 * POST /api/auth/tokens - Create a new API token
 *
 * @openapi
 * summary: Create a new API token for the authenticated user (requires a session, not a Bearer token)
 * body: {name:string!, expiresAt:string, password:string}
 * body-example: {"name":"CI/CD Pipeline","expiresAt":"2027-01-01T00:00:00Z","password":"correct horse battery staple"}
 * resp-201: {token:string!, id:integer!, tokenPrefix:string!}
 * resp-201-desc: Token created — the plaintext value is shown ONLY this once and cannot be retrieved again
 * resp-201-example: {"token":"dh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","id":42,"tokenPrefix":"a1b2c3d4"}
 * resp-400: Invalid body, missing password for local users, or MAX_TOKENS_PER_USER (25) reached
 * resp-401: Not authenticated
 * resp-403: Token creation attempted via Bearer auth (session login required) or wrong password
 * resp-404: User record not found while confirming the password (local provider)
 * resp-429: Too many failed password confirmation attempts (rate limited)
 */
export const POST: RequestHandler = async (event) => {
	const { cookies, request } = event;

	const authEnabled = await isAuthEnabled();
	if (!authEnabled) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const auth = await authorize(cookies);
	if (!auth.isAuthenticated || !auth.user) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	// Token creation requires a cookie session — a Bearer token cannot create new tokens
	const reqCtx = getRequestContext();
	if (reqCtx?.authMethod === 'bearer') {
		return json({ error: 'Token creation requires a session login, not a Bearer token' }, { status: 403 });
	}

	let body: any;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid request body' }, { status: 400 });
	}
	const { name, expiresAt, password } = body;

	// Local users must confirm their password to create tokens
	// SSO/OIDC and LDAP users skip this (they authenticated via their IdP)
	if (auth.user.provider === 'local') {
		if (isPwRateLimited(auth.user.id)) {
			return json({ error: 'Too many failed password attempts. Try again later.' }, { status: 429 });
		}
		if (!password || typeof password !== 'string') {
			return json({ error: 'Password is required to create an API token' }, { status: 400 });
		}
		const dbUser = await getUser(auth.user.id);
		if (!dbUser) {
			return json({ error: 'User not found' }, { status: 404 });
		}
		const valid = await verifyPassword(password, dbUser.passwordHash);
		if (!valid) {
			recordPwFailure(auth.user.id);
			return json({ error: 'Invalid password' }, { status: 403 });
		}
	}

	// L2: Per-user token count limit
	const existingTokens = await listUserTokens(auth.user.id);
	if (existingTokens.length >= MAX_TOKENS_PER_USER) {
		return json({ error: `Maximum of ${MAX_TOKENS_PER_USER} API tokens per user` }, { status: 400 });
	}

	// Validate name
	if (!name || typeof name !== 'string' || name.trim().length === 0) {
		return json({ error: 'Token name is required' }, { status: 400 });
	}
	if (name.length > 255) {
		return json({ error: 'Token name must be 255 characters or less' }, { status: 400 });
	}

	// Validate expiration
	if (expiresAt) {
		const expiryDate = new Date(expiresAt);
		if (isNaN(expiryDate.getTime())) {
			return json({ error: 'Invalid expiration date' }, { status: 400 });
		}
		if (expiryDate <= new Date()) {
			return json({ error: 'Expiration date must be in the future' }, { status: 400 });
		}
	}

	const result = await generateApiToken(
		auth.user.id,
		name.trim(),
		expiresAt || null
	);

	await audit(event, 'create', 'api_token', {
		entityId: String(result.id),
		entityName: name.trim(),
		description: `API token "${name.trim()}" created`
	});

	return json({
		id: result.id,
		token: result.token,
		tokenPrefix: result.tokenPrefix
	}, { status: 201, headers: { 'Cache-Control': 'no-store' } });
};
