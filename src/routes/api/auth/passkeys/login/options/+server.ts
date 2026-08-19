import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { isAuthEnabled } from '$lib/server/auth';
import {
	getWebAuthnConfig,
	hasExactWebAuthnOrigin,
	webAuthnChallenges
} from '$lib/server/webauthn';

const NO_STORE = { 'Cache-Control': 'no-store' };

export const POST: RequestHandler = async ({ request }) => {
	if (!(await isAuthEnabled())) return json({ error: 'Authentication is not enabled' }, { status: 400, headers: NO_STORE });

	let config;
	try {
		config = getWebAuthnConfig();
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Passkeys are not configured' }, { status: 503, headers: NO_STORE });
	}
	if (!hasExactWebAuthnOrigin(request)) return json({ error: 'Invalid request origin' }, { status: 403, headers: NO_STORE });

	const options = await generateAuthenticationOptions({
		rpID: config.rpId,
		userVerification: 'required'
	});
	try {
		const ceremony = webAuthnChallenges.issue(options.challenge, 'authentication');
		return json({ ceremonyId: ceremony.id, options }, { headers: NO_STORE });
	} catch {
		return json({ error: 'Too many pending Passkey requests; try again shortly' }, { status: 503, headers: NO_STORE });
	}
};
