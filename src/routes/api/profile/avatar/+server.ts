import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { updateUser as dbUpdateUser, getUser } from '$lib/server/db';
import { validateSession, isAuthEnabled } from '$lib/server/auth';

// POST /api/profile/avatar - Upload avatar (base64 data URL)
/**
 * @openapi
 * summary: Upload the authenticated user's avatar as a base64 image data URL (max ~500KB)
 * body: {avatar:string!}
 * body-example: {"avatar":"data:image/png;base64,iVBORw0KGgo..."}
 * resp-200: {success:boolean!, avatar:string!}
 * resp-400: Authentication is not enabled, avatar data missing, not an image data URL, or image too large (>500KB)
 * resp-401: Not authenticated
 * resp-500: Failed to upload the avatar
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!(await isAuthEnabled())) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const currentUser = await validateSession(cookies);
	if (!currentUser) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}

	try {
		const data = await request.json();

		if (!data.avatar) {
			return json({ error: 'Avatar data is required' }, { status: 400 });
		}

		// Validate it's a valid base64 data URL
		if (!data.avatar.startsWith('data:image/')) {
			return json({ error: 'Invalid image format' }, { status: 400 });
		}

		// Check size (limit to ~500KB base64 which is roughly 375KB image)
		if (data.avatar.length > 500000) {
			return json({ error: 'Image too large. Maximum size is 500KB.' }, { status: 400 });
		}

		const user = await dbUpdateUser(currentUser.id, { avatar: data.avatar });

		if (!user) {
			return json({ error: 'Failed to update avatar' }, { status: 500 });
		}

		return json({ success: true, avatar: user.avatar });
	} catch (error) {
		console.error('Failed to upload avatar:', error);
		return json({ error: 'Failed to upload avatar' }, { status: 500 });
	}
};

// DELETE /api/profile/avatar - Remove avatar
/**
 * @openapi
 * summary: Remove the authenticated user's avatar
 * resp-200: {success:boolean!}
 * resp-400: Authentication is not enabled
 * resp-401: Not authenticated
 * resp-500: Failed to remove the avatar
 */
export const DELETE: RequestHandler = async ({ cookies }) => {
	if (!(await isAuthEnabled())) {
		return json({ error: 'Authentication is not enabled' }, { status: 400 });
	}

	const currentUser = await validateSession(cookies);
	if (!currentUser) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}

	try {
		const user = await dbUpdateUser(currentUser.id, { avatar: null });

		if (!user) {
			return json({ error: 'Failed to remove avatar' }, { status: 500 });
		}

		return json({ success: true });
	} catch (error) {
		console.error('Failed to remove avatar:', error);
		return json({ error: 'Failed to remove avatar' }, { status: 500 });
	}
};
