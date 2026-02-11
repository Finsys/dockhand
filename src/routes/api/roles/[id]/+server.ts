import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import {
	getRole,
	updateRole as dbUpdateRole,
	deleteRole as dbDeleteRole
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditRole } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';

// GET /api/roles/[id] - Get a specific role
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	// Allow viewing roles when auth is disabled (setup mode) or with enterprise license
	if (auth.authEnabled && !auth.isEnterprise) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	if (!params.id) {
		return json({ error: 'Role ID is required' }, { status: 400 });
	}

	try {
		const id = parseInt(params.id);
		const role = await getRole(id);

		if (!role) {
			return json({ error: 'Role not found' }, { status: 404 });
		}

		return json(role);
	} catch (error) {
		console.error('Failed to get role:', error);
		return json({ error: 'Failed to get role' }, { status: 500 });
	}
};

// PUT /api/roles/[id] - Update a role
export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
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

	if (!params.id) {
		return json({ error: 'Role ID is required' }, { status: 400 });
	}

	try {
		const id = parseInt(params.id);
		const data = await request.json();

		const existingRole = await getRole(id);
		if (!existingRole) {
			return json({ error: 'Role not found' }, { status: 404 });
		}

		if (existingRole.isSystem) {
			return json({ error: 'Cannot modify system roles' }, { status: 400 });
		}

		const role = await dbUpdateRole(id, data);
		if (!role) {
			return json({ error: 'Failed to update role' }, { status: 500 });
		}

		// Compute diff for audit
		const diff = computeAuditDiff(existingRole, role);

		// Audit log
		await auditRole(event, 'update', role.id, role.name, diff);

		return json(role);
	} catch (error: any) {
		console.error('Failed to update role:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'Role name already exists' }, { status: 409 });
		}
		return json({ error: 'Failed to update role' }, { status: 500 });
	}
};

// DELETE /api/roles/[id] - Delete a role
export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
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

	if (!params.id) {
		return json({ error: 'Role ID is required' }, { status: 400 });
	}

	try {
		const id = parseInt(params.id);
		const role = await getRole(id);

		if (!role) {
			return json({ error: 'Role not found' }, { status: 404 });
		}

		if (role.isSystem) {
			return json({ error: 'Cannot delete system roles' }, { status: 400 });
		}

		const deleted = await dbDeleteRole(id);
		if (!deleted) {
			return json({ error: 'Failed to delete role' }, { status: 500 });
		}

		// Audit log
		await auditRole(event, 'delete', id, role.name);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete role:', error);
		return json({ error: 'Failed to delete role' }, { status: 500 });
	}
};
