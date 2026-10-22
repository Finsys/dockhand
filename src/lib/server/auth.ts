/**
 * Core Authentication Module
 *
 * Security features:
 * - Argon2id password hashing via argon2 (memory-hard, timing-attack resistant)
 * - Cryptographically secure 32-byte random session tokens
 * - HttpOnly cookies (prevents XSS from reading tokens)
 * - Secure flag (protocol-aware: x-forwarded-proto or COOKIE_SECURE env var, default off)
 * - SameSite=Strict (CSRF protection)
 */

import os from 'node:os';
import { createHash, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import type { Cookies } from '@sveltejs/kit';
import {
	getAuthSettings,
	getUser,
	getUserByUsername,
	getSession as dbGetSession,
	createSession as dbCreateSession,
	deleteSession as dbDeleteSession,
	deleteExpiredSessions,
	updateUser,
	createUser,
	getUserRoles,
	getUserRolesForEnvironment,
	getUserAccessibleEnvironments,
	userCanAccessEnvironment,
	userHasAdminRole,
	getRoleByName,
	assignUserRole,
	removeUserRole,
	getLdapConfigs,
	getLdapConfig,
	getOidcConfigs,
	getOidcConfig,
	type User,
	type Session,
	type Permissions,
	type LdapConfig,
	type OidcConfig
} from './db';
import { Client as LdapClient } from 'ldapts';
import { resolveSessionTimeout, cookieMaxAge } from '$lib/utils/session-timeout';
import { escapeLdapFilterValue } from './ldap-filter';
import { isEnterprise, isLicenseLapsed } from './license';
import { secureRandomBytes } from './crypto-fallback';
import { invalidateTokenCacheForUser } from './token-cache';
import { encrypt, decrypt, looksLikeCiphertext } from './encryption';
import { oidcDiscoveryUrls, fetchOidcDiscovery } from '$lib/utils/oidc-discovery-url';
import { createRemoteJWKSet } from 'jose';
import { verifyIdTokenWithKeys } from './oidc-token-core';
import {
	requireIdToken,
	rejectedToken,
	applyUserinfo,
	describeTokenExchangeFailure,
	redactTokenErrorBody
} from './oidc-callback-core';
import { OIDC_END_SESSION } from './features';
import { providerKind, oidcProviderName } from './provider-kind-core';
import {
	OIDC_STATE_TTL_SECONDS,
	loginStateCookieName,
	loginStateCookiesToEvict,
	encodeLoginState,
	type OidcLoginState
} from './oidc-login-state';
import {
	mergeUserinfo,
	claimsGrantAdmin,
	identityFromClaims,
	rolesFromClaims,
	type Claims
} from './oidc-claims-core';

// Session cookie name
const SESSION_COOKIE_NAME = 'dockhand_session';

// Default empty permissions
const EMPTY_PERMISSIONS: Permissions = {
	containers: [],
	images: [],
	volumes: [],
	networks: [],
	stacks: [],
	environments: [],
	registries: [],
	notifications: [],
	configsets: [],
	settings: [],
	users: [],
	git: [],
	license: [],
	audit_logs: [],
	activity: [],
	schedules: [],
	secrets: [],
	backups: []
};

/**
 * Get Admin role permissions from the database.
 * Falls back to EMPTY_PERMISSIONS if Admin role not found.
 */
async function getAdminPermissions(): Promise<Permissions> {
	const adminRole = await getRoleByName('Admin');
	return adminRole?.permissions ?? EMPTY_PERMISSIONS;
}

export interface AuthenticatedUser {
	id: number;
	username: string;
	email?: string;
	displayName?: string;
	avatar?: string;
	isAdmin: boolean;
	provider: 'local' | 'ldap' | 'oidc' | 'passkey';
	permissions: Permissions;
}

export interface LoginResult {
	success: boolean;
	error?: string;
	requiresMfa?: boolean;
	user?: AuthenticatedUser;
}

// ============================================
// Password Hashing (Argon2id)
// ============================================

// Argon2id parameters
const ARGON2_MEMORY_COST = 65536; // 64 MB in kibibytes
const ARGON2_TIME_COST = 3;       // 3 iterations
const ARGON2_PARALLELISM = 1;     // Single-threaded
const ARGON2_HASH_LENGTH = 32;    // 256-bit output

/**
 * Hash a password using Argon2id
 *
 * Uses the argon2 npm package (C binding) for native performance.
 * Returns PHC format: $argon2id$v=19$m=65536,t=3,p=1$...
 */
export async function hashPassword(password: string): Promise<string> {
	return argon2.hash(password, {
		type: argon2.argon2id,
		memoryCost: ARGON2_MEMORY_COST,
		timeCost: ARGON2_TIME_COST,
		parallelism: ARGON2_PARALLELISM,
		hashLength: ARGON2_HASH_LENGTH
	});
}

/**
 * Verify a password against a hash
 * Uses constant-time comparison internally
 *
 * The argon2 npm package uses standard PHC format, compatible with existing hashes
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	try {
		return await argon2.verify(hash, password);
	} catch (e) {
		console.error('[Auth] argon2.verify() threw unexpectedly:', e);
		return false;
	}
}

let dummyAuthHashCache: Promise<string> | null = null;
export function getDummyAuthHash(): Promise<string> {
	if (!dummyAuthHashCache) {
		dummyAuthHashCache = hashPassword(`dummy-${Math.random()}-${Date.now()}`);
	}
	return dummyAuthHashCache;
}

// ============================================
// Session Management
// ============================================

/**
 * Generate a cryptographically secure session token
 * 32 bytes = 256 bits of entropy
 */
function generateSessionToken(): string {
	return secureRandomBytes(32).toString('base64url');
}

/**
 * Determine whether to set the Secure flag on the session cookie.
 *
 * Priority:
 * 1. COOKIE_SECURE env var ('true' / 'false') — explicit override
 * 2. x-forwarded-proto header — set by Traefik / Nginx / Caddy
 * 3. false — default, matches v1.0.18 Bun behavior
 *
 * Defaulting to false (not NODE_ENV) is intentional: Dockhand is commonly
 * run over plain HTTP in homelabs. Setting Secure unconditionally in production
 * causes a login loop when there is no HTTPS reverse proxy, because browsers
 * silently discard Secure cookies on HTTP connections.
 *
 * Users behind an HTTPS reverse proxy get Secure cookies automatically via
 * x-forwarded-proto. Users who terminate TLS in the app itself can opt in
 * with COOKIE_SECURE=true.
 */
function isSecureContext(request?: Request): boolean {
	if (process.env.COOKIE_SECURE === 'false') return false;
	if (process.env.COOKIE_SECURE === 'true') return true;
	if (request) {
		const proto = request.headers.get('x-forwarded-proto');
		if (proto === 'https') return true;
	}
	return false;
}

/**
 * Create a new session for a user
 * @param provider - Auth provider: 'local', or provider name like 'Keycloak', 'Azure AD', etc.
 * @param request  - Optional incoming request (used to detect HTTPS via x-forwarded-proto)
 */
export async function createUserSession(
	userId: number,
	provider: string,
	cookies: Cookies,
	request?: Request
): Promise<Session> {
	// Clean up expired sessions periodically
	await deleteExpiredSessions();

	// Generate secure token
	const sessionId = generateSessionToken();

	// Get session timeout from settings (0 = never expire, see resolveSessionTimeout).
	const settings = await getAuthSettings();
	const sessionTimeout = resolveSessionTimeout(settings?.sessionTimeout);
	const expiresAt = new Date(Date.now() + sessionTimeout * 1000).toISOString();

	// Create session in database
	const session = await dbCreateSession(sessionId, userId, provider, expiresAt);

	// Cookie max-age is capped at the browser's ~400-day limit; the DB session outlives it.
	setSessionCookie(cookies, sessionId, cookieMaxAge(sessionTimeout), request);

	// Update user's last login time
	await updateUser(userId, { lastLogin: new Date().toISOString() });

	return session;
}

/**
 * Set the session cookie with secure attributes
 */
function setSessionCookie(cookies: Cookies, sessionId: string, maxAge: number, request?: Request): void {
	cookies.set(SESSION_COOKIE_NAME, sessionId, {
		path: '/',
		httpOnly: true,                    // Prevents XSS attacks from reading cookie
		secure: isSecureContext(request),  // Protocol-aware: checks x-forwarded-proto or NODE_ENV
		sameSite: 'lax',                   // Lax required for OIDC/SSO cross-site redirects
		maxAge: maxAge                     // Session timeout in seconds
	});
}

/**
 * Get the session ID from cookies
 */
function getSessionIdFromCookies(cookies: Cookies): string | null {
	return cookies.get(SESSION_COOKIE_NAME) || null;
}

/**
 * Validate a session and return the authenticated user
 */
export async function validateSession(cookies: Cookies): Promise<AuthenticatedUser | null> {
	const sessionId = getSessionIdFromCookies(cookies);
	if (!sessionId) return null;
	return validateSessionById(sessionId);
}

/**
 * Validate a session by raw session ID (without the SvelteKit Cookies object).
 *
 * Used by WebSocket upgrade handlers in server.js / vite.config.ts that only
 * have a raw Cookie header string. Mirrors validateSession() semantics:
 * returns the AuthenticatedUser on success, null on missing/expired/disabled.
 */
export async function validateSessionById(sessionId: string): Promise<AuthenticatedUser | null> {
	if (!sessionId) return null;

	const session = await dbGetSession(sessionId);
	if (!session) return null;

	const expiresAt = new Date(session.expiresAt);
	if (expiresAt < new Date()) {
		await dbDeleteSession(sessionId);
		return null;
	}

	const user = await getUser(session.userId);
	if (!user || !user.isActive) return null;

	return await buildAuthenticatedUser(user, providerKind(session.provider));
}

/**
 * Cookie name used for browser session auth. Exported so raw header parsers
 * (WebSocket upgrade handlers) can look it up without re-encoding the
 * constant.
 */
export const SESSION_COOKIE = SESSION_COOKIE_NAME;

/**
 * Destroy a session (logout)
 */
export async function destroySession(cookies: Cookies): Promise<void> {
	const sessionId = getSessionIdFromCookies(cookies);
	if (sessionId) {
		await dbDeleteSession(sessionId);
	}

	// Clear the cookie
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
}

/**
 * Where to send somebody so the identity provider ends its session too.
 *
 * Signing out of Dockhand alone leaves the provider's session open, so the next
 * sign-in goes straight back to the same account without asking - which is not what
 * anybody means by signing out, and on a shared machine is a real problem (#562,
 * #1318).
 *
 * Split in two on purpose. Reading the provider needs the session cookie, so it has
 * to happen first; reaching the provider is network I/O that can hang or throw, so it
 * must not stand between the caller and destroying the session. A logout that cannot
 * reach the provider still logs the user out.
 */

/** Which OIDC provider issued this session, read while the session still exists. */
export async function getSessionOidcProvider(cookies: Cookies): Promise<string | null> {
	if (!OIDC_END_SESSION) return null;

	const sessionId = getSessionIdFromCookies(cookies);
	if (!sessionId) return null;

	const session = await dbGetSession(sessionId);
	if (!session || providerKind(session.provider) !== 'oidc') return null;

	// A bare `oidc` cannot say which provider, so it gets the local logout alone.
	return oidcProviderName(session.provider);
}

/**
 * Where to send the browser to end the session at the provider, or null.
 *
 * Null when the session named no provider, when that provider is gone or publishes
 * no end-session endpoint, or when `OIDC_END_SESSION` is off - one instance-wide env
 * flag, not a per-provider switch. Never throws: every failure degrades to the
 * local-only logout that has already happened by the time this runs.
 */
export async function getOidcLogoutRedirect(
	providerName: string | null,
	postLogoutRedirectUri?: string
): Promise<string | null> {
	if (!OIDC_END_SESSION || !providerName) return null;

	try {
		const configs = await getOidcConfigs();
		const config = configs.find((c) => c.name === providerName);
		if (!config) return null;

		return await buildOidcLogoutUrl(config.id, postLogoutRedirectUri);
	} catch (error) {
		console.warn('[OIDC] Could not build the provider logout URL:', error);
		return null;
	}
}

// ============================================
// User Permissions
// ============================================

/**
 * Build an authenticated user object with merged permissions
 */
async function buildAuthenticatedUser(
	user: User,
	provider: 'local' | 'ldap' | 'oidc' | 'passkey'
): Promise<AuthenticatedUser> {
	const permissions = await getUserPermissionsById(user.id);

	// Determine admin status:
	// - Free edition: all authenticated users are admins
	// - Enterprise: check Admin role assignment
	const enterprise = await isEnterprise();
	const isAdmin = enterprise ? await userHasAdminRole(user.id) : true;

	return {
		id: user.id,
		username: user.username,
		email: user.email,
		displayName: user.displayName,
		avatar: user.avatar,
		isAdmin,
		provider,
		permissions
	};
}

/**
 * Get merged permissions for a user from all their roles
 */
export async function getUserPermissionsById(userId: number): Promise<Permissions> {
	const user = await getUser(userId);
	if (!user) return EMPTY_PERMISSIONS;

	// Admins (those with Admin role) have all permissions
	if (await userHasAdminRole(userId)) {
		return getAdminPermissions();
	}

	// Get all roles for this user
	const userRoles = await getUserRoles(userId);

	// Merge permissions from all roles
	const merged: Permissions = {
		containers: [],
		images: [],
		volumes: [],
		networks: [],
		stacks: [],
		environments: [],
		registries: [],
		notifications: [],
		configsets: [],
		settings: [],
		users: [],
		git: [],
		license: [],
		audit_logs: [],
		activity: [],
		schedules: [],
		secrets: [],
		backups: []
	};

	for (const ur of userRoles) {
		const perms = ur.role.permissions;
		for (const key of Object.keys(merged) as (keyof Permissions)[]) {
			if (perms[key]) {
				merged[key] = [...new Set([...merged[key], ...perms[key]])];
			}
		}
	}

	return merged;
}

/**
 * Check if a user has a specific permission
 * Note: Permission checks only apply in Enterprise edition
 * In Free edition, all authenticated users have full access
 *
 * @param user - The authenticated user
 * @param resource - The resource category (containers, images, etc.)
 * @param action - The action to check (view, create, etc.)
 * @param environmentId - Optional: check permission in context of specific environment
 */
export async function checkPermission(
	user: AuthenticatedUser,
	resource: keyof Permissions,
	action: string,
	environmentId?: number
): Promise<boolean> {
	// In free edition, all authenticated users have full access
	if (!(await isEnterprise())) return true;

	// Admins (those with Admin role) can do anything
	if (await userHasAdminRole(user.id)) return true;

	// Past this point the caller is not an administrator. A license that stopped
	// validating holds them here: the roles still say what they may do, but an expiry
	// or a renamed host is an accident, and carrying on as normal would leave an
	// instance running on a license nobody is paying for. An administrator got through
	// above, so the state can still be fixed.
	if (await isLicenseLapsed()) return false;

	// If checking within an environment context, get environment-specific permissions
	if (environmentId !== undefined) {
		const permissions = await getUserPermissionsForEnvironment(user.id, environmentId);
		return permissions[resource]?.includes(action) ?? false;
	}

	// Otherwise use global permissions (from all roles)
	return user.permissions[resource]?.includes(action) ?? false;
}

/**
 * Get merged permissions for a user for a specific environment.
 * Only includes permissions from roles that apply to this environment
 * (roles with null environmentId OR matching environmentId).
 */
export async function getUserPermissionsForEnvironment(userId: number, environmentId: number): Promise<Permissions> {
	const user = await getUser(userId);
	if (!user) return EMPTY_PERMISSIONS;

	// Admins (those with Admin role) have all permissions
	if (await userHasAdminRole(userId)) {
		return getAdminPermissions();
	}

	// Get roles that apply to this specific environment
	const userRoles = await getUserRolesForEnvironment(userId, environmentId);

	// Merge permissions from applicable roles only
	const merged: Permissions = {
		containers: [],
		images: [],
		volumes: [],
		networks: [],
		stacks: [],
		environments: [],
		registries: [],
		notifications: [],
		configsets: [],
		settings: [],
		users: [],
		git: [],
		license: [],
		audit_logs: [],
		activity: [],
		schedules: [],
		secrets: [],
		backups: []
	};

	for (const ur of userRoles) {
		if (!ur.role) continue;
		const perms = ur.role.permissions;
		for (const key of Object.keys(merged) as (keyof Permissions)[]) {
			if (perms[key]) {
				merged[key] = [...new Set([...merged[key], ...perms[key]])];
			}
		}
	}

	return merged;
}

// Re-export for convenience
export { getUserAccessibleEnvironments, userCanAccessEnvironment };

// ============================================
// Authentication State
// ============================================

/**
 * Check if authentication is enabled
 */
export async function isAuthEnabled(): Promise<boolean> {
	try {
		const settings = await getAuthSettings();
		return settings.authEnabled;
	} catch {
		// If database is not initialized, auth is disabled
		return false;
	}
}

/**
 * Local authentication
 */
export async function authenticateLocal(
	username: string,
	password: string
): Promise<LoginResult> {
	const user = await getUserByUsername(username);

	if (!user) {
		await verifyPassword(password, await getDummyAuthHash());
		return { success: false, error: 'Invalid username or password' };
	}

	if (!user.isActive) {
		await verifyPassword(password, await getDummyAuthHash());
		console.warn(`[Auth] Login attempt for disabled account: user=${username}`);
		return { success: false, error: 'Invalid username or password' };
	}

	const validPassword = await verifyPassword(password, user.passwordHash);
	if (!validPassword) {
		return { success: false, error: 'Invalid username or password' };
	}

	// Check if MFA is required
	if (user.mfaEnabled) {
		return { success: true, requiresMfa: true };
	}

	return {
		success: true,
		user: await buildAuthenticatedUser(user, 'local')
	};
}

// ============================================
// LDAP Authentication
// ============================================

export interface LdapTestResult {
	success: boolean;
	error?: string;
	userCount?: number;
}

/**
 * Get enabled LDAP configurations
 */
export async function getEnabledLdapConfigs(): Promise<LdapConfig[]> {
	const configs = await getLdapConfigs();
	return configs.filter(config => config.enabled);
}

/**
 * Test LDAP connection and configuration
 */
export async function testLdapConnection(configId: number): Promise<LdapTestResult> {
	const config = await getLdapConfig(configId);
	if (!config) {
		return { success: false, error: 'LDAP configuration not found' };
	}

	const client = new LdapClient({
		url: config.serverUrl,
		tlsOptions: config.tlsEnabled ? {
			rejectUnauthorized: !config.tlsCa, // If CA provided, validate; otherwise trust
			ca: config.tlsCa ? [config.tlsCa] : undefined
		} : undefined
	});

	try {
		// Bind with service account if configured
		if (config.bindDn && config.bindPassword) {
			await client.bind(config.bindDn, config.bindPassword);
		}

		// Search for users to validate base_dn and filter
		const filter = config.userFilter.replace('{{username}}', '*');
		const { searchEntries } = await client.search(config.baseDn, {
			scope: 'sub',
			filter: filter,
			sizeLimit: 10,
			attributes: [config.usernameAttribute]
		});

		await client.unbind();
		return { success: true, userCount: searchEntries.length };
	} catch (error: any) {
		try { await client.unbind(); } catch {}
		return { success: false, error: error.message || 'Connection failed' };
	}
}

/**
 * Authenticate user against LDAP
 */
export async function authenticateLdap(
	username: string,
	password: string,
	configId?: number
): Promise<LoginResult & { providerName?: string }> {
	// Get LDAP configurations
	const configs = configId
		? [await getLdapConfig(configId)].filter(Boolean) as LdapConfig[]
		: await getEnabledLdapConfigs();

	if (configs.length === 0) {
		return { success: false, error: 'No LDAP configuration available' };
	}

	// Try each LDAP configuration
	for (const config of configs) {
		const result = await tryLdapAuth(username, password, config);
		if (result.success) {
			return { ...result, providerName: config.name };
		}
	}

	return { success: false, error: 'Invalid username or password' };
}

/**
 * Escape special characters in an LDAP filter value (RFC 4515).
 * Prevents LDAP injection via wildcards or control characters.
 */

/**
 * Try authentication against a specific LDAP configuration
 */
async function tryLdapAuth(
	username: string,
	password: string,
	config: LdapConfig
): Promise<LoginResult> {
	const client = new LdapClient({
		url: config.serverUrl,
		tlsOptions: config.tlsEnabled ? {
			rejectUnauthorized: !config.tlsCa,
			ca: config.tlsCa ? [config.tlsCa] : undefined
		} : undefined
	});

	try {
		// First, bind with service account to search for the user
		if (config.bindDn && config.bindPassword) {
			await client.bind(config.bindDn, config.bindPassword);
		}

		// Escape the username before interpolating into the LDAP filter (RFC 4515)
		// to prevent LDAP injection via wildcards or special characters.
		const safeUsername = escapeLdapFilterValue(username);
		const filter = config.userFilter.replace('{{username}}', safeUsername);
		const { searchEntries } = await client.search(config.baseDn, {
			scope: 'sub',
			filter: filter,
			sizeLimit: 1,
			attributes: [
				'dn',
				config.usernameAttribute,
				config.emailAttribute,
				config.displayNameAttribute
			]
		});

		// Use a single generic error for both "not found" and "wrong password"
		// to avoid leaking whether a username exists via response content or timing.
		if (searchEntries.length === 0) {
			await client.unbind();
			return { success: false, error: 'Invalid username or password' };
		}

		const userEntry = searchEntries[0];
		const userDn = userEntry.dn;

		// Unbind service account
		await client.unbind();

		// Create new client and try to bind as the user (authentication)
		const userClient = new LdapClient({
			url: config.serverUrl,
			tlsOptions: config.tlsEnabled ? {
				rejectUnauthorized: !config.tlsCa,
				ca: config.tlsCa ? [config.tlsCa] : undefined
			} : undefined
		});

		try {
			await userClient.bind(userDn, password);
			await userClient.unbind();
		} catch (bindError) {
			return { success: false, error: 'Invalid username or password' };
		}

		// Authentication successful - get or create local user
		const ldapUsername = getAttributeValue(userEntry, config.usernameAttribute) || username;
		const email = getAttributeValue(userEntry, config.emailAttribute);
		const displayName = getAttributeValue(userEntry, config.displayNameAttribute);

		// Check if user is in admin group
		let shouldBeAdmin = false;
		if (config.adminGroup) {
			shouldBeAdmin = await checkLdapGroupMembership(config, userDn, config.adminGroup);
		}

		// Build provider string for storage (e.g., "ldap:Active Directory")
		const authProvider = `ldap:${config.name}`;

		// Get or create local user
		let user = await getUserByUsername(ldapUsername);
		if (!user) {
			// Create new user from LDAP
			user = await createUser({
				username: ldapUsername,
				email: email || undefined,
				displayName: displayName || undefined,
				passwordHash: '', // No local password for LDAP users
				authProvider
			});
		} else {
			// Update user info from LDAP
			await updateUser(user.id, {
				email: email || undefined,
				displayName: displayName || undefined,
				authProvider
			});
			user = (await getUser(user.id))!;
		}

		// Manage Admin role assignment based on LDAP group membership
		const adminRole = await getRoleByName('Admin');
		if (adminRole) {
			const hasAdminRole = await userHasAdminRole(user.id);
			if (shouldBeAdmin && !hasAdminRole) {
				await assignUserRole(user.id, adminRole.id, null);
			} else if (!shouldBeAdmin && hasAdminRole && config.adminGroup) {
				// Remove Admin role if user is no longer in admin group
				await removeUserRole(user.id, adminRole.id);
			}
		}

		// Process role mappings (Enterprise feature)
		// Note: roleMappings is parsed from JSON by getLdapConfig, but TypeScript type is string
		const roleMappings = typeof config.roleMappings === 'string'
			? JSON.parse(config.roleMappings) as { groupDn: string; roleId: number }[]
			: config.roleMappings as { groupDn: string; roleId: number }[] | null | undefined;

		if (roleMappings && roleMappings.length > 0 && config.groupBaseDn && await isEnterprise()) {
			const userExistingRoles = await getUserRoles(user.id);
			const existingRoleIds = new Set(userExistingRoles.map(r => r.roleId));

			// All role IDs referenced in mappings (these are LDAP-managed)
			const mappedRoleIds = new Set(roleMappings.map(m => m.roleId));

			// Determine which mapped roles user should have based on current group membership
			const shouldHaveRoleIds = new Set<number>();
			for (const mapping of roleMappings) {
				const isInGroup = await checkLdapGroupMembership(config, userDn, mapping.groupDn);
				if (isInGroup) {
					shouldHaveRoleIds.add(mapping.roleId);
				}
			}

			// Add roles user should have but doesn't
			for (const roleId of shouldHaveRoleIds) {
				if (!existingRoleIds.has(roleId)) {
					await assignUserRole(user.id, roleId, undefined);
				}
			}

			// Remove mapped roles user has but shouldn't
			for (const roleId of mappedRoleIds) {
				if (existingRoleIds.has(roleId) && !shouldHaveRoleIds.has(roleId)) {
					await removeUserRole(user.id, roleId);
				}
			}
		}

		// Clear cached token permissions after role sync
		invalidateTokenCacheForUser(user.id);

		if (!user.isActive) {
			return { success: false, error: 'Account is disabled' };
		}

		// Check if MFA is required
		if (user.mfaEnabled) {
			return { success: true, requiresMfa: true };
		}

		return {
			success: true,
			user: await buildAuthenticatedUser(user, 'ldap')
		};
	} catch (error: any) {
		try { await client.unbind(); } catch {}
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[LDAP] Authentication error:', errorMsg);
		return { success: false, error: 'LDAP authentication failed' };
	}
}

/**
 * Check if a user is a member of an LDAP group
 */
async function checkLdapGroupMembership(
	config: LdapConfig,
	userDn: string,
	groupDnOrName: string
): Promise<boolean> {
	const client = new LdapClient({
		url: config.serverUrl,
		tlsOptions: config.tlsEnabled ? {
			rejectUnauthorized: !config.tlsCa,
			ca: config.tlsCa ? [config.tlsCa] : undefined
		} : undefined
	});

	try {
		if (config.bindDn && config.bindPassword) {
			await client.bind(config.bindDn, config.bindPassword);
		}

		// Detect if groupDnOrName is a full DN (contains = and ,)
		const isFullDn = groupDnOrName.includes('=') && groupDnOrName.includes(',');

		let searchBase: string;
		let groupFilter: string;

		// A DN placed in a search FILTER must be escaped per RFC 4515 - an AD DN with an
		// escaped comma (CN=Surname\, Name,...) otherwise makes ldapts read `\,` as an
		// invalid `\XX` hex filter-escape and throw ("Invalid escaped hex character").
		// The searchBase stays the RAW DN (RFC 4514) - only filter VALUES are escaped.
		const userDnFilterValue = escapeLdapFilterValue(userDn);
		const groupCnFilterValue = escapeLdapFilterValue(groupDnOrName);
		if (config.groupFilter) {
			// User provided custom filter - use group DN directly when it's a full DN
			// to avoid searching all groups under groupBaseDn
			searchBase = isFullDn ? groupDnOrName : (config.groupBaseDn || groupDnOrName);
			groupFilter = config.groupFilter
				.replace('{{username}}', userDnFilterValue)
				.replace('{{user_dn}}', userDnFilterValue)
				.replace('{{group}}', groupCnFilterValue);
		} else if (isFullDn) {
			// Full DN provided - search directly at that DN
			searchBase = groupDnOrName;
			groupFilter = `(member=${userDnFilterValue})`;
		} else {
			// Just a group name - search in groupBaseDn
			if (!config.groupBaseDn) {
				await client.unbind();
				return false;
			}
			searchBase = config.groupBaseDn;
			groupFilter = `(&(cn=${groupCnFilterValue})(member=${userDnFilterValue}))`;
		}

		const { searchEntries } = await client.search(searchBase, {
			scope: isFullDn ? 'base' : 'sub',
			filter: groupFilter,
			sizeLimit: 1
		});

		await client.unbind();
		return searchEntries.length > 0;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[LDAP] Group membership check failed:', errorMsg);
		try { await client.unbind(); } catch {}
		return false;
	}
}

/**
 * Helper to get attribute value from LDAP entry
 */
function getAttributeValue(entry: any, attribute: string): string | undefined {
	const value = entry[attribute];
	if (!value) return undefined;
	if (Array.isArray(value)) return value[0]?.toString();
	return value.toString();
}

// ============================================
// MFA (TOTP) with Backup Codes
// ============================================

import * as OTPAuth from 'otpauth';
import * as QRCode from 'qrcode';

// MFA data stored in mfaSecret field as JSON
interface MfaData {
	secret: string;           // TOTP secret (base32)
	backupCodes: string[];    // Hashed backup codes (unused ones)
}

/**
 * Generate 10 random backup codes (8 characters each, alphanumeric)
 */
function generateBackupCodes(): string[] {
	const codes: string[] = [];
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusable chars: 0, O, 1, I
	for (let i = 0; i < 10; i++) {
		let code = '';
		for (let j = 0; j < 8; j++) {
			code += chars.charAt(randomInt(chars.length));
		}
		codes.push(code);
	}
	return codes;
}

/**
 * Hash a backup code for storage
 */
async function hashBackupCode(code: string): Promise<string> {
	// Normalize: uppercase, remove spaces and dashes
	const normalized = code.toUpperCase().replace(/[\s-]/g, '');
	return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Parse MFA data from database field
 */
function parseMfaData(mfaSecret: string | null | undefined): MfaData | null {
	if (!mfaSecret) return null;

	try {
		// Try parsing as JSON first (new format)
		const parsed = JSON.parse(mfaSecret);
		if (parsed && typeof parsed.secret === 'string') {
			return {
				secret: parsed.secret,
				backupCodes: parsed.backupCodes || []
			};
		}
	} catch {
		// Legacy format: plain base32 secret string
		return {
			secret: mfaSecret,
			backupCodes: []
		};
	}
	return null;
}

/**
 * Generate MFA secret and QR code for setup
 */
export async function generateMfaSetup(userId: number): Promise<{
	secret: string;
	qrDataUrl: string;
} | { alreadyEnabled: true } | null> {
	const user = await getUser(userId);
	if (!user) return null;

	// Never regenerate over a LIVE enrolment. Overwriting the stored secret + clearing
	// backupCodes while mfaEnabled stays true locks the account out for good (#1399): the
	// authenticator holds the old secret, no backup code can match, and login keeps demanding
	// a code. To re-enrol, the user must disable MFA first (DELETE), then set it up fresh.
	if (user.mfaEnabled) return { alreadyEnabled: true };

	// Build issuer name with hostname (same as license matching)
	const hostname = process.env.DOCKHAND_HOSTNAME || os.hostname();
	const issuer = `Dockhand (${hostname})`;

	// Create a new TOTP secret
	const totpSecret = new OTPAuth.Secret({ size: 20 });
	const totp = new OTPAuth.TOTP({
		issuer,
		label: user.username,
		algorithm: 'SHA1',
		digits: 6,
		period: 30,
		secret: totpSecret
	});

	const secretBase32 = totp.secret.base32;
	const otpauthUrl = totp.toString();

	// Generate QR code
	const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
		width: 200,
		margin: 2
	});

	// Store secret temporarily as JSON (user must verify before it's enabled)
	// Backup codes will be generated after verification
	const mfaData: MfaData = { secret: secretBase32, backupCodes: [] };
	await updateUser(userId, { mfaSecret: JSON.stringify(mfaData) });

	return { secret: secretBase32, qrDataUrl };
}

