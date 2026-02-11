import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import {
	getRoles,
	createRole as dbCreateRole
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditRole } from '$lib/server/audit';

// GET /api/roles - List all roles
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	// Allow viewing roles when auth is disabled (setup mode) or with enterprise license
	// This lets users see built-in roles before activating auth/enterprise
	if (auth.authEnabled && !auth.isEnterprise) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	try {
		const roles = await getRoles();
		return json(roles);
	} catch (error) {
		console.error('Failed to get roles:', error);
		return json({ error: 'Failed to get roles' }, { status: 500 });
	}
};

// POST /api/roles - Create a new role
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);

	// Check enterprise license
	if (!auth.isEnterprise) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	// When auth is disabled, allow all operations (setup mode)
	// When auth is enabled, require admin access
	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	try {
		const { name, description, permissions, environmentIds } = await request.json();

		if (!name || !permissions) {
			return json({ error: 'Name and permissions are required' }, { status: 400 });
		}

		const role = await dbCreateRole({
			name,
			description,
			permissions,
			environmentIds: environmentIds ?? null
		});

		// Audit log
		await auditRole(event, 'create', role.id, role.name);

		return json(role, { status: 201 });
	} catch (error: any) {
		console.error('Failed to create role:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'Role name already exists' }, { status: 409 });
		}
		return json({ error: 'Failed to create role' }, { status: 500 });
	}
};
