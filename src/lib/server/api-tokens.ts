/**
 * API Token Management
 *
 * Provides stateless Bearer token authentication as an alternative to cookie-based sessions.
 * Tokens inherit the full permissions of the creating user.
 *
 * Token format: dh_<32-byte-base64url>
 * Storage: Argon2id hash + 8-character prefix for DB lookup optimization
 */

import { secureGetRandomValues } from './crypto-fallback';
import { hashPassword, verifyPassword, getUserPermissionsById } from './auth';
import {
	db,
	apiTokens,
	users,
	eq,
	and
} from './db/drizzle.js';
import { userHasAdminRole } from './db';
import { isEnterprise } from './license';
import type { AuthenticatedUser } from './auth';

// Token prefix for detection in logs and secret scanners
const TOKEN_PREFIX = 'dh_';
const TOKEN_BYTES = 32;

/**
 * Generate a new API token for a user.
 * The plaintext token is returned ONCE and never stored again.
 *
 * @param userId - ID of the user owning this token
 * @param name - Descriptive name (e.g. "CI/CD Pipeline")
 * @param expiresAt - Optional expiration date (ISO string), null = no expiration
 * @returns { token: plaintext token (once!), tokenId: DB ID, tokenPrefix }
 */
export async function generateApiToken(
	userId: number,
	name: string,
	expiresAt?: string | null
): Promise<{ token: string; tokenId: number; tokenPrefix: string }> {
	// 32 bytes cryptographically secure random data
	const tokenBytes = new Uint8Array(TOKEN_BYTES);
	secureGetRandomValues(tokenBytes);
	const rawToken = TOKEN_PREFIX + Buffer.from(tokenBytes).toString('base64url');

	// Prefix for DB lookup (8 chars after 'dh_')
	const tokenPrefix = rawToken.substring(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 8);

	// Argon2id hash for DB storage
	const tokenHash = await hashPassword(rawToken);

	// Persist to DB
	const now = new Date().toISOString();
	const result = await db
		.insert(apiTokens)
		.values({
			userId,
			name,
			tokenHash,
			tokenPrefix,
			isActive: true,
			expiresAt: expiresAt ?? null,
			createdAt: now,
			updatedAt: now
		})
		.returning({ id: apiTokens.id });

	return {
		token: rawToken, // One-time plaintext
		tokenId: result[0].id,
		tokenPrefix
	};
}

/**
 * Validate a Bearer token and return the associated AuthenticatedUser.
 * Timing-attack resistant: Argon2id verification even on invalid prefix.
 *
 * @param rawToken - Complete token from the Authorization header
 * @returns AuthenticatedUser or null for invalid/expired tokens
 */
export async function validateApiToken(rawToken: string): Promise<AuthenticatedUser | null> {
	// Quick check: format validation
	if (!rawToken.startsWith(TOKEN_PREFIX)) {
		return null;
	}

	const tokenPrefix = rawToken.substring(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 8);

	// Candidate lookup via index (avoids O(n) Argon2id computations)
	const candidates = await db
		.select()
		.from(apiTokens)
		.where(
			and(
				eq(apiTokens.tokenPrefix, tokenPrefix),
				eq(apiTokens.isActive, true)
			)
		);

	// Timing-attack protection: run hash operation even with no candidates
	if (candidates.length === 0) {
		// Dummy verification prevents timing leak from different response times
		await verifyPassword(
			rawToken,
			'$argon2id$v=19$m=65536,t=3,p=1$dummysalt1234567$dummyhash12345678901234567890123456789012'
		);
		return null;
	}

	// Hash verification (Argon2id, constant-time)
	for (const candidate of candidates) {
		try {
			// Expiration check
			if (candidate.expiresAt && new Date(candidate.expiresAt) < new Date()) {
				// Deactivate expired token (lazy)
				await db
					.update(apiTokens)
					.set({ isActive: false, updatedAt: new Date().toISOString() })
					.where(eq(apiTokens.id, candidate.id));
				continue;
			}

			const isValid = await verifyPassword(rawToken, candidate.tokenHash);

			if (isValid) {
				// Update last_used (fire-and-forget)
				db.update(apiTokens)
					.set({ lastUsed: new Date().toISOString() })
					.where(eq(apiTokens.id, candidate.id))
					.catch((err: unknown) => console.error('[ApiToken] Failed to update last_used:', err));

				// Load user and build AuthenticatedUser
				const userResult = await db
					.select()
					.from(users)
					.where(and(eq(users.id, candidate.userId), eq(users.isActive, true)));

				if (userResult.length === 0) return null;

				const user = userResult[0];
				const permissions = await getUserPermissionsById(user.id);
				const enterprise = await isEnterprise();
				const isAdmin = enterprise ? await userHasAdminRole(user.id) : true;

				return {
					id: user.id,
					username: user.username,
					email: user.email ?? undefined,
					displayName: user.displayName ?? undefined,
					avatar: user.avatar ?? undefined,
					isAdmin,
					provider: (user.authProvider?.split(':')[0] as 'local' | 'ldap' | 'oidc') || 'local',
					permissions
				};
			}
		} catch {
			// Invalid hash format, continue checking
			continue;
		}
	}

	return null;
}

/**
 * List all API tokens of a user (without token_hash).
 */
export async function listUserApiTokens(userId: number) {
	return db
		.select({
			id: apiTokens.id,
			name: apiTokens.name,
			tokenPrefix: apiTokens.tokenPrefix,
			lastUsed: apiTokens.lastUsed,
			expiresAt: apiTokens.expiresAt,
			isActive: apiTokens.isActive,
			createdAt: apiTokens.createdAt
		})
		.from(apiTokens)
		.where(eq(apiTokens.userId, userId))
		.orderBy(apiTokens.createdAt);
}

/**
 * Revoke an API token (sets is_active = false).
 * Returns false if token not found or not owned by user.
 */
export async function revokeApiToken(
	tokenId: number,
	userId: number,
	isAdmin: boolean
): Promise<boolean> {
	// Load token for ownership check
	const tokenResult = await db
		.select({ id: apiTokens.id, userId: apiTokens.userId })
		.from(apiTokens)
		.where(eq(apiTokens.id, tokenId));

	if (tokenResult.length === 0) return false;

	const token = tokenResult[0];

	// Only owner or admin may revoke
	if (token.userId !== userId && !isAdmin) return false;

	await db
		.update(apiTokens)
		.set({ isActive: false, updatedAt: new Date().toISOString() })
		.where(eq(apiTokens.id, tokenId));

	return true;
}
