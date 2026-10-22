import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { handleOidcCallback, createUserSession, isAuthEnabled, cookieNameFor } from '$lib/server/auth';
import { auditAuth } from '$lib/server/audit';
import { getClientIp } from '$lib/server/client-ip';
import { safeRedirectOrRoot } from '$lib/utils/safe-redirect';
import { decrypt, looksLikeCiphertext } from '$lib/server/encryption';
import {
	decodeLoginState,
	loginStateMessage
} from '$lib/server/oidc-login-state';

// GET /api/auth/oidc/callback - Handle OIDC callback from IdP
/**
 * @openapi
 * summary: Handle the OIDC redirect callback from the IdP — always responds with a 302 redirect (to the original destination on success, or to /login with an error query param on failure)
 * query: code:string Authorization code returned by the IdP
 * query: state:string Opaque state value used to correlate the request and carry the post-login redirect
 * query: error:string Error code returned by the IdP when authentication failed
 * query: error_description:string Human-readable error detail returned by the IdP
 * resp-302: Always a redirect — on success a session cookie is set and the caller is redirected to the original destination; on any error the caller is redirected to /login with an error query param
 */
export const GET: RequestHandler = async (event) => {
	const { url, cookies } = event;
	// Check if auth is enabled
	if (!await isAuthEnabled()) {
		throw redirect(302, '/login?error=auth_disabled');
	}

	// Get parameters from URL
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const error = url.searchParams.get('error');
	const errorDescription = url.searchParams.get('error_description');

	// Extract client IP for logging.
	const clientIp = getClientIp(event);

	// Handle error from IdP
	if (error) {
		console.warn(`[Auth] OIDC login failed: ip=${clientIp} error=${error}${errorDescription ? ` - ${errorDescription}` : ''}`);
		const errorMsg = encodeURIComponent(errorDescription || error);
		throw redirect(302, `/login?error=${errorMsg}`);
	}

	// Validate required parameters
	if (!code || !state) {
		throw redirect(302, '/login?error=invalid_callback');
	}

	// Read the login this callback belongs to, clearing the cookie first so a later
	// callback in this browser cannot resume it. What stops a concurrent replay is
	// the authorization code, which the provider honours once.
	const cookieName = cookieNameFor(state);
	const stateCookie = cookies.get(cookieName);
	cookies.delete(cookieName, { path: '/' });

	const loginState = decodeLoginState(
		stateCookie,
		state,
		{ isCiphertext: looksLikeCiphertext, decrypt },
		Date.now()
	);
	if (!loginState.ok) {
		const message = loginStateMessage(loginState.reason);
		// The sentence, not the bare code: "missing" alone leaves whoever reads the log
		// to guess between an expired login, a replay, and cookies being blocked.
		console.warn(`[Auth] OIDC login failed: ip=${clientIp} reason=${loginState.reason} - ${message}`);
		throw redirect(302, `/login?error=${encodeURIComponent(message)}`);
	}

	try {
		const result = await handleOidcCallback(code, loginState.state);

		if (!result.success || !result.user) {
			console.warn(`[Auth] OIDC login failed: ip=${clientIp} error=${result.error || 'Authentication failed'}`);
			const errorMsg = encodeURIComponent(result.error || 'Authentication failed');
			throw redirect(302, `/login?error=${errorMsg}`);
		}

		// Create session
		// Named, not a bare 'oidc': logging out has to know which provider to end the
		// session with, and the column already holds this shape for the user row.
		const sessionProvider = result.providerName ? `oidc:${result.providerName}` : 'oidc';
		await createUserSession(result.user.id, sessionProvider, cookies, event.request);
		console.log(`[Auth] OIDC login successful: user=${result.user.username} provider=${result.providerName || 'oidc'} ip=${clientIp}`);

		// Audit log
		await auditAuth(event, 'login', result.user.username, {
			provider: 'oidc',
			providerId: result.providerId,
			providerName: result.providerName
		});

		// Redirect to the original destination or home (validated path-relative)
		const redirectUrl = safeRedirectOrRoot(result.redirectUrl);
		throw redirect(302, redirectUrl);
	} catch (error: any) {
		// Re-throw redirect
		if (error.status === 302) {
			throw error;
		}
		console.error('OIDC callback error:', error);
		const errorMsg = encodeURIComponent(error.message || 'Authentication failed');
		throw redirect(302, `/login?error=${errorMsg}`);
	}
};
