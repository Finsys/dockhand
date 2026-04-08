import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { isAuthEnabled, validateSession } from '$lib/server/auth';
import { hasAdminUser } from '$lib/server/db';

// Routes that don't require authentication
const PUBLIC_PATHS = ['/login', '/api/docs'];

export const load: LayoutServerLoad = async ({ cookies, url }) => {
	const authEnabled = await isAuthEnabled();

	// If auth is disabled, allow everything
	if (!authEnabled) {
		return {
			authEnabled: false,
			user: null
		};
	}

	// Auth is enabled - validate session
	const user = await validateSession(cookies);

	// Check if this is a public path
	const isPublicPath = PUBLIC_PATHS.some(path => url.pathname === path || url.pathname.startsWith(path + '/'));

	// If not authenticated and not on a public path
	if (!user && !isPublicPath) {
		// Special case: allow access when no admin exists yet (initial setup)
		const noAdminSetupMode = !(await hasAdminUser());
		if (noAdminSetupMode) {
			return {
				authEnabled: true,
				user: null,
				setupMode: true
			};
		}

		// Redirect to login
		const redirectUrl = encodeURIComponent(url.pathname + url.search);
		redirect(307, `/login?redirect=${redirectUrl}`);
	}

	return {
		authEnabled: true,
		user: user ? {
			id: user.id,
			username: user.username,
			email: user.email,
			displayName: user.displayName,
			avatar: user.avatar,
			isAdmin: user.isAdmin,
			provider: user.provider
		} : null
	};
};
