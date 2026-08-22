import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { getPasskeyCredentialsForUser } from '$lib/server/db';
import { isAuthEnabled, validateSession } from '$lib/server/auth';

const NO_STORE = { 'Cache-Control': 'no-store' };

export const GET: RequestHandler = async ({ cookies }) => {
	if (!(await isAuthEnabled())) return json({ error: 'Authentication is not enabled' }, { status: 400, headers: NO_STORE });
	const user = await validateSession(cookies);
	if (!user) return json({ error: 'Not authenticated' }, { status: 401, headers: NO_STORE });

	const credentials = await getPasskeyCredentialsForUser(user.id);
	return json({
		passkeys: credentials.map((credential) => ({
			id: credential.id,
			name: credential.name,
			deviceType: credential.deviceType,
			backedUp: credential.backedUp,
			createdAt: credential.createdAt
		}))
	}, { headers: NO_STORE });
};
