/**
 * The short-lived state of a login that is away at the identity provider.
 *
 * Between the redirect out and the callback back, Dockhand has to remember four
 * things: which provider was used, the PKCE verifier, the nonce, and where the user
 * was heading. Holding them in process memory loses them whenever the process
 * restarts mid-login, and loses them every time when two containers sit behind the
 * same proxy - the browser can come back to the one that never issued the request
 * (#1601). Carrying them in the browser removes the shared-memory assumption
 * altogether.
 *
 * The cookie is encrypted with the instance key, and a value that is not ciphertext
 * from this instance is refused before anything is read out of it. So the PKCE
 * verifier and nonce it carries are neither readable nor authorable by the browser
 * holding it, which is the whole point of both.
 *
 * Pure: the caller does the cookie I/O and passes the crypto in, so the shape and the
 * expiry rules can be tested without a server or a key.
 */

/** Every login-state cookie starts with this. */
export const OIDC_STATE_COOKIE_PREFIX = 'dockhand_oidc_state_';

/**
 * The cookie name for one login.
 *
 * Named after the login rather than fixed, because two tabs sign in at once more
 * often than it sounds - a second tab opened on a deep link, a bookmark followed
 * while the first is still away at the provider. One shared name means the second
 * authorize overwrites the first, and then BOTH callbacks fail: the first finds a
 * state that does not match, and it has already deleted the cookie the second needed.
 *
 * The name is derived from `state`, which the provider echoes back, so the callback
 * can find its own cookie among several. It is a hash rather than the state itself:
 * cookie names are the one part not covered by the encryption, and the state is worth
 * no more to an onlooker than it has to be.
 *
 * An abandoned login's cookie is left to its own maxAge rather than swept here: the
 * callback is reachable without a session, so clearing anything but its own cookie
 * would let one request end everybody else's sign-in.
 */
export function loginStateCookieName(state: string, hash: (value: string) => string): string {
	return OIDC_STATE_COOKIE_PREFIX + hash(state).slice(0, 16);
}

/**
 * How many unfinished logins one browser may hold at once.
 *
 * Several tabs signing in together is ordinary; dozens is not. Starting a login
 * needs no session, so without a ceiling any page could point a browser at the
 * initiate URL repeatedly and pile up cookies until the request header grew too
 * large for the server to accept - locking the site out of its own login page.
 */
export const MAX_LOGIN_STATE_COOKIES = 5;

/**
 * Which login-state cookies to drop to make room for a new one.
 *
 * Decided ONLY from the cookies the browser sent with this request, so a request can
 * never affect anybody else's sign-in. Oldest first, by the expiry each cookie
 * carries; one that cannot be read at all goes first, since it can never be resumed.
 */
export function loginStateCookiesToEvict(
	cookies: { name: string; expiresAt: number | null }[],
	max: number = MAX_LOGIN_STATE_COOKIES
): string[] {
	const live = cookies.filter((c) => c.name.startsWith(OIDC_STATE_COOKIE_PREFIX));

	// The new cookie takes a slot, so room has to be left for it.
	const excess = live.length - (max - 1);
	if (excess <= 0) return [];

	const oldestFirst = [...live].sort(
		(a, b) => (a.expiresAt ?? -Infinity) - (b.expiresAt ?? -Infinity)
	);
	return oldestFirst.slice(0, excess).map((c) => c.name);
}


/** How long a login may stay away at the provider. */
export const OIDC_STATE_TTL_SECONDS = 600;

export interface OidcLoginState {
	/** Which provider row started this login. */
	configId: number;
	/** The `state` parameter, echoed back by the provider. */
	state: string;
	/** PKCE verifier, proving this callback belongs to this authorize request. */
	codeVerifier: string;
	/** Nonce, tying the returned id_token to this request. */
	nonce: string;
	/** Where the user was going before being sent to the provider. */
	redirectUrl: string;
	/** Epoch ms after which the login is too old to finish. */
	expiresAt: number;
}

/** True when the value has every field a callback needs, with the right types. */
function isLoginState(value: unknown): value is OidcLoginState {
	if (!value || typeof value !== 'object') return false;
	const s = value as Record<string, unknown>;
	return (
		typeof s.configId === 'number' &&
		typeof s.state === 'string' &&
		s.state.length > 0 &&
		typeof s.codeVerifier === 'string' &&
		s.codeVerifier.length > 0 &&
		typeof s.nonce === 'string' &&
		s.nonce.length > 0 &&
		typeof s.redirectUrl === 'string' &&
		typeof s.expiresAt === 'number'
	);
}

/** The cookie value for a login that is about to leave for the provider. */
export function encodeLoginState(
	state: OidcLoginState,
	encrypt: (plaintext: string) => string | null
): string {
	const encoded = encrypt(JSON.stringify(state));
	if (!encoded) throw new Error('Could not protect the OIDC login state');
	return encoded;
}

export type LoginStateFailure =
	| 'missing' // no cookie: a bookmarked callback, or a different browser
	| 'unreadable' // not our ciphertext, or the instance key changed
	| 'malformed' // decrypted to something that is not a login state
	| 'expired' // the user took longer than the TTL
	| 'state-mismatch'; // the provider echoed a different state than we issued

export type LoginStateResult =
	| { ok: true; state: OidcLoginState }
	| { ok: false; reason: LoginStateFailure };

/**
 * Reading a cookie takes both halves together: whether the value is this instance's
 * ciphertext, and how to decrypt it. Passing the pair as one object means a caller
 * cannot supply the second without the first.
 */
export interface LoginStateCrypto {
	isCiphertext: (value: string) => boolean;
	decrypt: (value: string) => string | null;
}

/**
 * The login state a callback may act on, or why it may not.
 *
 * `returnedState` is what the provider echoed. Comparing it here rather than at the
 * call site keeps the check from being forgotten: a callback whose state does not
 * match the cookie is a different login, or a forged one.
 */
export function decodeLoginState(
	cookieValue: string | undefined | null,
	returnedState: string | undefined | null,
	crypto: LoginStateCrypto,
	now: number
): LoginStateResult {
	if (!cookieValue) return { ok: false, reason: 'missing' };

	// Only a value this instance encrypted is worth reading. `decrypt` returns
	// anything without the ciphertext marker unchanged, so without this the cookie
	// would be plain JSON that the browser can author - handing an attacker the
	// provider, the PKCE verifier and the nonce of the login it completes.
	if (!crypto.isCiphertext(cookieValue)) return { ok: false, reason: 'unreadable' };

	let plaintext: string | null;
	try {
		plaintext = crypto.decrypt(cookieValue);
	} catch {
		return { ok: false, reason: 'unreadable' };
	}
	if (!plaintext) return { ok: false, reason: 'unreadable' };

	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext);
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (!isLoginState(parsed)) return { ok: false, reason: 'malformed' };

	if (parsed.expiresAt <= now) return { ok: false, reason: 'expired' };

	// Compared after decoding, so a caller cannot skip it by forgetting to.
	if (!returnedState || returnedState !== parsed.state) {
		return { ok: false, reason: 'state-mismatch' };
	}

	return { ok: true, state: parsed };
}

/** What to tell somebody whose login could not be resumed. */
export function loginStateMessage(reason: LoginStateFailure): string {
	switch (reason) {
		case 'missing':
			return 'Login session not found. Start the sign-in from the login page, and allow cookies for this site.';
		case 'unreadable':
		case 'malformed':
			return 'Login session could not be read. Start the sign-in again.';
		case 'expired':
			return 'Login took too long and expired. Start the sign-in again.';
		case 'state-mismatch':
			return 'Login response did not match the request. Start the sign-in again.';
	}
}
