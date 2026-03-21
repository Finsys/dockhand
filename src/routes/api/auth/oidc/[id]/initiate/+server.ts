import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { buildOidcAuthorizationUrl, isAuthEnabled } from '$lib/server/auth';
import { getOidcConfig } from '$lib/server/db';

// GET /api/auth/oidc/[id]/initiate - Start OIDC authentication flow
export const GET: RequestHandler = async ({ params, url }) => {
	// Check if auth is enabled
	if (!await isAuthEnabled()) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const id = parseInt(params.id || '');
	if (isNaN(id)) {
		return json({ error: 'Invalid configuration ID' }, { status: 400 });
	}

	// Get redirect URL from query params
	const redirectUrl = url.searchParams.get('redirect') || '/';

	try {
		const config = await getOidcConfig(id);
		if (!config || !config.enabled) {
			return json({ error: 'OIDC provider not found or disabled' }, { status: 404 });
		}

		const result = await buildOidcAuthorizationUrl(id, redirectUrl);

		if ('error' in result) {
			return json({ error: result.error }, { status: 500 });
		}

		// Redirect to the IdP
		throw redirect(302, result.url);
	} catch (error: any) {
		// Re-throw redirect
		if (error.status === 302) {
			throw error;
		}
		console.error('Failed to initiate OIDC:', error);
		return json({ error: error.message || 'Failed to initiate SSO' }, { status: 500 });
	}
};

// POST /api/auth/oidc/[id]/initiate - Get authorization URL without redirect
export const POST: RequestHandler = async ({ params, request }) => {
	// Check if auth is enabled
	if (!await isAuthEnabled()) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const id = parseInt(params.id || '');
	if (isNaN(id)) {
		return json({ error: 'Invalid configuration ID' }, { status: 400 });
	}

	try {
		const body = await request.json().catch(() => ({}));
		const redirectUrl = body.redirect || '/';

		const config = await getOidcConfig(id);
		if (!config || !config.enabled) {
			return json({ error: 'OIDC provider not found or disabled' }, { status: 404 });
		}

		const result = await buildOidcAuthorizationUrl(id, redirectUrl);

		if ('error' in result) {
			return json({ error: result.error }, { status: 500 });
		}

		return json({ url: result.url });
	} catch (error: any) {
		console.error('Failed to get OIDC authorization URL:', error);
		return json({ error: error.message || 'Failed to initiate SSO' }, { status: 500 });
	}
};
