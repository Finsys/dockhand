import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { isEnterprise } from '$lib/server/license';
import { validateSession } from '$lib/server/auth';
import {
	getUserRoles,
	assignUserRole,
	removeUserRole,
	getUser,
	getRole
} from '$lib/server/db';
import { auditUser } from '$lib/server/audit';

// GET /api/users/[id]/roles - Get roles assigned to a user
export const GET: RequestHandler = async ({ params, cookies }) => {
	// Check enterprise license
	if (!(await isEnterprise())) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	if (!params.id) {
		return json({ error: 'User ID is required' }, { status: 400 });
	}

	try {
		const userId = parseInt(params.id);
		const user = await getUser(userId);

		if (!user) {
			return json({ error: 'User not found' }, { status: 404 });
		}

		const userRoles = await getUserRoles(userId);
		return json(userRoles);
	} catch (error) {
		console.error('Failed to get user roles:', error);
		return json({ error: 'Failed to get user roles' }, { status: 500 });
	}
};

// POST /api/users/[id]/roles - Assign a role to a user
export const POST: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	// Check enterprise license
	if (!(await isEnterprise())) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	const currentUser = await validateSession(cookies);
	if (!currentUser || !currentUser.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	if (!params.id) {
		return json({ error: 'User ID is required' }, { status: 400 });
	}

	try {
		const userId = parseInt(params.id);
		const { roleId, environmentId } = await request.json();

		if (!roleId) {
			return json({ error: 'Role ID is required' }, { status: 400 });
		}

		const user = await getUser(userId);
		if (!user) {
			return json({ error: 'User not found' }, { status: 404 });
		}

		const userRole = await assignUserRole(userId, roleId, environmentId);

		// Audit log - role assigned
		const role = await getRole(roleId);
		await auditUser(event, 'update', userId, user.username, {
			roleAssigned: role?.name || `Role #${roleId}`,
			roleId
		});

		return json(userRole, { status: 201 });
	} catch (error) {
		console.error('Failed to assign role:', error);
		return json({ error: 'Failed to assign role' }, { status: 500 });
	}
};

// DELETE /api/users/[id]/roles - Remove a role from a user
export const DELETE: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	// Check enterprise license
	if (!(await isEnterprise())) {
		return json({ error: 'Enterprise license required' }, { status: 403 });
	}

	const currentUser = await validateSession(cookies);
	if (!currentUser || !currentUser.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	if (!params.id) {
		return json({ error: 'User ID is required' }, { status: 400 });
	}

	try {
		const userId = parseInt(params.id);
		const { roleId, environmentId } = await request.json();

		if (!roleId) {
			return json({ error: 'Role ID is required' }, { status: 400 });
		}

		// Get user and role info before deletion for audit
		const user = await getUser(userId);
		const role = await getRole(roleId);

		const deleted = await removeUserRole(userId, roleId, environmentId);
		if (!deleted) {
			return json({ error: 'Role assignment not found' }, { status: 404 });
		}

		// Audit log - role removed
		if (user) {
			await auditUser(event, 'update', userId, user.username, {
				roleRemoved: role?.name || `Role #${roleId}`,
				roleId
			});
		}

		return json({ success: true });
	} catch (error) {
		console.error('Failed to remove role:', error);
		return json({ error: 'Failed to remove role' }, { status: 500 });
	}
};
