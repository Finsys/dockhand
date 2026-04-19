/**
 * API Token Management
 *
 * Provides Bearer token authentication for CI/CD pipelines and scripts.
 * Tokens use `dh_` prefix, Argon2id hashing, and prefix-based lookup.
 *
 * Performance: An in-memory cache (SHA-256 key, 60s TTL) avoids running
 * Argon2id on every request. First request: ~100ms. Subsequent: ~0ms.
 */

import { createHash } from 'node:crypto';
import { db, eq, and } from '$lib/server/db/drizzle';
import { hashPassword, verifyPassword, type AuthenticatedUser } from './auth';
import { secureRandomBytes } from './crypto-fallback';
import { getUserRoles, userHasAdminRole, type Permissions } from './db';
import { isEnterprise } from './license';
import { tokenCache, ensureCleanupInterval, invalidateTokenCacheForUser, clearTokenCache } from './token-cache';

// Re-export cache functions so existing consumers don't need to change imports
export { invalidateTokenCacheForUser, clearTokenCache } from './token-cache';

// Dynamic schema import (same pattern as db.ts)
let apiTokensTable: any;

async function getApiTokensTable() {
	if (apiTokensTable) return apiTokensTable;
	const isPostgres = !!(process.env.DATABASE_URL && (
		process.env.DATABASE_URL.startsWith('postgres://') ||
		process.env.DATABASE_URL.startsWith('postgresql://')
	));
	const schema = isPostgres
		? await import('./db/schema/pg-schema.js')
		: await import('./db/schema/index.js');
	apiTokensTable = schema.apiTokens;
	return apiTokensTable;
}

// Token format: dh_ + 32 bytes base64url = dh_ + 43 chars
const TOKEN_PREFIX = 'dh_';
const TOKEN_BYTES = 32;
const PREFIX_LENGTH = 8; // chars after dh_ stored for identification
const MAX_TOKEN_LENGTH = 200;
const CACHE_TTL = 60_000; // 60 seconds

function cacheKey(rawToken: string): string {
	return createHash('sha256').update(rawToken).digest('hex');
}

// Pre-computed dummy hash for timing protection on invalid prefixes
let dummyHash: string | null = null;

async function getDummyHash(): Promise<string> {
	if (!dummyHash) {
		dummyHash = await hashPassword('dh_dummy_token_for_timing_protection');
	}
	return dummyHash;
}

// Initialize dummy hash on import (fire and forget)
void getDummyHash();

/**
 * Generate a new API token.
 * Returns the plaintext token (shown once) and the database record.
 */
export async function generateApiToken(
	userId: number,
	name: string,
	expiresAt?: string | null
): Promise<{ token: string; id: number; tokenPrefix: string }> {
	const table = await getApiTokensTable();

	// Generate random token
	const randomBytes = secureRandomBytes(TOKEN_BYTES);
	const rawToken = TOKEN_PREFIX + randomBytes.toString('base64url');
	const tokenPrefix = rawToken.substring(TOKEN_PREFIX.length, TOKEN_PREFIX.length + PREFIX_LENGTH);

	// Hash for storage
	const tokenHash = await hashPassword(rawToken);

	const result = await db.insert(table).values({
		userId,
		name,
		tokenHash,
		tokenPrefix,
		expiresAt: expiresAt || null
	}).returning();

	return {
		token: rawToken,
		id: result[0].id,
		tokenPrefix
	};
}

/**
 * Validate a Bearer token and return the associated user.
 * Uses cache to avoid Argon2id on every request.
 */
