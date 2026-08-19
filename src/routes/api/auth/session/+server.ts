import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { validateSession, isAuthEnabled } from '$lib/server/auth';
import { getAuthSettings } from '$lib/server/db';

/**
 * @openapi
 * summary: Get the current session (public — used by the frontend to bootstrap auth state)
 * resp-200: {authenticated:boolean!, authEnabled:boolean!, user:{id:integer, username:string, email:string, displayName:string, avatar:string, isAdmin:boolean, provider:string}}
 * resp-200-desc: user is present only when authenticated:true
 * resp-200-example: {"authenticated":true,"authEnabled":true,"user":{"id":1,"username":"admin","email":"admin@example.com","displayName":"Admin","avatar":null,"isAdmin":true,"provider":"local"}}
 * resp-500: Unexpected error while validating the session
 */
export const GET: RequestHandler = async ({ cookies }) => {
	try {
		const authEnabled = await isAuthEnabled();

		if (!authEnabled) {
			// Auth is disabled, return anonymous session
			return json({
				authenticated: false,
				authEnabled: false
			});
		}

		const user = await validateSession(cookies);

		if (!user) {
			return json({
				authenticated: false,
				authEnabled: true
			});
		}

		return json({
			authenticated: true,
			authEnabled: true,
			user: {
				id: user.id,
				username: user.username,
				email: user.email,
				displayName: user.displayName,
				avatar: user.avatar,
				isAdmin: user.isAdmin,
				provider: user.provider,
				permissions: user.permissions
			}
		});
	} catch (error) {
		console.error('Session check error:', error);
		return json({ error: 'Failed to check session' }, { status: 500 });
	}
};