/**
 * Verify MFA token and enable MFA if valid
 * Returns backup codes on success (shown only once)
 */
export async function verifyAndEnableMfa(userId: number, token: string): Promise<{ success: false } | { success: true; backupCodes: string[] }> {
	const user = await getUser(userId);
	if (!user || !user.mfaSecret) return { success: false };

	const mfaData = parseMfaData(user.mfaSecret);
	if (!mfaData) return { success: false };

	const totp = new OTPAuth.TOTP({
		issuer: 'Dockhand',
		label: user.username,
		algorithm: 'SHA1',
		digits: 6,
		period: 30,
		secret: OTPAuth.Secret.fromBase32(mfaData.secret)
	});

	const delta = totp.validate({ token, window: 1 });
	if (delta === null) return { success: false };

	// Generate backup codes
	const plainBackupCodes = generateBackupCodes();
	const hashedBackupCodes = await Promise.all(plainBackupCodes.map(hashBackupCode));

	// Update MFA data with hashed backup codes and enable MFA
	const updatedMfaData: MfaData = {
		secret: mfaData.secret,
		backupCodes: hashedBackupCodes
	};
	await updateUser(userId, {
		mfaEnabled: true,
		mfaSecret: JSON.stringify(updatedMfaData)
	});

	// Return plain backup codes (shown only once)
	return { success: true, backupCodes: plainBackupCodes };
}

