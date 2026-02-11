import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import {
	getOidcConfigs,
	createOidcConfig,
	type OidcConfig
} from '$lib/server/db';
import { auditOidcProvider } from '$lib/server/audit';

// GET /api/auth/oidc - List all OIDC configurations
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	// When auth is enabled, require authentication and settings:view permission
	if (auth.authEnabled) {
		if (!auth.isAuthenticated) {
			return json({ error: 'Authentication required' }, { status: 401 });
		}
		if (!await auth.can('settings', 'view')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
	}

	try {
		const configs = await getOidcConfigs();
		// Sanitize sensitive data
		const sanitized = configs.map(config => ({
			...config,
			clientSecret: config.clientSecret ? '********' : ''
		}));
		return json(sanitized);
	} catch (error) {
		console.error('Failed to get OIDC configs:', error);
		return json({ error: 'Failed to get OIDC configurations' }, { status: 500 });
	}
};

// POST /api/auth/oidc - Create new OIDC configuration
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);

	// When auth is enabled, require authentication and settings:edit permission
	if (auth.authEnabled) {
		if (!auth.isAuthenticated) {
			return json({ error: 'Authentication required' }, { status: 401 });
		}
		if (!await auth.can('settings', 'edit')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
	}

	try {
		const data = await request.json();

		// Validate required fields
		const required = ['name', 'issuerUrl', 'clientId', 'clientSecret', 'redirectUri'];
		for (const field of required) {
			if (!data[field]) {
				return json({ error: `Missing required field: ${field}` }, { status: 400 });
			}
		}

		const config = await createOidcConfig({
			name: data.name,
			enabled: data.enabled ?? false,
			issuerUrl: data.issuerUrl,
			clientId: data.clientId,
			clientSecret: data.clientSecret,
			redirectUri: data.redirectUri,
			scopes: data.scopes || 'openid profile email',
			usernameClaim: data.usernameClaim || 'preferred_username',
			emailClaim: data.emailClaim || 'email',
			displayNameClaim: data.displayNameClaim || 'name',
			adminClaim: data.adminClaim || undefined,
			adminValue: data.adminValue || undefined,
			roleMappingsClaim: data.roleMappingsClaim || 'groups',
			roleMappings: data.roleMappings || undefined
		});

		// Audit log
		await auditOidcProvider(event, 'create', config.id, config.name);

		return json({
			...config,
			clientSecret: '********'
		}, { status: 201 });
	} catch (error: any) {
		console.error('Failed to create OIDC config:', error);
		return json({ error: error.message || 'Failed to create OIDC configuration' }, { status: 500 });
	}
};
