import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { handleOidcCallback, createUserSession, isAuthEnabled } from '$lib/server/auth';
import { auditAuth } from '$lib/server/audit';

// GET /api/auth/oidc/callback - Handle OIDC callback from IdP
export const GET: RequestHandler = async (event) => {
	const { url, cookies } = event;
	// Check if auth is enabled
	if (!isAuthEnabled()) {
		throw redirect(302, '/login?error=auth_disabled');
	}

	// Get parameters from URL
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const error = url.searchParams.get('error');
	const errorDescription = url.searchParams.get('error_description');

	// Handle error from IdP
	if (error) {
		console.error('OIDC error from IdP:', error, errorDescription);
		const errorMsg = encodeURIComponent(errorDescription || error);
		throw redirect(302, `/login?error=${errorMsg}`);
	}

	// Validate required parameters
	if (!code || !state) {
		throw redirect(302, '/login?error=invalid_callback');
	}

	try {
		const result = await handleOidcCallback(code, state);

		if (!result.success || !result.user) {
			const errorMsg = encodeURIComponent(result.error || 'Authentication failed');
			throw redirect(302, `/login?error=${errorMsg}`);
		}

		// Create session
		await createUserSession(result.user.id, 'oidc', cookies);

		// Audit log
		await auditAuth(event, 'login', result.user.username, {
			provider: 'oidc',
			providerId: result.providerId,
			providerName: result.providerName
		});

		// Redirect to the original destination or home
		const redirectUrl = result.redirectUrl || '/';
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
