/**
 * Proving that an id_token really came from the configured provider.
 *
 * Claims decide who somebody is and whether they administer this instance, so nothing
 * is read out of a token until it is proven to come from the configured provider. Kept
 * apart from the rest of the OIDC flow so a test can call the real thing: the only I/O
 * is fetching the provider's signing keys, and that arrives as an argument.
 */

import { jwtVerify, type JWTVerifyGetKey, type KeyObject } from 'jose';
import type { Claims } from './oidc-claims-core';

/**
 * How far the clocks either side of a login may drift before it fails.
 *
 * Two hosts that disagree by a few seconds is ordinary; refusing those logins would
 * make Dockhand look broken for a reason nobody would guess from the outside. The
 * allowance covers both directions - a token that just expired, and one issued a
 * moment in the future by a provider running ahead - and is small against the
 * several minutes an id_token is valid for, so it does not meaningfully widen the
 * window in which a stolen token can be replayed. Matches the openid-client default.
 */
export const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Signing algorithms an id_token may use.
 *
 * Every asymmetric algorithm the JOSE registry defines, so no conforming provider is
 * turned away - what the list excludes is the symmetric family (HS*) and `none`,
 * where the verifying key is either public or absent.
 */
export const DEFAULT_ID_TOKEN_ALGORITHMS = [
	'RS256', 'RS384', 'RS512',
	'PS256', 'PS384', 'PS512',
	'ES256', 'ES256K', 'ES384', 'ES512',
	'EdDSA', 'Ed25519'
];

export interface IdTokenExpectations {
	/** The issuer the provider names in its own discovery document. */
	issuer: string;
	/** This deployment's client id, which the token must be addressed to. */
	clientId: string;
	/** The nonce this login sent, tying the token to this request. */
	nonce: string;
}

/**
 * The claims of an id_token, once it has been proven to come from the provider.
 *
 * Throws with a reason a person can act on. Each failure is a different
 * misconfiguration - a provider whose issuer does not match its own discovery
 * document is a different problem from a clock that has drifted - and saying which is
 * the difference between a support thread and a five-minute fix.
 */
export async function verifyIdTokenWithKeys(
	idToken: string,
	keys: JWTVerifyGetKey | KeyObject | CryptoKey | Uint8Array,
	expected: IdTokenExpectations
): Promise<Claims> {
	let payload: Claims;
	try {
		const result = await jwtVerify(idToken, keys as JWTVerifyGetKey, {
			issuer: expected.issuer,
			audience: expected.clientId,
			clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
			// Both are REQUIRED of an id_token by OIDC Core, and jose only checks a
			// claim that is present. Without exp a captured token never expires;
			// without sub the token names nobody, and the userinfo response - a weaker
			// source - is left free to say who this is and what they may do.
			requiredClaims: ['exp', 'sub'],
			// Asymmetric only. A symmetric algorithm would let a token be signed with
			// the provider's PUBLIC key, which anybody can fetch. The key resolver
			// happens to refuse those too, but that is its property, not this one's,
			// and it would go away with a different key source.
			algorithms: DEFAULT_ID_TOKEN_ALGORITHMS
		});
		payload = result.payload as Claims;
	} catch (error) {
		throw new Error(describeVerifyFailure(error));
	}

	// A token may name several applications. Membership alone does not say it was
	// meant for this one, so the provider has to name the party it authorized.
	const audiences = payload.aud;
	if (Array.isArray(audiences) && audiences.length > 1 && payload.azp !== expected.clientId) {
		throw new Error('the ID token names several applications and was not authorised for this one');
	}

	// Required, not checked-if-present: a token without a nonce cannot be tied to the
	// request that started this login, which is the whole point of sending one.
	if (payload.nonce !== expected.nonce) {
		throw new Error('the ID token does not belong to this sign-in request');
	}

	return payload;
}

/** The human half of a verification failure, kept apart so it can be tested alone. */
export function describeVerifyFailure(error: unknown): string {
	const code = (error as { code?: string })?.code;
	switch (code) {
		case 'ERR_JWT_EXPIRED':
			return `the ID token has expired by more than ${ID_TOKEN_CLOCK_TOLERANCE_SECONDS}s (check the clock on this host and on the provider)`;
		case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
			const claim = (error as { claim?: string })?.claim;
			if (claim === 'iss') return 'the ID token came from a different issuer than configured';
			if (claim === 'aud') return 'the ID token was issued for a different application';
			if (claim === 'exp') return 'the ID token carries no expiry, which OIDC requires';
			if (claim === 'sub') return 'the ID token names no subject, which OIDC requires';
			return `the ID token failed its ${claim ?? 'claim'} check`;
		}
		case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
			return 'the ID token signature does not match the provider signing keys';
		case 'ERR_JWKS_NO_MATCHING_KEY':
			return 'the ID token was signed with a key the provider does not publish';
		case 'ERR_JOSE_ALG_NOT_ALLOWED':
		case 'ERR_JOSE_NOT_SUPPORTED':
			return 'the ID token uses a signing algorithm the provider keys do not allow';
		default:
			return `the ID token could not be verified (${error instanceof Error ? error.message : String(error)})`;
	}
}
