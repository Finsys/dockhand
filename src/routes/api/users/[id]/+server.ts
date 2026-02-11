import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import {
	getUser,
	updateUser as dbUpdateUser,
	deleteUser as dbDeleteUser,
	deleteUserSessions,
	countAdminUsers,
	updateAuthSettings,
	userHasAdminRole,
	getRoleByName,
	assignUserRole,
	removeUserRole
} from '$lib/server/db';
import { hashPassword } from '$lib/server/auth';
import { authorize } from '$lib/server/authorize';
import { auditUser } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';

// GET /api/users/[id] - Get a specific user
// Free for all - local users are needed for basic auth
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	// When auth is enabled, require authentication (any authenticated user can view)
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	if (!params.id) {
		return json({ error: 'User ID is required' }, { status: 400 });
	}

	try {
		const id = parseInt(params.id);
		const user = await getUser(id);

		if (!user) {
			return json({ error: 'User not found' }, { status: 404 });
		}

		// Derive isAdmin from role assignment
		const isAdmin = await userHasAdminRole(id);

		return json({
			id: user.id,
			username: user.username,
			email: user.email,
			displayName: user.displayName,
			mfaEnabled: user.mfaEnabled,
			isAdmin,
			isActive: user.isActive,
			lastLogin: user.lastLogin,
			createdAt: user.createdAt,
			updatedAt: user.updatedAt
		});
	} catch (error) {
		console.error('Failed to get user:', error);
		return json({ error: 'Failed to get user' }, { status: 500 });
	}
};

// PUT /api/users/[id] - Update a user
// Free for all - local users are needed for basic auth
export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);

	if (!params.id) {
		return json({ error: 'User ID is required' }, { status: 400 });
	}

	const userId = parseInt(params.id);

	// Allow users to edit their own profile, otherwise check permission
	// (free edition allows all, enterprise checks RBAC)
	if (auth.user && auth.user.id !== userId && !await auth.can('users', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const data = await request.json();
		const existingUser = await getUser(userId);

		if (!existingUser) {
			return json({ error: 'User not found' }, { status: 404 });
		}

		// Check if user is currently an admin (via role)
		const existingUserIsAdmin = await userHasAdminRole(userId);

		// Build update object
		const updateData: any = {};

		if (data.username !== undefined) updateData.username = data.username;
		if (data.email !== undefined) updateData.email = data.email;
		if (data.displayName !== undefined) updateData.displayName = data.displayName;

		// Track if we need to change admin role
		let shouldPromote = false;
		let shouldDemote = false;

		// Only admins can change admin status or active status
		if (auth.isAdmin) {
			// Check if trying to demote or deactivate the last admin
			if (existingUserIsAdmin) {
				const adminCount = await countAdminUsers();
				const isDemoting = data.isAdmin === false;
				const isDeactivating = data.isActive === false;

				if (adminCount <= 1 && (isDemoting || isDeactivating)) {
					const confirmDisableAuth = data.confirmDisableAuth === true;
					if (!confirmDisableAuth) {
						return json({
							error: 'This is the last admin user',
							isLastAdmin: true,
							message: isDemoting
								? 'Removing admin privileges from this user will disable authentication.'
								: 'Deactivating this user will disable authentication.'
						}, { status: 409 });
					}

					// User confirmed - proceed and disable auth
					if (isDemoting) shouldDemote = true;
					if (isDeactivating) {
						updateData.isActive = false;
						await deleteUserSessions(userId);
					}

					// Disable authentication
					await updateAuthSettings({ authEnabled: false });

					// Update user first
					const user = await dbUpdateUser(userId, updateData);
					if (!user) {
						return json({ error: 'Failed to update user' }, { status: 500 });
					}

					// Remove Admin role if demoting
					if (shouldDemote) {
						const adminRole = await getRoleByName('Admin');
						if (adminRole) {
							await removeUserRole(userId, adminRole.id, null);
						}
					}

					return json({
						id: user.id,
						username: user.username,
						email: user.email,
						displayName: user.displayName,
						mfaEnabled: user.mfaEnabled,
						isAdmin: !shouldDemote && existingUserIsAdmin,
						isActive: user.isActive,
						lastLogin: user.lastLogin,
						createdAt: user.createdAt,
						updatedAt: user.updatedAt,
						authDisabled: true
					});
				}
			}

			// Handle isAdmin change via Admin role assignment
			if (data.isAdmin !== undefined) {
				if (data.isAdmin && !existingUserIsAdmin) {
					shouldPromote = true;
				} else if (!data.isAdmin && existingUserIsAdmin) {
					shouldDemote = true;
				}
			}
			if (data.isActive !== undefined) {
				updateData.isActive = data.isActive;
				// If deactivating, invalidate all sessions
				if (!data.isActive) {
					await deleteUserSessions(userId);
				}
			}
		}

		// Handle password change
		if (data.password) {
			if (data.password.length < 8) {
				return json({ error: 'Password must be at least 8 characters' }, { status: 400 });
			}
			updateData.passwordHash = await hashPassword(data.password);
			// Invalidate all sessions on password change (except current)
			await deleteUserSessions(userId);
		}

		const user = await dbUpdateUser(userId, updateData);

		if (!user) {
			return json({ error: 'Failed to update user' }, { status: 500 });
		}

		// Handle Admin role assignment/removal
		const adminRole = await getRoleByName('Admin');
		if (adminRole) {
			if (shouldPromote) {
				await assignUserRole(userId, adminRole.id, null);
			} else if (shouldDemote) {
				await removeUserRole(userId, adminRole.id, null);
			}
		}

		// Compute final isAdmin status
		const finalIsAdmin = shouldPromote || (existingUserIsAdmin && !shouldDemote);

		// Compute diff for audit (exclude sensitive fields)
		const diff = computeAuditDiff(
			{ username: existingUser.username, email: existingUser.email, displayName: existingUser.displayName, isActive: existingUser.isActive, isAdmin: existingUserIsAdmin },
			{ username: user.username, email: user.email, displayName: user.displayName, isActive: user.isActive, isAdmin: finalIsAdmin }
		);

		// Audit log
		await auditUser(event, 'update', user.id, user.username, diff);

		return json({
			id: user.id,
			username: user.username,
			email: user.email,
			displayName: user.displayName,
			mfaEnabled: user.mfaEnabled,
			isAdmin: finalIsAdmin,
			isActive: user.isActive,
			lastLogin: user.lastLogin,
			createdAt: user.createdAt,
			updatedAt: user.updatedAt
		});
	} catch (error: any) {
		console.error('Failed to update user:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'Username already exists' }, { status: 409 });
		}
		return json({ error: 'Failed to update user' }, { status: 500 });
	}
};