/**
 * Verify MFA token during login (accepts TOTP code or backup code)
 */
export async function verifyMfaToken(userId: number, token: string): Promise<boolean> {
	const user = await getUser(userId);
	if (!user || !user.mfaEnabled || !user.mfaSecret) return false;

	const mfaData = parseMfaData(user.mfaSecret);
	if (!mfaData) return false;

	// First, try TOTP verification
	const totp = new OTPAuth.TOTP({
		issuer: 'Dockhand',
		label: user.username,
		algorithm: 'SHA1',
		digits: 6,
		period: 30,
		secret: OTPAuth.Secret.fromBase32(mfaData.secret)
	});

	const delta = totp.validate({ token, window: 1 });
	if (delta !== null) return true;

	// If TOTP fails, try backup code
	if (mfaData.backupCodes && mfaData.backupCodes.length > 0) {
		const hashedInput = await hashBackupCode(token);
		const codeIndex = mfaData.backupCodes.indexOf(hashedInput);

		if (codeIndex !== -1) {
			// Remove used backup code
			const updatedBackupCodes = [...mfaData.backupCodes];
			updatedBackupCodes.splice(codeIndex, 1);

			const updatedMfaData: MfaData = {
				secret: mfaData.secret,
				backupCodes: updatedBackupCodes
			};
			await updateUser(userId, { mfaSecret: JSON.stringify(updatedMfaData) });

			return true;
		}
	}

	return false;
}

