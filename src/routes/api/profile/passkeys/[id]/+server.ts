import { json } from '@sveltejs/kit';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { deletePasskeyCredentialForUser } from '$lib/server/db';
import { isAuthEnabled, validateSession } from '$lib/server/auth';
import type { AuthenticatedUser } from '$lib/server/auth';
import { getWebAuthnConfig, hasExactWebAuthnOrigin } from '$lib/server/webauthn';

const NO_STORE = { 'Cache-Control': 'no-store' };

type PasskeyAuthorization = { user: AuthenticatedUser; error?: never } | { user?: never; error: Response };

async function authorize(request: Request, cookies: Cookies): Promise<PasskeyAuthorization> {
	if (!(await isAuthEnabled())) return { error: json({ error: 'Authentication is not enabled' }, { status: 400, headers: NO_STORE }) };
	try {
		getWebAuthnConfig();
	} catch (error) {
		return { error: json({ error: error instanceof Error ? error.message : 'Passkeys are not configured' }, { status: 503, headers: NO_STORE }) };
	}
	if (!hasExactWebAuthnOrigin(request)) return { error: json({ error: 'Invalid request origin' }, { status: 403, headers: NO_STORE }) };
	const user = await validateSession(cookies);
	if (!user) return { error: json({ error: 'Not authenticated' }, { status: 401, headers: NO_STORE }) };
	return { user };
}

export const DELETE: RequestHandler = async ({ request, cookies, params }) => {
	const auth = await authorize(request, cookies);
	if (auth.error) return auth.error;
	const id = Number(params.id);
	if (!Number.isSafeInteger(id) || id < 1) return json({ error: 'Invalid Passkey ID' }, { status: 400, headers: NO_STORE });

	const deleted = await deletePasskeyCredentialForUser(id, auth.user.id);
	if (!deleted) return json({ error: 'Passkey not found' }, { status: 404, headers: NO_STORE });
	return json({ success: true }, { headers: NO_STORE });
};
