import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { decodeJwt } from 'jose';
import { getOidcVerificationContexts, isRateLimited, recordFailedAttempt, clearRateLimit } from '$lib/server/auth';
import { verifyLogoutTokenWithKeys } from '$lib/server/oidc-logout-token-core';
import { JtiReplayGuard } from '$lib/server/oidc-logout-jti-core';
import { deleteSessionsByOidcSid, deleteSessionsByOidcSub } from '$lib/server/db';
import { invalidateTokenCacheForUser } from '$lib/server/token-cache';
import { getClientIp } from '$lib/server/client-ip';
import { auditAuth } from '$lib/server/audit';

// Per-process replay guard. Dedupe is a safety net, not correctness: a replayed logout
// is idempotent (it deletes sessions already gone), so a per-replica guard is enough.
const jtiGuard = new JtiReplayGuard();

// POST /api/auth/oidc/backchannel-logout - IdP-initiated OIDC Back-Channel Logout receiver
/**
 * @openapi
 * summary: Receive an OIDC Back-Channel Logout token from the identity provider and end the matching server-side session(s). Called by the IdP, not by browser clients. Public (its auth is the signed logout_token itself).
 * body: {logout_token:string!} The signed OIDC back-channel logout token (form-encoded)
 * resp-200: Logout accepted (idempotent; ends the session(s) the token names, no body)
 * resp-400: The logout_token was missing, malformed, from an unknown issuer, or failed verification
 * resp-429: Too many failed verification attempts from this client
 * resp-500: The session deletion failed; the IdP should retry
 */
export const POST: RequestHandler = async (event) => {
	const { request } = event;

	// The endpoint is public, so an attacker who only has a syntactically valid JWT can
	// still drive the per-request DB read + secret decrypt in the verification context.
	// Rate-limit by client IP, clearing on a genuinely verified token, so a real IdP
	// (which always sends valid tokens) is never throttled.
	const clientIp = getClientIp(event);
	const rateLimitKey = `backchannel-logout:${clientIp}`;
	const { limited, retryAfter } = isRateLimited(rateLimitKey);
	if (limited) {
		return json(
			{ error: 'too many logout attempts' },
			{ status: 429, headers: { 'Cache-Control': 'no-store', ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) } }
		);
	}

	// 400 with a no-store header; the IdP is the only caller and nothing here is cacheable.
	// Log the rejection: a silent 400 is indistinguishable from a POST that never arrived,
	// which makes a misconfigured IdP logout impossible to debug.
	const bad = (reason: string) => {
		recordFailedAttempt(rateLimitKey);
		console.warn(`[Auth] back-channel logout rejected (${clientIp}): ${reason}`);
		return json({ error: reason }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
	};

	const form = await request.formData().catch(() => null);
	const logoutToken = form?.get('logout_token');
	if (typeof logoutToken !== 'string' || logoutToken === '') {
		return bad('missing logout_token');
	}

	// Read the claimed issuer WITHOUT trusting it, only to pick which provider's keys to
	// verify against. The signature check below is what binds the token to that provider.
	let claimedIssuer: string | undefined;
	try {
		const claim = decodeJwt(logoutToken).iss;
		claimedIssuer = typeof claim === 'string' ? claim : undefined;
	} catch {
		return bad('the logout token is not a decodable JWT');
	}
	if (!claimedIssuer) return bad('the logout token names no issuer');

	const contexts = await getOidcVerificationContexts(claimedIssuer);
	if (contexts.length === 0) return bad('the logout token issuer matches no configured provider');

	// Try each provider sharing this issuer. With different client ids only the one the
	// token was addressed to (aud/azp) verifies. When several verify (the same IdP
	// registered more than once: same issuer AND client id), the token belongs to all of
	// them, so the session delete below runs under each - the session may live under any
	// one. The verified claims are the token's own, identical whichever context's keys
	// prove the signature, so verify once and reuse the first result.
	let result;
	const verifiedProviders: string[] = [];
	let lastError: unknown;
	for (const candidate of contexts) {
		try {
			const r = await verifyLogoutTokenWithKeys(logoutToken, candidate.keys, {
				issuer: candidate.issuer,
				clientId: candidate.clientId
			});
			if (!result) result = r;
			verifiedProviders.push(candidate.provider);
		} catch (error) {
			lastError = error;
		}
	}
	if (!result || verifiedProviders.length === 0) {
		return bad(lastError instanceof Error ? lastError.message : 'the logout token could not be verified');
	}

	// The token is verified: a real IdP sent it, so this client is not an attacker.
	clearRateLimit(rateLimitKey);

	// A replay is idempotent, so a seen jti still returns success - the logout it asked
	// for already happened. markSeen reserves the jti atomically; if the deletes below
	// fail it is rolled back (unmark) so the IdP's retry is not deduped away before the
	// logout ever ran.
	if (result.jti && jtiGuard.markSeen(result.jti, Date.now())) {
		return json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
	}

	// A sid names exactly one session (spec), so a sid token ends only that session -
	// even on a zero-row match (the session is already gone, or was never sid-tracked).
	// Only a token with NO sid at all ends the user's whole set for the provider by sub;
	// branching on which claim the token supplied, not on whether a row matched, keeps a
	// single-session logout from silently escalating to a sub-wide one.
	const affected = new Set<number>();
	try {
		for (const provider of verifiedProviders) {
			if (result.sid) {
				for (const id of await deleteSessionsByOidcSid(result.sid, provider)) affected.add(id);
			} else if (result.sub) {
				for (const id of await deleteSessionsByOidcSub(result.sub, provider)) affected.add(id);
			}
		}
	} catch (error) {
		// Release the jti reservation so the IdP's retry performs the logout rather than
		// being treated as an already-seen replay.
		if (result.jti) jtiGuard.unmark(result.jti);
		console.error('[Auth] back-channel logout delete failed:', error instanceof Error ? error.message : error);
		return json({ error: 'logout could not be completed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
	}

	const affectedUserIds = [...affected];
	for (const userId of affectedUserIds) {
		invalidateTokenCacheForUser(userId);
	}

	await auditAuth(event, 'logout', result.sub ?? result.sid ?? 'unknown', {
		provider: verifiedProviders.join(','),
		backchannel: true,
		sessions: affectedUserIds.length
	});

	console.log(`[Auth] back-channel logout accepted: provider=${verifiedProviders.join(',')} by=${result.sid ? 'sid' : 'sub'} sessions=${affectedUserIds.length}`);
	return json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
};
