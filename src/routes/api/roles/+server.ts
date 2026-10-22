import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import {
	getRoles,
	createRole as dbCreateRole
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditRole } from '$lib/server/audit';

// GET /api/roles - List all roles
/**
 * @openapi
 * summary: List all roles (built-in and custom); needs admin or users:view, plus an enterprise license
 * resp-200: array<{id:integer!, name:string!, description:string, isSystem:boolean!, permissions:{}}>
 * resp-403: Enterprise license required, or the account may not view users
 * resp-500: Failed to read the roles
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	// Before auth is switched on there is nobody to check, and the setup screens show
	// the built-in roles.
	if (auth.authEnabled) {
		if (!auth.isEnterprise) {
			return json({ error: 'Enterprise license required' }, { status: 403 });
		}
		// A role carries its full permission matrix, which is a map of who may do what
		// here. Reading it belongs with managing users, not with holding an account.
		if (!auth.isAdmin && !(await auth.can('users', 'view'))) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
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
/**
 * @openapi
 * summary: Create a custom role (enterprise; admin required when auth is enabled)
 * description: environmentIds from GET /api/environments.
 * body: {name:string!, description:string, permissions:{}!, environmentIds:array<integer>}
 * body-example: {"name":"Operators","description":"Can manage containers","permissions":{"containers":["view","edit"]},"environmentIds":[1,2]}
 * resp-201: The created role
 * resp-400: Name and permissions are required
 * resp-403: Enterprise license required, or admin access required
 * resp-409: A role with this name already exists
 * resp-500: Failed to create the role
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);

	// Check enterprise license
	if (!auth.hasValidLicense) {
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
