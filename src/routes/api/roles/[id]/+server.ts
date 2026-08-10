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
import { clearTokenCache } from '$lib/server/api-tokens';

// GET /api/roles/[id] - Get a specific role
/**
 * @openapi
 * summary: Get a single role by id; available in setup mode or with an enterprise license
 * path: id:integer! Numeric id of the role (from GET /api/roles)
 * resp-200: {id:integer!, name:string!, description:string, isSystem:boolean!, permissions:{}}
 * resp-400: Role id is required
 * resp-403: Enterprise license required
 * resp-404: Role not found
 * resp-500: Failed to read the role
 */
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
/**
 * @openapi
 * summary: Update a custom role (system roles cannot be modified; enterprise, admin required when auth is enabled)
 * description: environmentIds from GET /api/environments.
 * path: id:integer! Numeric id of the role (from GET /api/roles)
 * body: {name:string, description:string, permissions:{}, environmentIds:array<integer>}
 * body-example: {"description":"Updated description","permissions":{"containers":["view"]}}
 * resp-200: The updated role
 * resp-400: Role id is required, or the role is a system role and cannot be modified
 * resp-403: Enterprise license required, or admin access required
 * resp-404: Role not found
 * resp-409: A role with this name already exists
 * resp-500: Failed to update the role
 */
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

		// Clear token cache — any cached user with this role has stale permissions
		clearTokenCache();

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
/**
 * @openapi
 * summary: Delete a custom role by id (system roles cannot be deleted; enterprise, admin required when auth is enabled)
 * path: id:integer! Numeric id of the role (from GET /api/roles)
 * resp-200: {success:boolean!}
 * resp-400: Role id is required, or the role is a system role and cannot be deleted
 * resp-403: Enterprise license required, or admin access required
 * resp-404: Role not found
 * resp-500: Failed to delete the role
 */
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

		// Clear token cache — users with this role may have stale cached permissions
		clearTokenCache();

		// Audit log
		await auditRole(event, 'delete', id, role.name);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete role:', error);
		return json({ error: 'Failed to delete role' }, { status: 500 });
	}
};
