import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import {
	getOidcConfig,
	updateOidcConfig,
	deleteOidcConfig
} from '$lib/server/db';
import { auditOidcProvider } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';

// GET /api/auth/oidc/[id] - Get specific OIDC configuration
export const GET: RequestHandler = async ({ params, cookies }) => {
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

	const id = parseInt(params.id || '');
	if (isNaN(id)) {
		return json({ error: 'Invalid configuration ID' }, { status: 400 });
	}

	try {
		const config = await getOidcConfig(id);
		if (!config) {
			return json({ error: 'OIDC configuration not found' }, { status: 404 });
		}

		return json({
			...config,
			clientSecret: config.clientSecret ? '********' : ''
		});
	} catch (error) {
		console.error('Failed to get OIDC config:', error);
		return json({ error: 'Failed to get OIDC configuration' }, { status: 500 });
	}
};

// PUT /api/auth/oidc/[id] - Update OIDC configuration
export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
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

	const id = parseInt(params.id || '');
	if (isNaN(id)) {
		return json({ error: 'Invalid configuration ID' }, { status: 400 });
	}

	try {
		const existing = await getOidcConfig(id);
		if (!existing) {
			return json({ error: 'OIDC configuration not found' }, { status: 404 });
		}

		const data = await request.json();

		// Don't update clientSecret if it's the masked value
		const updateData: any = {};
		if (data.name !== undefined) updateData.name = data.name;
		if (data.enabled !== undefined) updateData.enabled = data.enabled;
		if (data.issuerUrl !== undefined) updateData.issuerUrl = data.issuerUrl;
		if (data.clientId !== undefined) updateData.clientId = data.clientId;
		if (data.clientSecret !== undefined && data.clientSecret !== '********') {
			updateData.clientSecret = data.clientSecret;
		}
		if (data.redirectUri !== undefined) updateData.redirectUri = data.redirectUri;
		if (data.scopes !== undefined) updateData.scopes = data.scopes;
		if (data.usernameClaim !== undefined) updateData.usernameClaim = data.usernameClaim;
		if (data.emailClaim !== undefined) updateData.emailClaim = data.emailClaim;
		if (data.displayNameClaim !== undefined) updateData.displayNameClaim = data.displayNameClaim;
		if (data.adminClaim !== undefined) updateData.adminClaim = data.adminClaim;
		if (data.adminValue !== undefined) updateData.adminValue = data.adminValue;
		if (data.roleMappingsClaim !== undefined) updateData.roleMappingsClaim = data.roleMappingsClaim;
		if (data.roleMappings !== undefined) updateData.roleMappings = data.roleMappings;

		const config = await updateOidcConfig(id, updateData);
		if (!config) {
			return json({ error: 'Failed to update OIDC configuration' }, { status: 500 });
		}

		// Compute diff for audit (exclude sensitive fields)
		const diff = computeAuditDiff(existing, config, {
			excludeFields: ['clientSecret', 'createdAt', 'updatedAt']
		});

		// Audit log
		await auditOidcProvider(event, 'update', config.id, config.name, diff);

		return json({
			...config,
			clientSecret: config.clientSecret ? '********' : ''
		});
	} catch (error: any) {
		console.error('Failed to update OIDC config:', error);
		return json({ error: error.message || 'Failed to update OIDC configuration' }, { status: 500 });
	}
};

// DELETE /api/auth/oidc/[id] - Delete OIDC configuration
export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
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

	const id = parseInt(params.id || '');
	if (isNaN(id)) {
		return json({ error: 'Invalid configuration ID' }, { status: 400 });
	}

	try {
		// Get config before deletion for audit
		const config = await getOidcConfig(id);
		if (!config) {
			return json({ error: 'OIDC configuration not found' }, { status: 404 });
		}

		const deleted = await deleteOidcConfig(id);
		if (!deleted) {
			return json({ error: 'Failed to delete OIDC configuration' }, { status: 500 });
		}

		// Audit log
		await auditOidcProvider(event, 'delete', id, config.name);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete OIDC config:', error);
		return json({ error: 'Failed to delete OIDC configuration' }, { status: 500 });
	}
};