/**
 * Disable MFA for a user
 */
export async function disableMfa(userId: number): Promise<boolean> {
	const user = await getUser(userId);
	if (!user) return false;

	await updateUser(userId, { mfaEnabled: false, mfaSecret: undefined });
	return true;
}

// ============================================
// Rate Limiting (Simple in-memory)
// ============================================

interface RateLimitEntry {
	attempts: number;
	lastAttempt: number;
	lockedUntil: number | null;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000; // 15 minute lockout

// Guard against multiple intervals during HMR
declare global {
	var __authRateLimitCleanupInterval: ReturnType<typeof setInterval> | undefined;
}

// Cleanup expired rate limit entries every 5 minutes (guarded for HMR)
if (!globalThis.__authRateLimitCleanupInterval) {
	globalThis.__authRateLimitCleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of rateLimitStore) {
			if (now - entry.lastAttempt > RATE_LIMIT_WINDOW_MS) {
				rateLimitStore.delete(key);
			}
		}
	}, 5 * 60 * 1000);
}

/**
 * Check if a login attempt is rate limited
 */
export function isRateLimited(identifier: string): { limited: boolean; retryAfter?: number } {
	const entry = rateLimitStore.get(identifier);
	const now = Date.now();

	if (!entry) return { limited: false };

	// Check if locked out
	if (entry.lockedUntil && entry.lockedUntil > now) {
		return {
			limited: true,
			retryAfter: Math.ceil((entry.lockedUntil - now) / 1000)
		};
	}

	// Reset if outside window
	if (now - entry.lastAttempt > RATE_LIMIT_WINDOW_MS) {
		rateLimitStore.delete(identifier);
		return { limited: false };
	}

	return { limited: false };
}

