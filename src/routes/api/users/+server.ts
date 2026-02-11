import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import {
	getUsers,
	createUser as dbCreateUser,
	assignUserRole,
	hasAdminUser,
	getUserRoles,
	userHasAdminRole,
	getRoleByName
} from '$lib/server/db';
import { hashPassword, createUserSession } from '$lib/server/auth';
import { authorize } from '$lib/server/authorize';
import { auditUser } from '$lib/server/audit';

// GET /api/users - List all users
// Free for all - local users are needed for basic auth
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	// When auth is enabled, require valid session (no specific permission needed to view users list)
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}
	// Any authenticated user can view the users list
	// Admin permissions are only needed for create/edit/delete operations

	try {
		const allUsers = await getUsers();
		const users = await Promise.all(allUsers.map(async user => {
			// Derive isAdmin from role assignment
			const isAdmin = await userHasAdminRole(user.id);
			const isSso = !user.passwordHash;
			const userData: any = {
				id: user.id,
				username: user.username,
				email: user.email,
				displayName: user.displayName,
				mfaEnabled: user.mfaEnabled,
				isAdmin,
				isActive: user.isActive,
				isSso,
				authProvider: user.authProvider || 'local',
				lastLogin: user.lastLogin,
				createdAt: user.createdAt
			};
			// Include roles for enterprise users
			if (auth.isEnterprise) {
				const userRoles = await getUserRoles(user.id);
				userData.roles = userRoles.map(ur => ({
					id: ur.roleId,
					name: ur.role?.name,
					environmentId: ur.environmentId
				}));
			}
			return userData;
		}));
		return json(users);
	} catch (error) {
		console.error('Failed to get users:', error);
		return json({ error: 'Failed to get users' }, { status: 500 });
	}
};

// POST /api/users - Create a new user
// Free for all - local users are needed for basic auth
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);

	// When auth is enabled and user is logged in, check they can manage users
	// (allow if no user logged in for initial setup when no users exist)
	if (auth.authEnabled && auth.isAuthenticated && !await auth.canManageUsers()) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const { username, email, password, displayName } = await request.json();

		if (!username || !password) {
			return json({ error: 'Username and password are required' }, { status: 400 });
		}

		// Validate password strength
		if (password.length < 8) {
			return json({ error: 'Password must be at least 8 characters' }, { status: 400 });
		}

		// Hash password
		const passwordHash = await hashPassword(password);

		// Check if this is the first user
		const isFirstUser = !(await hasAdminUser());

		// Create user
		const user = await dbCreateUser({
			username,
			email,
			passwordHash,
			displayName
		});

		// Role assignment logic:
		// - Enterprise: Roles are managed via syncUserRoles() from the modal (no auto-assignment here)
		// - Free edition: All users get Admin role (no RBAC)
		// - First user: Always gets Admin role (regardless of edition)
		if (!auth.isEnterprise || isFirstUser) {
			const adminRole = await getRoleByName('Admin');
			if (adminRole) {
				await assignUserRole(user.id, adminRole.id, null);
			}
		}

		// Auto-login if this is the first user being created (and auth is enabled)
		let autoLoggedIn = false;
		if (isFirstUser && auth.authEnabled) {
			await createUserSession(user.id, 'local', cookies);
			autoLoggedIn = true;
		}

		// Audit log
		await auditUser(event, 'create', user.id, user.username);

		return json({
			id: user.id,
			username: user.username,
			email: user.email,
			displayName: user.displayName,
			isAdmin: !auth.isEnterprise || isFirstUser,
			isActive: user.isActive,
			createdAt: user.createdAt,
			autoLoggedIn: autoLoggedIn
		}, { status: 201 });
	} catch (error: any) {
		console.error('Failed to create user:', error);
		console.error('Error details:', {
			message: error.message,
			code: error.code,
			name: error.name,
			stack: error.stack
		});
		if (error.message?.includes('UNIQUE constraint failed') || error.code === '23505') {
			return json({ error: 'Username already exists' }, { status: 409 });
		}
		return json({ error: 'Failed to create user', details: error.message }, { status: 500 });
	}
};
