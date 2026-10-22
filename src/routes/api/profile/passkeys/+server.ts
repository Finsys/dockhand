import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { getPasskeyCredentialsForUser, getPasskeysEnabled } from '$lib/server/db';
import { isAuthEnabled, validateSession } from '$lib/server/auth';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * @openapi
 * summary: List the signed-in user's passkeys
 * description: Names and metadata only; no credential material is returned. `enabled` reports whether this instance currently offers passkeys, so the profile can hide the controls without a second request; existing passkeys are still listed when it is false.
 * resp-200-desc: The user's registered passkeys
 * resp-400: Authentication is not enabled
 * resp-401: Not authenticated
 */
export const GET: RequestHandler = async ({ cookies }) => {
	if (!(await isAuthEnabled())) return json({ error: 'Authentication is not enabled' }, { status: 400, headers: NO_STORE });
	const user = await validateSession(cookies);
	if (!user) return json({ error: 'Not authenticated' }, { status: 401, headers: NO_STORE });

	const [credentials, enabled] = await Promise.all([
		getPasskeyCredentialsForUser(user.id),
		getPasskeysEnabled()
	]);
	return json({
		enabled,
		passkeys: credentials.map((credential) => ({
			id: credential.id,
			name: credential.name,
			deviceType: credential.deviceType,
			backedUp: credential.backedUp,
			createdAt: credential.createdAt
		}))
	}, { headers: NO_STORE });
};
