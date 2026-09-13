import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { getUser, updateUser as dbUpdateUser, deleteUserSessions, userHasAdminRole } from '$lib/server/db';
import { validateSession, hashPassword, isAuthEnabled } from '$lib/server/auth';
import { invalidateTokenCacheForUser } from '$lib/server/api-tokens';

// GET /api/profile - Get current user's profile
/**
 * @openapi
 * summary: Get the authenticated user's own profile
 * resp-200: {id:integer!, username:string!, email:string, displayName:string, avatar:string, mfaEnabled:boolean!, isAdmin:boolean!, provider:string!, lastLogin:string, createdAt:string!, updatedAt:string!}
 * resp-400: Authentication is not enabled
 * resp-401: Not authenticated
 * resp-404: User not found
 * resp-500: Failed to read the profile
 */
export const GET: RequestHandler = async ({ cookies }) => {
	if (!(await isAuthEnabled())) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const currentUser = await validateSession(cookies);
	if (!currentUser) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}

	try {
		const user = await getUser(currentUser.id);
		if (!user) {
			return json({ error: 'User not found' }, { status: 404 });
		}

		// Derive isAdmin from role assignment
		const isAdmin = await userHasAdminRole(user.id);

		return json({
			id: user.id,
			username: user.username,
			email: user.email,
			displayName: user.displayName,
			avatar: user.avatar,
			mfaEnabled: user.mfaEnabled,
			isAdmin,
			provider: currentUser.provider || 'local',
			lastLogin: user.lastLogin,
			createdAt: user.createdAt,
			updatedAt: user.updatedAt
		});
	} catch (error) {
		console.error('Failed to get profile:', error);
		return json({ error: 'Failed to get profile' }, { status: 500 });
	}
};

// PUT /api/profile - Update current user's profile
/**
 * @openapi
 * summary: Update the authenticated user's own profile (email/display name, and optionally the password with current-password confirmation)
 * body: {email:string, displayName:string, currentPassword:string, newPassword:string}
 * body-example: {"displayName":"Jane Doe","currentPassword":"***","newPassword":"***"}
 * resp-200: {id:integer!, username:string!, email:string, displayName:string, avatar:string, mfaEnabled:boolean!, isAdmin:boolean!, lastLogin:string, createdAt:string!, updatedAt:string!}
 * resp-400: Authentication is not enabled, current password missing, new password too short (<8), or current password incorrect
 * resp-401: Not authenticated
 * resp-404: User not found
 * resp-500: Failed to update the profile
 */
export const PUT: RequestHandler = async ({ request, cookies }) => {
	if (!(await isAuthEnabled())) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const currentUser = await validateSession(cookies);
	if (!currentUser) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}

	try {
		const data = await request.json();
		const existingUser = await getUser(currentUser.id);

		if (!existingUser) {
			return json({ error: 'User not found' }, { status: 404 });
		}

		// Build update object - users can only update certain fields
		const updateData: any = {};

		if (data.email !== undefined) updateData.email = data.email;
		if (data.displayName !== undefined) updateData.displayName = data.displayName;

		// Handle password change - require current password
		if (data.newPassword) {
			if (!data.currentPassword) {
				return json({ error: 'Current password is required' }, { status: 400 });
			}

			if (data.newPassword.length < 8) {
				return json({ error: 'Password must be at least 8 characters' }, { status: 400 });
			}

			// Verify current password
			const { verifyPassword } = await import('$lib/server/auth');
			const isValid = await verifyPassword(data.currentPassword, existingUser.passwordHash);
			if (!isValid) {
				return json({ error: 'Current password is incorrect' }, { status: 400 });
			}

			updateData.passwordHash = await hashPassword(data.newPassword);
			// Invalidate other sessions and token cache on password change
			await deleteUserSessions(currentUser.id);
			invalidateTokenCacheForUser(currentUser.id);
		}

		const user = await dbUpdateUser(currentUser.id, updateData);

		if (!user) {
			return json({ error: 'Failed to update profile' }, { status: 500 });
		}

		// Derive isAdmin from role assignment
		const isAdmin = await userHasAdminRole(user.id);

		return json({
			id: user.id,
			username: user.username,
			email: user.email,
			displayName: user.displayName,
			avatar: user.avatar,
			mfaEnabled: user.mfaEnabled,
			isAdmin,
			lastLogin: user.lastLogin,
			createdAt: user.createdAt,
			updatedAt: user.updatedAt
		});
	} catch (error: any) {
		console.error('Failed to update profile:', error);
		return json({ error: 'Failed to update profile' }, { status: 500 });
	}
};
