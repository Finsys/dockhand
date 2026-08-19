import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
	getPasskeyCredentialByCredentialId,
	getUser,
	updatePasskeyCounter
} from '$lib/server/db';
import { createUserSession, isAuthEnabled } from '$lib/server/auth';
import { auditAuth } from '$lib/server/audit';
import {
	decodeWebAuthnBytes,
	getWebAuthnConfig,
	hasExactWebAuthnOrigin,
	webAuthnChallenges
} from '$lib/server/webauthn';

const NO_STORE = { 'Cache-Control': 'no-store' };

export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	if (!(await isAuthEnabled())) return json({ error: 'Authentication is not enabled' }, { status: 400, headers: NO_STORE });

	let config;
	try {
		config = getWebAuthnConfig();
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Passkeys are not configured' }, { status: 503, headers: NO_STORE });
	}
	if (!hasExactWebAuthnOrigin(request)) return json({ error: 'Invalid request origin' }, { status: 403, headers: NO_STORE });

	let body: { ceremonyId?: string; response?: AuthenticationResponseJSON };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE });
	}
	if (!body.ceremonyId || !body.response) return json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE });

	const ceremony = webAuthnChallenges.consume(body.ceremonyId, 'authentication');
	if (!ceremony) return json({ error: 'Passkey ceremony expired or is invalid' }, { status: 400, headers: NO_STORE });

	try {
		const credential = await getPasskeyCredentialByCredentialId(body.response.id);
		if (!credential) return json({ error: 'Passkey authentication failed' }, { status: 401, headers: NO_STORE });

		const user = await getUser(credential.userId);
		if (!user?.isActive) return json({ error: 'Passkey authentication failed' }, { status: 401, headers: NO_STORE });

		const responseUserHandle = body.response.response.userHandle;
		if (!responseUserHandle || responseUserHandle !== credential.webauthnUserId) {
			return json({ error: 'Passkey authentication failed' }, { status: 401, headers: NO_STORE });
		}

		const verification = await verifyAuthenticationResponse({
			response: body.response,
			expectedChallenge: ceremony.challenge,
			expectedOrigin: config.expectedOrigin,
			expectedRPID: config.rpId,
			credential: {
				id: credential.credentialId,
				publicKey: decodeWebAuthnBytes(credential.publicKey),
				counter: credential.counter,
				transports: credential.transports ? JSON.parse(credential.transports) : undefined
			},
			requireUserVerification: true
		});
		if (!verification.verified) return json({ error: 'Passkey authentication failed' }, { status: 401, headers: NO_STORE });

		const counterUpdated = await updatePasskeyCounter(
			credential.id,
			credential.counter,
			verification.authenticationInfo.newCounter
		);
		if (!counterUpdated) return json({ error: 'Passkey authentication failed' }, { status: 401, headers: NO_STORE });

		// A verified Passkey is the complete interactive authentication factor. It
		// deliberately enters the existing session path without a separate TOTP step.
		await createUserSession(user.id, 'passkey', cookies, request);
		await auditAuth(event, 'login', user.username, { provider: 'passkey' });

		return json({ success: true }, { headers: NO_STORE });
	} catch {
		return json({ error: 'Passkey authentication failed' }, { status: 401, headers: NO_STORE });
	}
};
