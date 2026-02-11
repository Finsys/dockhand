import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getLdapConfig, updateLdapConfig, deleteLdapConfig } from '$lib/server/db';
import { auditLdapConfig } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';

// GET /api/auth/ldap/[id] - Get a specific LDAP configuration
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	// Allow access when auth is disabled (setup mode) or when user is admin
	if (auth.authEnabled && (!auth.isAuthenticated || !auth.isAdmin)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!auth.isEnterprise) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	const id = parseInt(params.id!, 10);
	if (isNaN(id)) {
		return json({ error: 'Invalid ID' }, { status: 400 });
	}

	try {
		const config = await getLdapConfig(id);
		if (!config) {
			return json({ error: 'LDAP configuration not found' }, { status: 404 });
		}

		return json({
			...config,
			bindPassword: config.bindPassword ? '********' : undefined
		});
	} catch (error) {
		console.error('Failed to get LDAP config:', error);
		return json({ error: 'Failed to get LDAP configuration' }, { status: 500 });
	}
};

// PUT /api/auth/ldap/[id] - Update a LDAP configuration
export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);

	// Allow access when auth is disabled (setup mode) or when user is admin
	if (auth.authEnabled && (!auth.isAuthenticated || !auth.isAdmin)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!auth.isEnterprise) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	const id = parseInt(params.id!, 10);
	if (isNaN(id)) {
		return json({ error: 'Invalid ID' }, { status: 400 });
	}

	try {
		const existing = await getLdapConfig(id);
		if (!existing) {
			return json({ error: 'LDAP configuration not found' }, { status: 404 });
		}

		const data = await request.json();

		// Don't update password if it's the masked value
		const updateData: any = {};
		if (data.name !== undefined) updateData.name = data.name;
		if (data.enabled !== undefined) updateData.enabled = data.enabled;
		if (data.serverUrl !== undefined) updateData.serverUrl = data.serverUrl;
		if (data.bindDn !== undefined) updateData.bindDn = data.bindDn;
		if (data.bindPassword !== undefined && data.bindPassword !== '********') {
			updateData.bindPassword = data.bindPassword;
		}
		if (data.baseDn !== undefined) updateData.baseDn = data.baseDn;
		if (data.userFilter !== undefined) updateData.userFilter = data.userFilter;
		if (data.usernameAttribute !== undefined) updateData.usernameAttribute = data.usernameAttribute;
		if (data.emailAttribute !== undefined) updateData.emailAttribute = data.emailAttribute;
		if (data.displayNameAttribute !== undefined) updateData.displayNameAttribute = data.displayNameAttribute;
		if (data.groupBaseDn !== undefined) updateData.groupBaseDn = data.groupBaseDn;
		if (data.groupFilter !== undefined) updateData.groupFilter = data.groupFilter;
		if (data.adminGroup !== undefined) updateData.adminGroup = data.adminGroup;
		if (data.roleMappings !== undefined) updateData.roleMappings = data.roleMappings;
		if (data.tlsEnabled !== undefined) updateData.tlsEnabled = data.tlsEnabled;
		if (data.tlsCa !== undefined) updateData.tlsCa = data.tlsCa;

		const config = await updateLdapConfig(id, updateData);
		if (!config) {
			return json({ error: 'Failed to update configuration' }, { status: 500 });
		}

		// Compute diff for audit (exclude sensitive fields)
		const diff = computeAuditDiff(existing, config, {
			excludeFields: ['bindPassword', 'tlsCa', 'createdAt', 'updatedAt']
		});

		// Audit log
		await auditLdapConfig(event, 'update', config.id, config.name, diff);

		return json({
			...config,
			bindPassword: config.bindPassword ? '********' : undefined
		});
	} catch (error) {
		console.error('Failed to update LDAP config:', error);
		return json({ error: 'Failed to update LDAP configuration' }, { status: 500 });
	}
};

// DELETE /api/auth/ldap/[id] - Delete a LDAP configuration
export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);

	// Allow access when auth is disabled (setup mode) or when user is admin
	if (auth.authEnabled && (!auth.isAuthenticated || !auth.isAdmin)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!auth.isEnterprise) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	const id = parseInt(params.id!, 10);
	if (isNaN(id)) {
		return json({ error: 'Invalid ID' }, { status: 400 });
	}

	try {
		// Get config before deletion for audit
		const config = await getLdapConfig(id);
		if (!config) {
			return json({ error: 'LDAP configuration not found' }, { status: 404 });
		}

		const deleted = await deleteLdapConfig(id);
		if (!deleted) {
			return json({ error: 'Failed to delete LDAP configuration' }, { status: 500 });
		}

		// Audit log
		await auditLdapConfig(event, 'delete', id, config.name);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete LDAP config:', error);
		return json({ error: 'Failed to delete LDAP configuration' }, { status: 500 });
	}
};
