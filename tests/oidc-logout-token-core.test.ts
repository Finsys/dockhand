import { describe, test, expect, beforeAll } from 'bun:test';
import { SignJWT, generateKeyPair, type KeyObject } from 'jose';
import {
	verifyLogoutTokenWithKeys,
	BACKCHANNEL_LOGOUT_EVENT
} from '../src/lib/server/oidc-logout-token-core';

const ISSUER = 'https://idp.example.com/realms/dockhand';
const CLIENT_ID = 'dockhand';

let privateKey: KeyObject;
let publicKey: KeyObject;
let foreignPrivate: KeyObject; // a different signer, for the bad-signature case

beforeAll(async () => {
	const pair = await generateKeyPair('RS256');
	privateKey = pair.privateKey as KeyObject;
	publicKey = pair.publicKey as KeyObject;
	const foreign = await generateKeyPair('RS256');
	foreignPrivate = foreign.privateKey as KeyObject;
});

/** Mint a logout_token; overrides let each test bend exactly one rule. */
async function mint(
	claims: Record<string, unknown>,
	opts: { signer?: KeyObject; omitIat?: boolean } = {}
): Promise<string> {
	let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256' });
	if (!opts.omitIat) jwt = jwt.setIssuedAt();
	return jwt.sign(opts.signer ?? privateKey);
}

/** A well-formed logout_token's claim set; tests delete/override individual members. */
function goodClaims(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		iss: ISSUER,
		aud: CLIENT_ID,
		sub: 'user-123',
		sid: 'session-abc',
		jti: 'jti-1',
		events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
		...extra
	};
}

const expected = { issuer: ISSUER, clientId: CLIENT_ID };

describe('verifyLogoutTokenWithKeys - positive cases', () => {
	test('accepts a token with both sub and sid, returning them plus jti', async () => {
		const token = await mint(goodClaims());
		const result = await verifyLogoutTokenWithKeys(token, publicKey, expected);
		expect(result.sub).toBe('user-123');
		expect(result.sid).toBe('session-abc');
		expect(result.jti).toBe('jti-1');
	});

	test('accepts a multi-audience token that names us as the authorised party (azp)', async () => {
		// Several audiences but azp authorises us: the normal shape from Azure AD/Keycloak
		// with linked resource scopes, and it must still be accepted.
		const token = await mint(goodClaims({ aud: [CLIENT_ID, 'other-client'], azp: CLIENT_ID }));
		const result = await verifyLogoutTokenWithKeys(token, publicKey, expected);
		expect(result.sub).toBe('user-123');
	});

	test('accepts a sid-only token (no sub)', async () => {
		const { sub, ...claims } = goodClaims();
		void sub;
		const result = await verifyLogoutTokenWithKeys(await mint(claims), publicKey, expected);
		expect(result.sid).toBe('session-abc');
		expect(result.sub).toBeUndefined();
	});

	test('accepts a sub-only token (no sid)', async () => {
		const { sid, ...claims } = goodClaims();
		void sid;
		const result = await verifyLogoutTokenWithKeys(await mint(claims), publicKey, expected);
		expect(result.sub).toBe('user-123');
		expect(result.sid).toBeUndefined();
	});
});

describe('verifyLogoutTokenWithKeys - negative cases (each bends exactly one rule)', () => {
	test('rejects a token with no events claim', async () => {
		const { events, ...claims } = goodClaims();
		void events;
		await expect(verifyLogoutTokenWithKeys(await mint(claims), publicKey, expected)).rejects.toThrow(/events/);
	});

	test('rejects an events claim that does not name a back-channel logout', async () => {
		const token = await mint(goodClaims({ events: { 'http://schemas.openid.net/event/other': {} } }));
		await expect(verifyLogoutTokenWithKeys(token, publicKey, expected)).rejects.toThrow(/back-channel logout/);
	});

	test('rejects a token carrying a nonce (an id_token replayed as a logout)', async () => {
		const token = await mint(goodClaims({ nonce: 'n-0S6_WzA2Mj' }));
		await expect(verifyLogoutTokenWithKeys(token, publicKey, expected)).rejects.toThrow(/nonce/);
	});

	test('rejects a token with neither sub nor sid', async () => {
		const { sub, sid, ...claims } = goodClaims();
		void sub;
		void sid;
		await expect(verifyLogoutTokenWithKeys(await mint(claims), publicKey, expected)).rejects.toThrow(/neither a subject nor a session/);
	});

	test('rejects a token addressed to a different audience', async () => {
		const token = await mint(goodClaims({ aud: 'some-other-client' }));
		await expect(verifyLogoutTokenWithKeys(token, publicKey, expected)).rejects.toThrow(/different application/);
	});

	test('rejects a multi-audience token authorised for a different party (azp names someone else)', async () => {
		// aud lists us among several, but azp authorises a sibling client. Membership in aud
		// is not authorisation, so ending our sessions on this token must be refused.
		const token = await mint(goodClaims({ aud: [CLIENT_ID, 'other-client'], azp: 'other-client' }));
		await expect(verifyLogoutTokenWithKeys(token, publicKey, expected)).rejects.toThrow(/several applications/);
	});

	test('rejects a multi-audience token with no azp at all', async () => {
		// Several audiences and nothing naming the authorised party: cannot assume it is us.
		const token = await mint(goodClaims({ aud: [CLIENT_ID, 'other-client'] }));
		await expect(verifyLogoutTokenWithKeys(token, publicKey, expected)).rejects.toThrow(/several applications/);
	});

	test('rejects a token from a different issuer', async () => {
		const token = await mint(goodClaims({ iss: 'https://evil.example.com/realms/x' }));
		await expect(verifyLogoutTokenWithKeys(token, publicKey, expected)).rejects.toThrow(/different issuer/);
	});

	test('rejects a token signed by a key the provider does not publish', async () => {
		const token = await mint(goodClaims(), { signer: foreignPrivate });
		await expect(verifyLogoutTokenWithKeys(token, publicKey, expected)).rejects.toThrow(/signature/);
	});

	test('rejects a token with no iat', async () => {
		const token = await mint(goodClaims(), { omitIat: true });
		await expect(verifyLogoutTokenWithKeys(token, publicKey, expected)).rejects.toThrow(/issued-at/);
	});
});
