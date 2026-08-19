import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import {
	getPasskeyCredentialByNameForUser,
	getPasskeyCredentialsForUser
} from '$lib/server/db';
import { isAuthEnabled, SESSION_COOKIE, validateSession } from '$lib/server/auth';
import {
	decodeWebAuthnBytes,
	getWebAuthnConfig,
	hasExactWebAuthnOrigin,
	newWebAuthnUserHandle,
	webAuthnChallenges,
	WEBAUTHN_RP_NAME
} from '$lib/server/webauthn';

const NO_STORE = { 'Cache-Control': 'no-store' };

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!(await isAuthEnabled())) return json({ error: 'Authentication is not enabled' }, { status: 400, headers: NO_STORE });

	let config;
	try {
		config = getWebAuthnConfig();
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Passkeys are not configured' }, { status: 503, headers: NO_STORE });
	}
	if (!hasExactWebAuthnOrigin(request)) return json({ error: 'Invalid request origin' }, { status: 403, headers: NO_STORE });

	const user = await validateSession(cookies);
	const sessionId = cookies.get(SESSION_COOKIE);
	if (!user || !sessionId) return json({ error: 'Not authenticated' }, { status: 401, headers: NO_STORE });

	let name = '';
	try {
		const body = await request.json();
		name = typeof body?.name === 'string' ? body.name.trim() : '';
	} catch {
		return json({ error: 'Enter a Passkey name' }, { status: 400, headers: NO_STORE });
	}
	if (!name) return json({ error: 'Enter a Passkey name' }, { status: 400, headers: NO_STORE });
	if (name.length > 64) return json({ error: 'Passkey name must be 64 characters or fewer' }, { status: 400, headers: NO_STORE });
	if (await getPasskeyCredentialByNameForUser(user.id, name)) {
		return json({ error: 'A Passkey with this name already exists' }, { status: 409, headers: NO_STORE });
	}

	const credentials = await getPasskeyCredentialsForUser(user.id);
	const userHandle = credentials[0]?.webauthnUserId || newWebAuthnUserHandle();
	const options = await generateRegistrationOptions({
		rpName: WEBAUTHN_RP_NAME,
		rpID: config.rpId,
		userID: decodeWebAuthnBytes(userHandle),
		userName: user.username,
		userDisplayName: user.displayName || user.username,
		attestationType: 'none',
		excludeCredentials: credentials.map((credential) => ({
			id: credential.credentialId,
			transports: credential.transports ? JSON.parse(credential.transports) : undefined
		})),
		authenticatorSelection: {
			residentKey: 'required',
			userVerification: 'required'
		}
	});

	try {
		const ceremony = webAuthnChallenges.issue(options.challenge, 'registration', {
			userId: user.id,
			sessionId,
			userHandle,
			passkeyName: name
		});
		return json({ ceremonyId: ceremony.id, options }, { headers: NO_STORE });
	} catch {
		return json({ error: 'Too many pending Passkey requests; try again shortly' }, { status: 503, headers: NO_STORE });
	}
};