/**
 * Record a failed login attempt
 */
export function recordFailedAttempt(identifier: string): void {
	const now = Date.now();
	const entry = rateLimitStore.get(identifier);

	if (!entry || now - entry.lastAttempt > RATE_LIMIT_WINDOW_MS) {
		rateLimitStore.set(identifier, {
			attempts: 1,
			lastAttempt: now,
			lockedUntil: null
		});
		return;
	}

	entry.attempts++;
	entry.lastAttempt = now;

	if (entry.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
		entry.lockedUntil = now + RATE_LIMIT_LOCKOUT_MS;
	}
}

/**
 * Clear rate limit for an identifier (on successful login)
 */
export function clearRateLimit(identifier: string): void {
	rateLimitStore.delete(identifier);
}

// ============================================
// OIDC/SSO Authentication
// ============================================

// A login in flight is carried by the browser, not held here: see
// oidc-login-state.ts. Anything kept in this process is lost when the callback
// reaches a different one, which is every login on a two-container deployment.

/** When a login-state cookie expires, or null if it cannot be read. */
function loginStateExpiry(value: string): number | null {
	if (!looksLikeCiphertext(value)) return null;
	try {
		const parsed = JSON.parse(decrypt(value) ?? '');
		return typeof parsed?.expiresAt === 'number' ? parsed.expiresAt : null;
	} catch {
		return null;
	}
}

