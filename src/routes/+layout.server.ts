import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { isAuthEnabled, validateSession } from '$lib/server/auth';
import { hasAdminUser } from '$lib/server/db';
import { BACKUPS_ENABLED } from '$lib/server/features';

// Routes that don't require authentication
const PUBLIC_PATHS = ['/login'];

export const load: LayoutServerLoad = async ({ cookies, url }) => {
	const authEnabled = await isAuthEnabled();

	// Runtime flag to suppress the "What's New" modal (#1235). Read here (not via
	// a build-time define) so it can be toggled by an env var at `docker run`.
	const disableWhatsNew = process.env.DISABLE_WHATS_NEW === 'true';

	// If auth is disabled, allow everything
	if (!authEnabled) {
		return {
			authEnabled: false,
			user: null,
			disableWhatsNew,
			backupsEnabled: BACKUPS_ENABLED
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
				setupMode: true,
				disableWhatsNew,
				backupsEnabled: BACKUPS_ENABLED
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
		} : null,
		disableWhatsNew,
		backupsEnabled: BACKUPS_ENABLED
	};
};
