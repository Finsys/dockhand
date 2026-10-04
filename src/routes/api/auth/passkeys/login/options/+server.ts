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

/**
 * @openapi
 * summary: Begin signing in with a passkey
 * description: Returns the WebAuthn request options and a ceremony id to send back to the verify endpoint. Reachable without a session, since it runs before sign-in. The ceremony is single-use and expires after five minutes.
 * resp-200-desc: Request options and the ceremony id
 * resp-400: Authentication is not enabled
 * resp-403: Request origin does not match the configured ORIGIN
 * resp-503: Passkeys are not configured (ORIGIN missing or not HTTPS)
 */
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
