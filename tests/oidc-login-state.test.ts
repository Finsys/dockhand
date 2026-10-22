import { describe, expect, test } from 'bun:test';
import {
	encodeLoginState,
	decodeLoginState,
	loginStateMessage,
	loginStateCookieName,
	loginStateCookiesToEvict,
	MAX_LOGIN_STATE_COOKIES,
	OIDC_STATE_TTL_SECONDS,
	type OidcLoginState
} from '../src/lib/server/oidc-login-state';

// Stands in for the instance encryption, and matches the real `decrypt` in the one
// respect that decides safety here: a value with no ciphertext marker is handed BACK
// UNCHANGED, not refused. A stub that returned null instead would be stronger than
// production and would pass a cookie the browser can author.
const fakeEncrypt = (p: string) => 'enc:v1:' + Buffer.from(p).toString('base64');
const fakeCrypto = {
	isCiphertext: (v: string) => v.startsWith('enc:v1:'),
	decrypt: (v: string) => {
		if (!v.startsWith('enc:v1:')) return v;
		return Buffer.from(v.slice(7), 'base64').toString();
	}
};

const NOW = 1_700_000_000_000;

function aLogin(overrides: Partial<OidcLoginState> = {}): OidcLoginState {
	return {
		configId: 3,
		state: 'state-abc',
		codeVerifier: 'verifier-xyz',
		nonce: 'nonce-123',
		redirectUrl: '/containers',
		expiresAt: NOW + OIDC_STATE_TTL_SECONDS * 1000,
		...overrides
	};
}

describe('a login that comes back as it left', () => {
	test('round-trips every field', () => {
		const login = aLogin();
		const cookie = encodeLoginState(login, fakeEncrypt);
		const out = decodeLoginState(cookie, login.state, fakeCrypto, NOW);

		expect(out.ok).toBe(true);
		if (out.ok) expect(out.state).toEqual(login);
	});

	test('the cookie does not carry the secrets in the clear', () => {
		// The PKCE verifier and the nonce defeat their own purpose if a page script
		// can read them off the cookie.
		const cookie = encodeLoginState(aLogin(), fakeEncrypt);
		expect(cookie).not.toContain('verifier-xyz');
		expect(cookie).not.toContain('nonce-123');
	});
});

describe('a login that cannot be resumed', () => {
	test('no cookie at all', () => {
		// A bookmarked callback URL, or a different browser than the one that started.
		expect(decodeLoginState(undefined, 'state-abc', fakeCrypto, NOW)).toEqual({
			ok: false,
			reason: 'missing'
		});
		expect(decodeLoginState('', 'state-abc', fakeCrypto, NOW)).toEqual({
			ok: false,
			reason: 'missing'
		});
	});

	test('a cookie this instance cannot read', () => {
		// Someone else's ciphertext, or ours from before a key rotation.
		expect(decodeLoginState('not-our-ciphertext', 'state-abc', fakeCrypto, NOW)).toEqual({
			ok: false,
			reason: 'unreadable'
		});
	});

	test('a cookie the browser wrote itself, in the clear', () => {
		// The attack this guards: plant a login state in a victim's browser and send
		// them to the callback, and they finish a sign-in whose provider, verifier and
		// nonce the attacker chose. `decrypt` returns an unmarked value unchanged, so
		// only the ciphertext test stands between that JSON and a trusted login.
		const planted = JSON.stringify(aLogin({ state: 'attacker-state' }));
		expect(decodeLoginState(planted, 'attacker-state', fakeCrypto, NOW)).toEqual({
			ok: false,
			reason: 'unreadable'
		});
	});

	test('a decrypt that throws is not an unhandled error', () => {
		const throws = () => {
			throw new Error('bad key');
		};
		expect(decodeLoginState('enc:v1:whatever', 'state-abc', { isCiphertext: () => true, decrypt: throws }, NOW)).toEqual({
			ok: false,
			reason: 'unreadable'
		});
	});

	test('a cookie holding something that is not a login', () => {
		const cookie = fakeEncrypt(JSON.stringify({ hello: 'world' }));
		expect(decodeLoginState(cookie, 'state-abc', fakeCrypto, NOW)).toEqual({
			ok: false,
			reason: 'malformed'
		});
	});

	test('a login missing a field the callback needs', () => {
		// A truncated state would otherwise reach the token exchange with an empty
		// verifier and fail somewhere less legible.
		const partial = { ...aLogin(), codeVerifier: '' };
		const cookie = fakeEncrypt(JSON.stringify(partial));
		expect(decodeLoginState(cookie, 'state-abc', fakeCrypto, NOW)).toEqual({
			ok: false,
			reason: 'malformed'
		});
	});

	test('a login older than the window', () => {
		const cookie = encodeLoginState(aLogin({ expiresAt: NOW - 1 }), fakeEncrypt);
		expect(decodeLoginState(cookie, 'state-abc', fakeCrypto, NOW)).toEqual({
			ok: false,
			reason: 'expired'
		});
	});

	test('expiry is exclusive, so the last millisecond does not pass', () => {
		const cookie = encodeLoginState(aLogin({ expiresAt: NOW }), fakeEncrypt);
		expect(decodeLoginState(cookie, 'state-abc', fakeCrypto, NOW).ok).toBe(false);
	});
});