export async function validateApiToken(rawToken: string): Promise<AuthenticatedUser | null> {
	// Input validation
	if (!rawToken || rawToken.length > MAX_TOKEN_LENGTH || !rawToken.startsWith(TOKEN_PREFIX)) {
		return null;
	}

	// Check cache first
	ensureCleanupInterval();
	const key = cacheKey(rawToken);
	const cached = tokenCache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.user;
	}

	const table = await getApiTokensTable();

	// Extract prefix for lookup
	const prefix = rawToken.substring(TOKEN_PREFIX.length, TOKEN_PREFIX.length + PREFIX_LENGTH);

	// Find tokens with matching prefix (deleted tokens are gone, no isActive filter needed)
	const candidates = await db
		.select()
		.from(table)
		.where(eq(table.tokenPrefix, prefix));

	if (candidates.length === 0) {
		// Timing protection: run Argon2id anyway
		await verifyPassword(rawToken, await getDummyHash());
		return null;
	}

	// Verify against each candidate (usually just one)
	for (const candidate of candidates) {
		const valid = await verifyPassword(rawToken, candidate.tokenHash);
		if (!valid) continue;

		// Check expiration AFTER hash verification to avoid timing oracle
		if (candidate.expiresAt && new Date(candidate.expiresAt) < new Date()) {
			continue;
		}

		// Build AuthenticatedUser from the token's user
		const user = await buildUserFromToken(candidate);
		if (!user) continue;

		// Update lastUsed (fire and forget — non-critical audit field)
		void db.update(table)
			.set({ lastUsed: new Date().toISOString() })
			.where(eq(table.id, candidate.id))
			.catch((err) => {
				if (typeof process !== 'undefined' && process.env.DB_VERBOSE_LOGGING === 'true') {
					console.debug('[api-tokens] lastUsed update failed:', err?.message);
				}
			});

		// Cache the result — cap TTL at token expiry time if sooner
		let cacheTtl = CACHE_TTL;
		if (candidate.expiresAt) {
			const timeUntilExpiry = new Date(candidate.expiresAt).getTime() - Date.now();
			if (timeUntilExpiry < cacheTtl) {
				cacheTtl = Math.max(0, timeUntilExpiry);
			}
		}
		tokenCache.set(key, { user, expiresAt: Date.now() + cacheTtl });

		return user;
	}

	return null;
}

/**
 * Build an AuthenticatedUser from a token's database record.
 */
async function buildUserFromToken(tokenRecord: any): Promise<AuthenticatedUser | null> {
	// Import getUserWithoutPassword dynamically to avoid circular deps
	// This avoids keeping passwordHash in memory unnecessarily
	const { getUserWithoutPassword } = await import('./db');

	const dbUser = await getUserWithoutPassword(tokenRecord.userId);
	if (!dbUser || !dbUser.isActive) return null;

	const enterprise = await isEnterprise();
	let isAdmin = false;
	let permissions: Permissions;

	if (!enterprise) {
		// Free edition: everyone is effectively admin
		isAdmin = true;
		const { getRoleByName } = await import('./db');
		const adminRole = await getRoleByName('Admin');
		permissions = adminRole?.permissions ?? {} as Permissions;
	} else {
		isAdmin = await userHasAdminRole(dbUser.id);
		const userRoleAssignments = await getUserRoles(dbUser.id);
		// Merge permissions from all roles
		permissions = {} as Permissions;
		for (const assignment of userRoleAssignments) {
			if (!assignment.role) continue;
			const rolePerms = typeof assignment.role.permissions === 'string'
				? JSON.parse(assignment.role.permissions)
				: assignment.role.permissions;
			if (!rolePerms) continue;
			for (const [key, actions] of Object.entries(rolePerms)) {
				if (!permissions[key as keyof Permissions]) {
					permissions[key as keyof Permissions] = [];
				}
				for (const action of actions as string[]) {
					if (!permissions[key as keyof Permissions].includes(action)) {
						permissions[key as keyof Permissions].push(action);
					}
				}
			}
		}
	}

	// Determine provider from authProvider field
	let provider: 'local' | 'ldap' | 'oidc' = 'local';
	if (dbUser.authProvider?.startsWith('ldap')) provider = 'ldap';
	else if (dbUser.authProvider?.startsWith('oidc')) provider = 'oidc';

	return {
		id: dbUser.id,
		username: dbUser.username,
		email: dbUser.email ?? undefined,
		displayName: dbUser.displayName ?? undefined,
		avatar: dbUser.avatar ?? undefined,
		isAdmin,
		provider,
		permissions
	};
}

/**
 * List all tokens for a user (no hashes returned).
 */
export async function listUserTokens(userId: number) {
	const table = await getApiTokensTable();
	return db
		.select({
			id: table.id,
			name: table.name,
			tokenPrefix: table.tokenPrefix,
			lastUsed: table.lastUsed,
			expiresAt: table.expiresAt,
			createdAt: table.createdAt
		})
		.from(table)
		.where(eq(table.userId, userId));
}

/**
 * Revoke (delete) a token. Owner or admin can revoke.
 */
export async function revokeApiToken(tokenId: number, requestingUserId: number, isAdmin: boolean): Promise<boolean> {
	const table = await getApiTokensTable();

	// Find the token
	const [token] = await db.select().from(table).where(eq(table.id, tokenId));
	if (!token) return false;

	// Check ownership or admin
	if (token.userId !== requestingUserId && !isAdmin) {
		return false;
	}

	// Hard-delete
	await db.delete(table).where(eq(table.id, tokenId));

	// Clear cache — we can't map prefix to SHA-256 cache keys, so clear all
	clearTokenCache();

	return true;
}