/** The cookie name this login's state lives under. */
export function cookieNameFor(state: string): string {
	return loginStateCookieName(state, (v) => createHash('sha256').update(v).digest('hex'));
}

/**
 * Hand the in-flight login to the browser.
 *
 * `sameSite: 'lax'` is what lets it survive the redirect back from the provider - a
 * stricter cookie is not sent on a cross-site navigation, which is exactly the trip
 * this cookie exists to make. Encrypted with the instance key, so the PKCE verifier
 * and nonce inside are neither readable nor forgeable by the browser holding them.
 */
export function setLoginStateCookie(
	cookies: Cookies,
	state: OidcLoginState,
	request?: Request
): void {
	// A browser may only hold a few unfinished logins. Decided from the cookies THIS
	// request carried, so it can never touch another browser's sign-in.
	const existing = cookies.getAll().map((c) => ({
		name: c.name,
		expiresAt: loginStateExpiry(c.value)
	}));
	for (const stale of loginStateCookiesToEvict(existing)) {
		cookies.delete(stale, { path: '/' });
	}

	cookies.set(cookieNameFor(state.state), encodeLoginState(state, encrypt), {
		path: '/',
		httpOnly: true,
		secure: isSecureContext(request),
		sameSite: 'lax',
		maxAge: OIDC_STATE_TTL_SECONDS
	});
}

