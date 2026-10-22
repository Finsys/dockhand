/**
 * The decisions a completed OIDC login makes, in one place.
 *
 * Verifying a token and reading claims are each covered by their own module, but what
 * the callback DOES with those answers is where a sign-in is actually granted or
 * refused. Keeping those steps here, away from the fetches and the database, means a
 * test can prove the answers are acted on rather than merely computed - a check that
 * is called and then ignored would otherwise look exactly like a check that works.
 */

import { mergeUserinfo, type Claims, type MergeResult } from './oidc-claims-core';

/** Either the sign-in continues with these claims, or it stops with a reason. */
export type CallbackStep =
	| { proceed: true; claims: Claims; warn?: string }
	| { proceed: false; error: string };

/**
 * Why a token exchange failed, in words the person fixing it can act on.
 *
 * A mistyped secret or an unregistered redirect URI is the first thing a new setup
 * gets wrong, and the provider names which in its OAuth error - so its words travel
 * rather than a bare "the exchange failed".
 */
export function describeTokenExchangeFailure(status: number, body: string): string {
	let code: unknown;
	let description: unknown;
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		code = parsed.error;
		description = parsed.error_description;
	} catch {
		// Not JSON - some providers answer HTML or a bare string.
	}

	const oneLine = (v: unknown) => {
		if (typeof v !== 'string' || !v.trim()) return null;
		const flat = v.trim().replace(/\s+/g, ' ');
		// Cut by code POINT, not code unit: half of a surrogate pair is not a character,
		// and this string is handed to encodeURIComponent on its way into a redirect,
		// which throws URIError on a lone surrogate.
		return [...flat].slice(0, 200).join('');
	};

	// The status decides the verb, not the body: a 5xx is the provider or something in
	// front of it failing rather than a decision about this sign-in, and calling that a
	// refusal sends whoever reads it to check the client secret when the thing to check
	// is whether the provider is up.
	const lead =
		status >= 500
			? 'The provider could not be reached to exchange the authorization code'
			: 'The provider refused the authorization code';

	const detail = oneLine(description) ?? oneLine(code);
	return detail ? `${lead}: ${detail}` : `${lead} (HTTP ${status})`;
}

/**
 * A provider's error body, made safe to log.
 *
 * The request is posted with the client secret and the authorization code in it, and a
 * provider that echoes what it received puts both in its reply. Bounded too, so one
 * failure cannot pour a page of HTML into the log.
 */
export function redactTokenErrorBody(body: string, limit = 500): string {
	if (!body) return '(empty)';
	// Bound FIRST. The body is whatever a remote service sent, and running a pattern
	// over a megabyte of it is work an outsider gets to ask for.
	const bounded = body.length > limit ? `${body.slice(0, limit)}... (truncated)` : body;
	// The name is matched with the separator optional and a bounded prefix allowed, so
	// a provider that renames the field (oauth_client_secret, clientSecret) does not
	// slip past; the quote may be escaped, because some answer with the request
	// embedded as a JSON string.
	// The value runs to the delimiter of whichever encoding carried it - a quote for
	// JSON, an ampersand for a form - so a secret holding a space or a comma is masked
	// whole rather than to its first odd character.
	return bounded.replace(
		/((?:\\?")?[a-z0-9]{0,12}_?(?:client_?secret|refresh_?token|access_?token|id_?token|assertion|\bcode)(?:\\?")?\s*[=:]\s*)(\\?"[^"\\]*\\?"|[^&\s]+)/gi,
		'$1<redacted>'
	);
}

/** A token response is only usable when it actually carries an id_token. */
export function requireIdToken(tokens: { id_token?: string } | null | undefined): CallbackStep {
	if (!tokens?.id_token) {
		return {
			proceed: false,
			error: 'The provider returned no ID token, so the sign-in could not be verified'
		};
	}
	return { proceed: true, claims: {} };
}

/** How a rejected token is reported: the reason travels, so support can act on it. */
export function rejectedToken(reason: unknown): CallbackStep {
	const message = reason instanceof Error ? reason.message : String(reason);
	return { proceed: false, error: `Sign-in rejected: ${message}` };
}

/**
 * What to do with a userinfo response, given the claims already verified.
 *
 * A response describing a different person stops the sign-in: its values override the
 * token's and the admin claim is read afterwards, so merging one would be a way in.
 */
export function applyUserinfo(
	verified: Claims,
	userinfo: Claims | null | undefined,
	providerName: string
): CallbackStep {
	const merged: MergeResult = mergeUserinfo(verified, userinfo);

	if (!merged.ok) {
		return {
			proceed: false,
			error: 'Sign-in rejected: the provider described a different account'
		};
	}

	if (merged.ignored === 'no-subject') {
		return {
			proceed: true,
			claims: merged.claims,
			warn: `[OIDC] ${providerName} returned userinfo naming no subject; continuing on the token claims`
		};
	}

	return { proceed: true, claims: merged.claims };
}
