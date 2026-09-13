import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { buildOidcAuthorizationUrl, isAuthEnabled } from '$lib/server/auth';
import { getOidcConfig } from '$lib/server/db';
import { safeRedirectOrRoot } from '$lib/utils/safe-redirect';

// GET /api/auth/oidc/[id]/initiate - Start OIDC authentication flow
/**
 * @openapi
 * summary: Start the OIDC login flow for a provider — on success throws a 302 redirect to the IdP authorization URL
 * path: id:integer! Numeric id of the OIDC provider (from GET /api/auth/oidc)
 * query: redirect:string Post-login destination path to return to (defaults to /)
 * resp-302: Redirect to the IdP's authorization URL
 * resp-400: Authentication is not enabled, or the configuration id is invalid
 * resp-404: OIDC provider not found or disabled
 * resp-500: Failed to build the authorization URL / initiate SSO
 */
export const GET: RequestHandler = async ({ params, url }) => {
	// Check if auth is enabled
	if (!await isAuthEnabled()) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const id = parseInt(params.id || '');
	if (isNaN(id)) {
		return json({ error: 'Invalid configuration ID' }, { status: 400 });
	}

	// Get redirect URL from query params (validated path-relative only)
	const redirectUrl = safeRedirectOrRoot(url.searchParams.get('redirect'));

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
/**
 * @openapi
 * summary: Return the OIDC authorization URL for a provider without redirecting (JSON response)
 * path: id:integer! Numeric id of the OIDC provider (from GET /api/auth/oidc)
 * body: {redirect:string}
 * body-example: {"redirect":"/dashboard"}
 * resp-200: {url:string!}
 * resp-400: Authentication is not enabled, or the configuration id is invalid
 * resp-404: OIDC provider not found or disabled
 * resp-500: Failed to build the authorization URL / initiate SSO
 */
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
		const redirectUrl = safeRedirectOrRoot(body.redirect);

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