/** How long to wait on an issuer's discovery document before giving up. */
const OIDC_DISCOVERY_TIMEOUT_MS = 10_000;

// OIDC Discovery document cache
const oidcDiscoveryCache = new Map<string, {
	document: OidcDiscoveryDocument;
	expiresAt: number;
}>();

export interface OidcDiscoveryDocument {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint?: string;
	jwks_uri: string;
	end_session_endpoint?: string;
	scopes_supported?: string[];
	response_types_supported?: string[];
	code_challenge_methods_supported?: string[];
}

/**
 * Get enabled OIDC configurations
 */
export async function getEnabledOidcConfigs(): Promise<OidcConfig[]> {
	const configs = await getOidcConfigs();
	return configs.filter(config => config.enabled);
}

/**
 * Fetch and cache OIDC discovery document
 */
async function getOidcDiscovery(issuerUrl: string): Promise<OidcDiscoveryDocument> {
	const cached = oidcDiscoveryCache.get(issuerUrl);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.document;
	}

	// Try the canonical (no trailing slash) discovery URL first, then the trailing-slash
	// variant some providers require (FortiAuthenticator 404s the canonical one, #1368).
	// Bounded: an unreachable issuer that never answers would otherwise hold every
	// caller open for as long as the socket lives, and two candidate URLs are tried
	// one after the other.
	const response = await fetchOidcDiscovery(oidcDiscoveryUrls(issuerUrl), (url) =>
		fetch(url, { signal: AbortSignal.timeout(OIDC_DISCOVERY_TIMEOUT_MS) })
	);

	const document = await response.json() as OidcDiscoveryDocument;

	// Cache for 1 hour
	oidcDiscoveryCache.set(issuerUrl, {
		document,
		expiresAt: Date.now() + 3600000
	});

	return document;
}

// One key set per provider, so the provider's signing keys are not re-fetched on every
// login. jose refreshes them on its own when a token names a key it has not seen,
// which is what makes key rotation a non-event.
const oidcKeyStores = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getKeyStore(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
	let store = oidcKeyStores.get(jwksUri);
	if (!store) {
		store = createRemoteJWKSet(new URL(jwksUri));
		oidcKeyStores.set(jwksUri, store);
	}
	return store;
}