describe('the state the provider echoed', () => {
	test('a different state is refused', () => {
		// Somebody else's authorization response, or a forged one.
		const cookie = encodeLoginState(aLogin(), fakeEncrypt);
		expect(decodeLoginState(cookie, 'some-other-state', fakeCrypto, NOW)).toEqual({
			ok: false,
			reason: 'state-mismatch'
		});
	});

	test('no state at all is refused', () => {
		const cookie = encodeLoginState(aLogin(), fakeEncrypt);
		expect(decodeLoginState(cookie, undefined, fakeCrypto, NOW)).toEqual({
			ok: false,
			reason: 'state-mismatch'
		});
		expect(decodeLoginState(cookie, '', fakeCrypto, NOW)).toEqual({
			ok: false,
			reason: 'state-mismatch'
		});
	});
});

describe('two logins at once', () => {
	// A hash stand-in: distinct inputs give distinct outputs, which is all the naming
	// depends on.
	const hash = (v: string) => Buffer.from(v).toString('hex').padEnd(16, '0');

	test('each login gets its own cookie name', () => {
		expect(loginStateCookieName('state-a', hash)).not.toBe(loginStateCookieName('state-b', hash));
	});

	test('the same login always lands on the same name', () => {
		// The callback finds its cookie by re-deriving the name from the state the
		// provider echoed, so this has to be stable.
		expect(loginStateCookieName('state-a', hash)).toBe(loginStateCookieName('state-a', hash));
	});

	test('the state itself is not the cookie name', () => {
		// Names are the one part the encryption does not cover.
		expect(loginStateCookieName('state-abc', hash)).not.toContain('state-abc');
	});
});

describe('how many unfinished logins one browser may hold', () => {
	const c = (n: number, expiresAt: number | null) => ({
		name: `dockhand_oidc_state_${n}`,
		expiresAt
	});

	test('a handful of tabs signing in at once is fine', () => {
		const held = [c(1, NOW + 1000), c(2, NOW + 2000)];
		expect(loginStateCookiesToEvict(held)).toEqual([]);
	});

	test('at the ceiling the oldest makes room for the new one', () => {
		// Starting a login needs no session, so without a ceiling a page could pile
		// these up until the request header is too big for the server to accept.
		const held = Array.from({ length: MAX_LOGIN_STATE_COOKIES }, (_, i) =>
			c(i, NOW + i * 1000)
		);
		expect(loginStateCookiesToEvict(held)).toEqual(['dockhand_oidc_state_0']);
	});

	test('a flood is cut back to the ceiling, not merely trimmed', () => {
		const held = Array.from({ length: 50 }, (_, i) => c(i, NOW + i));
		const evicted = loginStateCookiesToEvict(held);
		expect(held.length - evicted.length).toBe(MAX_LOGIN_STATE_COOKIES - 1);
	});

	test('one that cannot be read goes first: it can never be resumed', () => {
		const held = [c(1, null), c(2, NOW + 1000), c(3, NOW + 2000)];
		expect(loginStateCookiesToEvict(held, 2)).toEqual([
			'dockhand_oidc_state_1',
			'dockhand_oidc_state_2'
		]);
	});

	test('other cookies are never touched', () => {
		// This runs on a request the browser made; evicting anything else would be
		// one request interfering with the rest of the session.
		const held = [
			{ name: 'dockhand_session', expiresAt: null },
			{ name: 'theme', expiresAt: null },
			c(1, NOW + 1000),
			c(2, NOW + 2000)
		];
		expect(loginStateCookiesToEvict(held, 2)).toEqual(['dockhand_oidc_state_1']);
	});
});

describe('what the user is told', () => {
	test('every failure has its own message', () => {
		const reasons = ['missing', 'unreadable', 'malformed', 'expired', 'state-mismatch'] as const;
		const messages = reasons.map((r) => loginStateMessage(r));

		for (const m of messages) {
			expect(m.length).toBeGreaterThan(0);
			// Every message names the way forward, not just the failure.
			expect(m).toMatch(/again|login page/i);
		}
		// Distinct enough to tell apart in a support thread.
		expect(new Set(messages).size).toBeGreaterThan(1);
	});
});
