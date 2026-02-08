/**
 * Core Authentication Module
 *
 * Security features:
 * - Argon2id password hashing via Bun.password (memory-hard, timing-attack resistant)
 * - Cryptographically secure 32-byte random session tokens
 * - HttpOnly cookies (prevents XSS from reading tokens)
 * - Secure flag (HTTPS only in production)
 * - SameSite=Strict (CSRF protection)
 */

import os from 'node:os';
import { secureRandomBytes, usingFallback } from './crypto-fallback';
import { argon2id, argon2Verify } from 'hash-wasm';
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
import { isEnterprise } from './license';

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
	schedules: []
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
	provider: 'local' | 'ldap' | 'oidc';
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

// Argon2id parameters (matching Bun.password defaults)
const ARGON2_MEMORY_COST = 65536; // 64 MB in kibibytes
const ARGON2_TIME_COST = 3;       // 3 iterations
const ARGON2_PARALLELISM = 1;     // Single-threaded
const ARGON2_HASH_LENGTH = 32;    // 256-bit output
const ARGON2_SALT_LENGTH = 16;    // 128-bit salt

/**
 * Hash a password using Argon2id
 *
 * On modern kernels (>=3.17): Uses Bun's native password API (faster)
 * On old kernels (<3.17): Uses hash-wasm (WASM-based, no getrandom dependency)
 *
 * Argon2id is the recommended variant - resistant to both side-channel and GPU attacks
 */
export async function hashPassword(password: string): Promise<string> {
	// On old kernels, Bun.password.hash() crashes because it internally uses getrandom()
	// Use hash-wasm as a fallback which is pure WASM and doesn't depend on the syscall
	if (usingFallback()) {
		const salt = secureRandomBytes(ARGON2_SALT_LENGTH);
		return argon2id({
			password,
			salt,
			iterations: ARGON2_TIME_COST,
			parallelism: ARGON2_PARALLELISM,
			memorySize: ARGON2_MEMORY_COST,
			hashLength: ARGON2_HASH_LENGTH,
			outputType: 'encoded'  // Returns PHC format: $argon2id$v=19$m=65536,t=3,p=1$...
		});
	}

	// Modern kernels: use Bun's native implementation (faster)
	return Bun.password.hash(password, {
		algorithm: 'argon2id',
		memoryCost: ARGON2_MEMORY_COST,
		timeCost: ARGON2_TIME_COST
	});
}

/**
 * Verify a password against a hash
 * Uses constant-time comparison internally
 *
 * Both Bun.password and hash-wasm use the same PHC format, so hashes are compatible
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	try {
		// On old kernels, use hash-wasm for verification
		if (usingFallback()) {
			return await argon2Verify({ password, hash });
		}

		// Modern kernels: use Bun's native implementation
		return await Bun.password.verify(password, hash);
	} catch {
		return false;
	}
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
 * Create a new session for a user
 * @param provider - Auth provider: 'local', or provider name like 'Keycloak', 'Azure AD', etc.
 */
export async function createUserSession(
	userId: number,
	provider: string,
	cookies: Cookies
): Promise<Session> {
	// Clean up expired sessions periodically
	await deleteExpiredSessions();

	// Generate secure token
	const sessionId = generateSessionToken();

	// Get session timeout from settings
	const settings = await getAuthSettings();
	// Safety: ensure sessionTimeout is valid (1 second to 30 days), default to 24h if invalid
	const MAX_SESSION_TIMEOUT = 2592000; // 30 days in seconds
	const DEFAULT_SESSION_TIMEOUT = 86400; // 24 hours in seconds
	const sessionTimeout = (settings?.sessionTimeout > 0 && settings?.sessionTimeout <= MAX_SESSION_TIMEOUT)
		? settings.sessionTimeout
		: DEFAULT_SESSION_TIMEOUT;
	const expiresAt = new Date(Date.now() + sessionTimeout * 1000).toISOString();

	// Create session in database
	const session = await dbCreateSession(sessionId, userId, provider, expiresAt);

	// Set secure cookie
	setSessionCookie(cookies, sessionId, sessionTimeout);

	// Update user's last login time
	await updateUser(userId, { lastLogin: new Date().toISOString() });

	return session;
}

/**
 * Set the session cookie with secure attributes
 */
