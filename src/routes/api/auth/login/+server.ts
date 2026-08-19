import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import {
	authenticateLocal,
	authenticateLdap,
	getEnabledLdapConfigs,
	createUserSession,
	isRateLimited,
	recordFailedAttempt,
	clearRateLimit,
	verifyMfaToken,
	isAuthEnabled
} from '$lib/server/auth';
import { getUser, getUserByUsername } from '$lib/server/db';
import { auditAuth } from '$lib/server/audit';
import { getClientIp } from '$lib/server/client-ip';

/**
 * @openapi
 * summary: Authenticate with username/password (local or LDAP) and set the session cookie
 * body: {username:string!, password:string!, mfaToken:string, provider:string}
 * body-example: {"username":"admin","password":"correct horse battery staple","provider":"local"}
 * resp-200: {success:boolean!, user:{id:integer!, username:string!, email:string, displayName:string, isAdmin:boolean!}}
 * resp-200-desc: Login succeeded and dockhand_session cookie was set — OR requiresMfa:true if a second factor is needed first
 * resp-200-example: {"success":true,"user":{"id":1,"username":"admin","email":"admin@example.com","displayName":"Admin","isAdmin":true}}
 * resp-400: Authentication disabled, or username/password missing
 * resp-401: Invalid credentials or invalid MFA code
 * resp-403: Local login disabled via DISABLE_LOCAL_LOGIN
 * resp-429: Rate-limited (too many attempts for this IP+username)
 * resp-500: Unexpected error during authentication
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	// Check if auth is enabled
	if (!(await isAuthEnabled())) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	try {
		const { username, password, mfaToken, provider = 'local' } = await request.json();

		if (!username || !password) {
			return json({ error: 'Username and password are required' }, { status: 400 });
		}

		// Rate-limit key derived from socket IP + username. See client-ip.ts
		// for how XFF is handled (opt-in via TRUST_FORWARDED_HEADERS).
		const clientIp = getClientIp(event);
		const rateLimitKey = `${clientIp}:${username}`;

		const { limited, retryAfter } = isRateLimited(rateLimitKey);
		if (limited) {
			console.warn(`[Auth] Login rate-limited: user=${username} ip=${clientIp} retryAfter=${retryAfter}s`);
			return json(
				{ error: `Too many login attempts. Please try again in ${retryAfter} seconds.` },
				{ status: 429 }
			);
		}

		// Reject local login attempts when DISABLE_LOCAL_LOGIN is set
		if (provider === 'local' && process.env.DISABLE_LOCAL_LOGIN === 'true') {
			return json({ error: 'Local login is disabled' }, { status: 403 });
		}

		// Attempt authentication based on provider
		let result: any;
		let authProviderType: 'local' | 'ldap' | 'oidc' = 'local';

		if (provider.startsWith('ldap:')) {
			// LDAP provider with specific config ID (e.g., "ldap:1")
			const configId = parseInt(provider.split(':')[1], 10);
			result = await authenticateLdap(username, password, configId);
			authProviderType = 'ldap';
		} else if (provider === 'ldap') {
			// Generic LDAP (will try all enabled configs)
			result = await authenticateLdap(username, password);
			authProviderType = 'ldap';
		} else {
			result = await authenticateLocal(username, password);
			authProviderType = 'local';
		}

		if (!result.success) {
			recordFailedAttempt(rateLimitKey);
			console.warn(`[Auth] Login failed: user=${username} provider=${authProviderType} ip=${clientIp} reason=${result.error || 'Authentication failed'}`);
			return json({ error: result.error || 'Authentication failed' }, { status: 401 });
		}

		// Handle MFA if required
		if (result.requiresMfa) {
			if (!mfaToken) {
				// Return that MFA is required
				return json({ requiresMfa: true }, { status: 200 });
			}

			// Verify MFA token
			const user = await getUserByUsername(username);
			if (!user || !(await verifyMfaToken(user.id, mfaToken))) {
				recordFailedAttempt(rateLimitKey);
				console.warn(`[Auth] MFA failed: user=${username} ip=${clientIp}`);
				return json({ error: 'Invalid MFA code' }, { status: 401 });
			}

			// MFA verified, create session
			const session = await createUserSession(user.id, authProviderType, cookies, request);
			clearRateLimit(rateLimitKey);
			console.log(`[Auth] Login successful: user=${username} provider=${authProviderType} ip=${clientIp} mfa=yes`);

			// Audit log
			await auditAuth(event, 'login', user.username, {
				provider: authProviderType,
				mfa: true
			});

			return json({
				success: true,
				user: {
					id: user.id,
					username: user.username,
					email: user.email,
					displayName: user.displayName,
					isAdmin: user.isAdmin
				}
			});
		}

		// No MFA, create session directly
		if (result.user) {
			const session = await createUserSession(result.user.id, authProviderType, cookies, request);
			clearRateLimit(rateLimitKey);
			console.log(`[Auth] Login successful: user=${result.user.username} provider=${authProviderType} ip=${clientIp} mfa=no`);

			// Audit log
			await auditAuth(event, 'login', result.user.username, {
				provider: authProviderType
			});

			return json({
				success: true,
				user: {
					id: result.user.id,
					username: result.user.username,
					email: result.user.email,
					displayName: result.user.displayName,
					isAdmin: result.user.isAdmin
				}
			});
		}

		return json({ error: 'Authentication failed' }, { status: 401 });
	} catch (error) {
		console.error('Login error:', error);
		return json({ error: 'Login failed' }, { status: 500 });
	}
};