/** The claims of an id_token, once it has been proven to come from the provider. */
async function verifyIdToken(
	idToken: string,
	discovery: OidcDiscoveryDocument,
	config: { clientId: string; name: string },
	expectedNonce: string
): Promise<Claims> {
	if (!discovery.jwks_uri) {
		throw new Error(`${config.name} publishes no signing keys (jwks_uri), so tokens cannot be verified`);
	}

	return verifyIdTokenWithKeys(idToken, getKeyStore(discovery.jwks_uri), {
		issuer: discovery.issuer,
		clientId: config.clientId,
		nonce: expectedNonce
	});
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePkce(): { codeVerifier: string; codeChallenge: string } {
	const codeVerifier = secureRandomBytes(32).toString('base64url');
	const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
	return { codeVerifier, codeChallenge };
}

/**
 * Build OIDC authorization URL for SSO initiation
 */
export async function buildOidcAuthorizationUrl(
	configId: number,
	redirectUrl: string = '/'
): Promise<{ url: string; state: string; loginState: OidcLoginState } | { error: string }> {
	const config = await getOidcConfig(configId);
	if (!config || !config.enabled) {
		return { error: 'OIDC configuration not found or disabled' };
	}

	try {
		const discovery = await getOidcDiscovery(config.issuerUrl);

		// Generate state, nonce, and PKCE
		const state = secureRandomBytes(32).toString('base64url');
		const nonce = secureRandomBytes(16).toString('base64url');
		const { codeVerifier, codeChallenge } = generatePkce();

		// Handed back for the caller to put in the browser's cookie. Holding it in
		// this process instead loses every login that comes back to a different one -
		// two containers behind one proxy, or a restart mid-login (#1601).
		const loginState: OidcLoginState = {
			configId,
			state,
			codeVerifier,
			nonce,
			redirectUrl,
			expiresAt: Date.now() + OIDC_STATE_TTL_SECONDS * 1000
		};

		// Build authorization URL
		const params = new URLSearchParams({
			response_type: 'code',
			client_id: config.clientId,
			redirect_uri: config.redirectUri,
			scope: config.scopes || 'openid profile email',
			state,
			nonce,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256'
		});

		const authUrl = `${discovery.authorization_endpoint}?${params.toString()}`;
		return { url: authUrl, state, loginState };
	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[OIDC] Failed to build authorization URL:', errorMsg);
		return { error: error.message || 'Failed to initialize SSO' };
	}
}

/**
 * Exchange authorization code for tokens and authenticate user
 */
export async function handleOidcCallback(
	code: string,
	stateData: OidcLoginState
): Promise<LoginResult & { redirectUrl?: string; providerName?: string; providerId?: number }> {
	const config = await getOidcConfig(stateData.configId);
	if (!config || !config.enabled) {
		return { success: false, error: 'OIDC configuration not found or disabled' };
	}

	try {
		const discovery = await getOidcDiscovery(config.issuerUrl);

		// Exchange code for tokens
		const tokenResponse = await fetch(discovery.token_endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: config.redirectUri,
				client_id: config.clientId,
				client_secret: config.clientSecret,
				code_verifier: stateData.codeVerifier
			})
		});

		if (!tokenResponse.ok) {
			const errorBody = await tokenResponse.text();
			// Named and prefixed like every other OIDC line: with more than one provider
			// configured, a bare message does not say which one refused.
			console.error(`[OIDC] ${config.name} refused the authorization code: HTTP ${tokenResponse.status} ${redactTokenErrorBody(errorBody)}`);
			console.error(`[OIDC] ${config.name} token endpoint: ${discovery.token_endpoint}, redirect URI sent: ${config.redirectUri}`);
			return { success: false, error: describeTokenExchangeFailure(tokenResponse.status, errorBody) };
		}

		const tokens = await tokenResponse.json() as {
			access_token: string;
			id_token?: string;
			token_type: string;
			expires_in?: number;
		};

		// The id_token is the only thing tying this login to the provider. Everything
		// downstream - the username, and whether the account becomes an administrator -
		// is read out of it, so it is verified before a single claim is trusted:
		// signature against the provider's published keys, issuer, audience, expiry,
		// and the nonce from the request that started this login.
		const present = requireIdToken(tokens);
		if (!present.proceed) {
			return { success: false, error: present.error };
		}

		let claims: Claims;
		try {
			claims = await verifyIdToken(tokens.id_token!, discovery, config, stateData.nonce);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.warn(`[OIDC] Rejected an ID token from ${config.name}: ${reason}`);
			const rejected = rejectedToken(error);
			return { success: false, error: rejected.proceed ? reason : rejected.error };
		}

		// userinfo may carry claims the token omits, but only about the same person.
		// Its values override the token's, and the admin claim is read afterwards, so a
		// response about a different subject would be a way in.
		if (discovery.userinfo_endpoint && tokens.access_token) {
			try {
				const userinfoResponse = await fetch(discovery.userinfo_endpoint, {
					headers: {
						'Authorization': `Bearer ${tokens.access_token}`
					}
				});
				if (userinfoResponse.ok) {
					const userinfo = await userinfoResponse.json();
					const step = applyUserinfo(claims, userinfo, config.name);
					if (!step.proceed) {
						console.warn(
							`[OIDC] ${config.name} returned userinfo for a different subject; rejecting the sign-in`
						);
						return { success: false, error: step.error };
					}
					if (step.warn) console.warn(step.warn);
					claims = step.claims;
				}
			} catch (e) {
				console.warn('Failed to fetch userinfo:', e);
			}
		}

		const identity = identityFromClaims(claims, config);
		if (!identity.ok) {
			return { success: false, error: 'Username claim not found in token' };
		}
		const { username, email, displayName } = identity;

		// Read off claims that are now known to come from the provider, and to be about
		// the subject the token names.
		const shouldBeAdmin = claimsGrantAdmin(claims, config.adminClaim, config.adminValue);

		// Build provider string for storage (e.g., "oidc:Keycloak")
		const authProvider = `oidc:${config.name}`;

		// Get or create local user
		let user = await getUserByUsername(username);
		if (!user) {
			// Create new user from OIDC
			user = await createUser({
				username,
				email: email || undefined,
				displayName: displayName || undefined,
				passwordHash: '', // No local password for OIDC users
				authProvider
			});
		} else {
			// Update user info from OIDC
			await updateUser(user.id, {
				email: email || undefined,
				displayName: displayName || undefined,
				authProvider
			});
			user = (await getUser(user.id))!;
		}

		// Manage Admin role assignment based on OIDC claim
		const adminRole = await getRoleByName('Admin');
		if (adminRole) {
			const hasAdminRole = await userHasAdminRole(user.id);
			if (shouldBeAdmin && !hasAdminRole) {
				// Assign Admin role
				await assignUserRole(user.id, adminRole.id, null);
			}
			// Note: We don't remove Admin role if claim is not present anymore
			// to prevent accidental lockouts (same behavior as before)
		}

		// Process role mappings from OIDC config
		if (config.roleMappings) {
			try {
				const roleMappings = typeof config.roleMappings === 'string'
					? JSON.parse(config.roleMappings)
					: config.roleMappings;

				const mapped = rolesFromClaims(claims, roleMappings, config.roleMappingsClaim);

				if (mapped.length > 0) {
					// Roles the user already holds, so a repeat login is not a repeat write.
					const userRoles = await getUserRoles(user.id);

					for (const roleId of mapped) {
						if (!userRoles.some((r) => r.roleId === roleId)) {
							await assignUserRole(user.id, roleId, null);
						}
					}
				}
			} catch (e) {
				console.warn('Failed to process OIDC role mappings:', e);
			}
		}

		// Clear cached token permissions after role sync
		invalidateTokenCacheForUser(user.id);

		if (!user.isActive) {
			return { success: false, error: 'Account is disabled' };
		}

		// OIDC users bypass MFA (they authenticated through IdP)
		return {
			success: true,
			user: await buildAuthenticatedUser(user, 'oidc'),
			redirectUrl: stateData.redirectUrl,
			providerName: config.name,
			providerId: config.id
		};
	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error('[OIDC] Callback error:', errorMsg);
		return { success: false, error: error.message || 'SSO authentication failed' };
	}
}

export interface OidcTestResult {
	success: boolean;
	error?: string;
	issuer?: string;
	endpoints?: {
		authorization: string;
		token: string;
		userinfo?: string;
	};
}

/**
 * Test OIDC configuration by fetching discovery document
 */
export async function testOidcConnection(configId: number): Promise<OidcTestResult> {
	const config = await getOidcConfig(configId);
	if (!config) {
		return { success: false, error: 'OIDC configuration not found' };
	}

	try {
		const discovery = await getOidcDiscovery(config.issuerUrl);
		return {
			success: true,
			issuer: discovery.issuer,
			endpoints: {
				authorization: discovery.authorization_endpoint,
				token: discovery.token_endpoint,
				userinfo: discovery.userinfo_endpoint
			}
		};
	} catch (error: any) {
		return { success: false, error: error.message || 'Failed to connect to OIDC provider' };
	}
}

/**
 * Build the OIDC logout URL for single logout
 */
export async function buildOidcLogoutUrl(
	configId: number,
	postLogoutRedirectUri?: string
): Promise<string | null> {
	const config = await getOidcConfig(configId);
	if (!config) return null;

	try {
		const discovery = await getOidcDiscovery(config.issuerUrl);
		if (!discovery.end_session_endpoint) return null;

		const params = new URLSearchParams({
			client_id: config.clientId
		});

		if (postLogoutRedirectUri) {
			params.set('post_logout_redirect_uri', postLogoutRedirectUri);
		}

		return `${discovery.end_session_endpoint}?${params.toString()}`;
	} catch {
		return null;
	}
}