function setSessionCookie(cookies: Cookies, sessionId: string, maxAge: number): void {
	cookies.set(SESSION_COOKIE_NAME, sessionId, {
		path: '/',
		httpOnly: true,                    // Prevents XSS attacks from reading cookie
		secure: process.env.NODE_ENV === 'production', // HTTPS only in production
		sameSite: 'strict',                // CSRF protection
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

	const session = await dbGetSession(sessionId);
	if (!session) return null;

	// Check if session is expired
	const expiresAt = new Date(session.expiresAt);
	if (expiresAt < new Date()) {
		await dbDeleteSession(sessionId);
		return null;
	}

	const user = await getUser(session.userId);
	if (!user || !user.isActive) return null;

	return await buildAuthenticatedUser(user, session.provider as 'local' | 'ldap' | 'oidc');
}

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

// ============================================
// User Permissions
// ============================================

/**
 * Build an authenticated user object with merged permissions
 */
async function buildAuthenticatedUser(
	user: User,
	provider: 'local' | 'ldap' | 'oidc'
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
		schedules: []
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
		schedules: []
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
		// Use constant time to prevent timing attacks
		await hashPassword('dummy');
		return { success: false, error: 'Invalid username or password' };
	}

	if (!user.isActive) {
		return { success: false, error: 'Account is disabled' };
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

		// Search for the user
		const filter = config.userFilter.replace('{{username}}', username);
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

		if (searchEntries.length === 0) {
			await client.unbind();
			return { success: false, error: 'User not found' };
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
				// Assign Admin role
				await assignUserRole(user.id, adminRole.id, null);
			}
			// Note: We don't remove Admin role if not in LDAP group anymore
			// to prevent accidental lockouts (same behavior as before)
		}

		// Process role mappings (Enterprise feature)
		// Note: roleMappings is parsed from JSON by getLdapConfig, but TypeScript type is string
		const roleMappings = typeof config.roleMappings === 'string'
			? JSON.parse(config.roleMappings) as { groupDn: string; roleId: number }[]
			: config.roleMappings as { groupDn: string; roleId: number }[] | null | undefined;

		if (roleMappings && roleMappings.length > 0 && config.groupBaseDn && await isEnterprise()) {
			const userExistingRoles = await getUserRoles(user.id);
			const existingRoleIds = new Set(userExistingRoles.map(r => r.roleId));

			for (const mapping of roleMappings) {
				// Skip if user already has this role
				if (existingRoleIds.has(mapping.roleId)) continue;

				// Check if user is a member of the LDAP group
				const isInGroup = await checkLdapGroupMembership(config, userDn, mapping.groupDn);
				if (isInGroup) {
					await assignUserRole(user.id, mapping.roleId, undefined);
				}
			}
		}

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

		if (config.groupFilter) {
			// User provided custom filter
			searchBase = config.groupBaseDn || groupDnOrName;
			groupFilter = config.groupFilter
				.replace('{{username}}', userDn)
				.replace('{{user_dn}}', userDn)
				.replace('{{group}}', groupDnOrName);
		} else if (isFullDn) {
			// Full DN provided - search directly at that DN
			searchBase = groupDnOrName;
			groupFilter = `(member=${userDn})`;
		} else {
			// Just a group name - search in groupBaseDn
			if (!config.groupBaseDn) {
				await client.unbind();
				return false;
			}
			searchBase = config.groupBaseDn;
			groupFilter = `(&(cn=${groupDnOrName})(member=${userDn}))`;
		}

		const { searchEntries } = await client.search(searchBase, {
			scope: isFullDn && !config.groupFilter ? 'base' : 'sub',
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
			code += chars.charAt(Math.floor(Math.random() * chars.length));
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
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(normalized);
	return hasher.digest('hex');
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
} | null> {
	const user = await getUser(userId);
	if (!user) return null;

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
	var __authOidcStateCleanupInterval: ReturnType<typeof setInterval> | undefined;
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

// In-memory store for OIDC state (nonce, code_verifier)
// In production, consider using Redis or database for multi-instance deployments
const oidcStateStore = new Map<string, {
	configId: number;
	codeVerifier: string;
	nonce: string;
	redirectUrl: string;
	expiresAt: number;
}>();

// Clean up expired OIDC states periodically (guarded for HMR)
if (!globalThis.__authOidcStateCleanupInterval) {
	globalThis.__authOidcStateCleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [state, data] of oidcStateStore.entries()) {
			if (data.expiresAt < now) {
				oidcStateStore.delete(state);
			}
		}
	}, 60000); // Every minute
}

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

	const wellKnownUrl = issuerUrl.endsWith('/')
		? `${issuerUrl}.well-known/openid-configuration`
		: `${issuerUrl}/.well-known/openid-configuration`;

	const response = await fetch(wellKnownUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch OIDC discovery document: ${response.statusText}`);
	}

	const document = await response.json() as OidcDiscoveryDocument;

	// Cache for 1 hour
	oidcDiscoveryCache.set(issuerUrl, {
		document,
		expiresAt: Date.now() + 3600000
	});

	return document;
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePkce(): { codeVerifier: string; codeChallenge: string } {
	const codeVerifier = secureRandomBytes(32).toString('base64url');
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(codeVerifier);
	const codeChallenge = hasher.digest('base64url') as string;
	return { codeVerifier, codeChallenge };
}

/**
 * Build OIDC authorization URL for SSO initiation
 */
export async function buildOidcAuthorizationUrl(
	configId: number,
	redirectUrl: string = '/'
): Promise<{ url: string; state: string } | { error: string }> {
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

		// Store state for callback verification (expires in 10 minutes)
		oidcStateStore.set(state, {
			configId,
			codeVerifier,
			nonce,
			redirectUrl,
			expiresAt: Date.now() + 600000
		});

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
		return { url: authUrl, state };
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
	state: string
): Promise<LoginResult & { redirectUrl?: string }> {
	// Validate state
	const stateData = oidcStateStore.get(state);
	if (!stateData) {
		return { success: false, error: 'Invalid or expired state' };
	}

	// Remove state immediately to prevent replay
	oidcStateStore.delete(state);

	if (stateData.expiresAt < Date.now()) {
		return { success: false, error: 'SSO session expired' };
	}

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
			console.error('Token exchange failed:', tokenResponse.status, errorBody);
			console.error('Token endpoint:', discovery.token_endpoint);
			console.error('Redirect URI:', config.redirectUri);
			console.error('Client ID:', config.clientId);
			return { success: false, error: `Failed to exchange authorization code: ${errorBody}` };
		}

		const tokens = await tokenResponse.json() as {
			access_token: string;
			id_token?: string;
			token_type: string;
			expires_in?: number;
		};

		// Decode and validate ID token (basic validation - in production use a JWT library)
		let claims: Record<string, any> = {};

		if (tokens.id_token) {
			const idTokenParts = tokens.id_token.split('.');
			if (idTokenParts.length === 3) {
				try {
					claims = JSON.parse(Buffer.from(idTokenParts[1], 'base64url').toString());
				} catch {
					return { success: false, error: 'Invalid ID token' };
				}
			}
		}

		// If no ID token or need more info, fetch from userinfo endpoint
		if (discovery.userinfo_endpoint && tokens.access_token) {
			try {
				const userinfoResponse = await fetch(discovery.userinfo_endpoint, {
					headers: {
						'Authorization': `Bearer ${tokens.access_token}`
					}
				});
				if (userinfoResponse.ok) {
					const userinfo = await userinfoResponse.json();
					claims = { ...claims, ...userinfo };
				}
			} catch (e) {
				console.warn('Failed to fetch userinfo:', e);
			}
		}

		// Validate nonce if present in ID token
		if (claims.nonce && claims.nonce !== stateData.nonce) {
			return { success: false, error: 'Invalid nonce' };
		}

		// Extract user information using configured claims
		const username = claims[config.usernameClaim] || claims.preferred_username || claims.sub;
		const email = claims[config.emailClaim] || claims.email;
		const displayName = claims[config.displayNameClaim] || claims.name;

		if (!username) {
			return { success: false, error: 'Username claim not found in token' };
		}

		// Determine if user should be admin based on claim
		let shouldBeAdmin = false;
		if (config.adminClaim && config.adminValue) {
			const adminClaimValue = claims[config.adminClaim];
			// Support multiple comma-separated admin values
			const adminValues = config.adminValue.split(',').map((v: string) => v.trim());
			if (Array.isArray(adminClaimValue)) {
				shouldBeAdmin = adminClaimValue.some((v: string) => adminValues.includes(v));
			} else {
				shouldBeAdmin = adminValues.includes(adminClaimValue);
			}
		}

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

				const roleMappingsClaim = config.roleMappingsClaim || 'groups';
				const claimValue = claims[roleMappingsClaim];

				if (Array.isArray(roleMappings) && claimValue) {
					const claimValues = Array.isArray(claimValue) ? claimValue : [claimValue];

					// Get user's current roles to avoid duplicates
					const userRoles = await getUserRoles(user.id);

					for (const mapping of roleMappings) {
						if (mapping.claimValue && mapping.roleId && claimValues.includes(mapping.claimValue)) {
							const hasRole = userRoles.some(r => r.roleId === mapping.roleId);
							if (!hasRole) {
								await assignUserRole(user.id, mapping.roleId, null);
							}
						}
					}
				}
			} catch (e) {
				console.warn('Failed to process OIDC role mappings:', e);
			}
		}

		if (!user.isActive) {
			return { success: false, error: 'Account is disabled' };
		}

		// OIDC users bypass MFA (they authenticated through IdP)
		return {
			success: true,
			user: await buildAuthenticatedUser(user, 'oidc'),
			redirectUrl: stateData.redirectUrl,
			providerName: config.name
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
