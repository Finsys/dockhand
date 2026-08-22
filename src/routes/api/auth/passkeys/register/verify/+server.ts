import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { verifyRegistrationResponse, type RegistrationResponseJSON } from '@simplewebauthn/server';
import {
	createPasskeyCredential,
	getPasskeyCredentialByCredentialId,
	getPasskeyCredentialByNameForUser,
	getPasskeyCredentialsForUser
} from '$lib/server/db';
import { isAuthEnabled, SESSION_COOKIE, validateSession } from '$lib/server/auth';
import {
	encodeWebAuthnBytes,
	getWebAuthnConfig,
	hasExactWebAuthnOrigin,
	webAuthnChallenges
} from '$lib/server/webauthn';

const NO_STORE = { 'Cache-Control': 'no-store' };

function uniqueConstraint(error: unknown): 'name' | 'credential' | null {
	if (typeof error !== 'object' || error === null) return null;
	const candidate = error as { code?: string; constraint?: string; message?: string };
	const detail = `${candidate.constraint || ''} ${candidate.message || ''}`;
	const isUnique = candidate.code === '23505'
		|| candidate.code === 'SQLITE_CONSTRAINT_UNIQUE'
		|| /unique constraint/i.test(detail);
	if (!isUnique) return null;
	return /passkey_credentials_user_name_unique/i.test(detail) ? 'name' : 'credential';
}

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

	let body: { ceremonyId?: string; response?: RegistrationResponseJSON };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE });
	}

	if (!body.ceremonyId || !body.response) return json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE });
	const ceremony = webAuthnChallenges.consume(body.ceremonyId, 'registration', { userId: user.id, sessionId });
	if (!ceremony?.userHandle || !ceremony.passkeyName) {
		return json({ error: 'Passkey ceremony expired or is invalid' }, { status: 400, headers: NO_STORE });
	}
	if (await getPasskeyCredentialByNameForUser(user.id, ceremony.passkeyName)) {
		return json({ error: 'A Passkey with this name already exists' }, { status: 409, headers: NO_STORE });
	}

	try {
		const verification = await verifyRegistrationResponse({
			response: body.response,
			expectedChallenge: ceremony.challenge,
			expectedOrigin: config.expectedOrigin,
			expectedRPID: config.rpId,
			requireUserVerification: true
		});
		if (!verification.verified || !verification.registrationInfo) {
			return json({ error: 'Passkey registration could not be verified' }, { status: 400, headers: NO_STORE });
		}

		const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
		if (await getPasskeyCredentialByCredentialId(credential.id)) {
			return json({ error: 'This Passkey is already registered' }, { status: 409, headers: NO_STORE });
		}

		const existingCredentials = await getPasskeyCredentialsForUser(user.id);
		if (existingCredentials.some((item) => item.webauthnUserId !== ceremony.userHandle)) {
			return json({ error: 'Passkey user handle mismatch' }, { status: 400, headers: NO_STORE });
		}

		const saved = await createPasskeyCredential({
			userId: user.id,
			credentialId: credential.id,
			webauthnUserId: ceremony.userHandle,
			publicKey: encodeWebAuthnBytes(credential.publicKey),
			counter: credential.counter,
			deviceType: credentialDeviceType,
			backedUp: credentialBackedUp,
			transports: credential.transports ? JSON.stringify(credential.transports) : null,
			name: ceremony.passkeyName
		});

		return json({
			success: true,
			passkey: {
				id: saved.id,
				name: saved.name,
				deviceType: saved.deviceType,
				backedUp: saved.backedUp,
				createdAt: saved.createdAt
			}
		}, { headers: NO_STORE });
	} catch (error) {
		const constraint = uniqueConstraint(error);
		if (constraint === 'name') {
			return json({ error: 'A Passkey with this name already exists' }, { status: 409, headers: NO_STORE });
		}
		if (constraint === 'credential') {
			return json({ error: 'This Passkey is already registered' }, { status: 409, headers: NO_STORE });
		}
		return json({ error: 'Passkey registration could not be verified' }, { status: 400, headers: NO_STORE });
	}
};