// DELETE /api/users/[id] - Delete a user
// Free for all - local users are needed for basic auth
export const DELETE: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const auth = await authorize(cookies);

	// When auth is enabled, check permission (free edition allows all, enterprise checks RBAC)
	if (auth.authEnabled && auth.isAuthenticated && !await auth.can('users', 'remove')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	if (!params.id) {
		return json({ error: 'User ID is required' }, { status: 400 });
	}

	const confirmDisableAuth = url.searchParams.get('confirmDisableAuth') === 'true';

	try {
		const id = parseInt(params.id);
		const isSelfDeletion = auth.user && auth.user.id === id;

		const user = await getUser(id);
		if (!user) {
			return json({ error: 'User not found' }, { status: 404 });
		}

		// Check if user is admin via role
		const userIsAdmin = await userHasAdminRole(id);

		// Check if this is the last admin user AND auth is enabled
		// Only warn if auth is currently ON (deleting last admin will turn it off)
		if (auth.authEnabled && userIsAdmin) {
			const adminCount = await countAdminUsers();
			if (adminCount <= 1) {
				// This is the last admin - require confirmation (whether self or other)
				if (!confirmDisableAuth) {
					return json({
						error: 'This is the last admin user',
						isLastAdmin: true,
						isSelf: isSelfDeletion,
						message: isSelfDeletion
							? 'This is the only admin account. Deleting it will disable authentication and allow anyone to access Dockhand.'
							: 'This is the only admin account. Deleting it will disable authentication and allow anyone to access Dockhand.'
					}, { status: 409 });
				}

				// User confirmed - proceed with deletion and disable auth
				await deleteUserSessions(id);
				const deleted = await dbDeleteUser(id);
				if (!deleted) {
					return json({ error: 'Failed to delete user' }, { status: 500 });
				}

				// Disable authentication
				await updateAuthSettings({ authEnabled: false });

				// Audit log
				await auditUser(event, 'delete', id, user.username);

				return json({ success: true, authDisabled: true });
			}
		}

		// Delete all sessions first
		await deleteUserSessions(id);

		const deleted = await dbDeleteUser(id);
		if (!deleted) {
			return json({ error: 'Failed to delete user' }, { status: 500 });
		}

		// Audit log
		await auditUser(event, 'delete', id, user.username);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete user:', error);
		return json({ error: 'Failed to delete user' }, { status: 500 });
	}
};
