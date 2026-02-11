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

// POST /api/auth/login - Authenticate user
export const POST: RequestHandler = async (event) => {
	const { request, cookies, getClientAddress } = event;
	// Check if auth is enabled
	if (!(await isAuthEnabled())) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	try {
		const { username, password, mfaToken, provider = 'local' } = await request.json();

		if (!username || !password) {
			return json({ error: 'Username and password are required' }, { status: 400 });
		}

		// Rate limiting by IP and username
		const clientIp = getClientAddress();
		const rateLimitKey = `${clientIp}:${username}`;

		const { limited, retryAfter } = isRateLimited(rateLimitKey);
		if (limited) {
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
				return json({ error: 'Invalid MFA code' }, { status: 401 });
			}

			// MFA verified, create session
			const session = await createUserSession(user.id, authProviderType, cookies);
			clearRateLimit(rateLimitKey);

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
			const session = await createUserSession(result.user.id, authProviderType, cookies);
			clearRateLimit(rateLimitKey);

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
