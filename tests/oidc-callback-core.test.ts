import { describe, expect, test } from 'bun:test';
import {
	requireIdToken,
	rejectedToken,
	applyUserinfo,
	describeTokenExchangeFailure,
	redactTokenErrorBody
} from '../src/lib/server/oidc-callback-core';

/**
 * What the callback does with the answers it gets.
 *
 * Verifying a token and merging claims have their own tests, but a check that is
 * called and then ignored looks exactly like a check that works. These cover the
 * decisions: a sign-in continues, or it stops and says why.
 */

describe('a token response with nothing to verify', () => {
	test('stops the sign-in rather than continuing without claims', () => {
		// Carrying on here would mean building an identity from the userinfo endpoint
		// alone, which nothing has proven belongs to this login.
		for (const tokens of [undefined, null, {}, { id_token: '' }]) {
			const step = requireIdToken(tokens as any);
			expect(step.proceed).toBe(false);
			if (!step.proceed) expect(step.error).toMatch(/no ID token/i);
		}
	});

	test('a response carrying one continues', () => {
		expect(requireIdToken({ id_token: 'a.b.c' }).proceed).toBe(true);
	});
});

describe('a token that failed verification', () => {
	test('stops the sign-in and carries the reason', () => {
		// The reason is what turns a support thread into a five-minute fix.
		const step = rejectedToken(new Error('the ID token came from a different issuer'));
		expect(step.proceed).toBe(false);
		if (!step.proceed) expect(step.error).toContain('different issuer');
	});

	test('a non-Error reason still reaches the user', () => {
		const step = rejectedToken('something odd');
		expect(step.proceed).toBe(false);
		if (!step.proceed) expect(step.error).toContain('something odd');
	});
});

describe('what a userinfo response is allowed to change', () => {
	const verified = { sub: 'alice', groups: ['viewers'] };

	test('a response about the same person is merged', () => {
		const step = applyUserinfo(verified, { sub: 'alice', email: 'alice@example.test' }, 'Keycloak');
		expect(step.proceed).toBe(true);
		if (step.proceed) expect(step.claims.email).toBe('alice@example.test');
	});

	test('a response about somebody else STOPS the sign-in', () => {
		// The one that matters: userinfo is unsigned, its values override the token's,
		// and the admin claim is read after this point. Ignoring the mismatch would let
		// the weaker endpoint name the user and hand out administrator rights.
		const step = applyUserinfo(verified, { sub: 'mallory', groups: ['admins'] }, 'Keycloak');

		expect(step.proceed).toBe(false);
		if (!step.proceed) expect(step.error).toMatch(/different account/i);
	});

	test('and the foreign claims never reach the caller', () => {
		const step = applyUserinfo(verified, { sub: 'mallory', groups: ['admins'] }, 'Keycloak');
		expect(step.proceed).toBe(false);
		// A refusal that still handed back merged claims would be no refusal at all.
		expect((step as { claims?: unknown }).claims).toBeUndefined();
	});

	test('a response naming nobody continues on the verified claims, and says so', () => {
		const step = applyUserinfo(verified, { email: 'x@example.test' }, 'Keycloak');

		expect(step.proceed).toBe(true);
		if (step.proceed) {
			expect(step.claims).toEqual(verified);
			expect(step.warn).toMatch(/naming no subject/i);
		}
	});

	test('no userinfo at all leaves the verified claims alone', () => {
		const step = applyUserinfo(verified, null, 'Keycloak');
		expect(step.proceed).toBe(true);
		if (step.proceed) expect(step.claims).toEqual(verified);
	});
});

describe('a provider that refuses the authorization code', () => {
	// The first thing a new OIDC setup gets wrong is the secret or the redirect URI,
	// and the provider says which. Reporting only that the exchange failed turns a
	// one-line fix into a support thread.
	test('carries the provider description, which names the actual mistake', () => {
		const body = JSON.stringify({
			error: 'invalid_client',
			error_description: 'Invalid client or Invalid client credentials'
		});
		expect(describeTokenExchangeFailure(401, body)).toBe(
			'The provider refused the authorization code: Invalid client or Invalid client credentials'
		);
	});

	test('falls back to the error code when there is no description', () => {
		expect(describeTokenExchangeFailure(400, JSON.stringify({ error: 'invalid_grant' }))).toBe(
			'The provider refused the authorization code: invalid_grant'
		);
	});

	test('a redirect-uri mismatch reads as itself', () => {
		const body = JSON.stringify({
			error: 'invalid_grant',
			error_description: 'Incorrect redirect_uri'
		});
		expect(describeTokenExchangeFailure(400, body)).toContain('Incorrect redirect_uri');
	});

	test('a non-JSON body leaves the status as the only fact available', () => {
		// Some providers answer HTML, and a proxy in front may answer anything at all.
		expect(describeTokenExchangeFailure(400, '<html>Bad Request</html>')).toBe(
			'The provider refused the authorization code (HTTP 400)'
		);
	});

	test('a 5xx reads as unreachable, not as a refusal', () => {
		// A gateway erroring is not the provider deciding anything about this sign-in,
		// and "refused" would send somebody to check the client secret instead of the
		// connection.
		expect(describeTokenExchangeFailure(502, '<html>Bad Gateway</html>')).toBe(
			'The provider could not be reached to exchange the authorization code (HTTP 502)'
		);
		expect(describeTokenExchangeFailure(500, '')).toBe(
			'The provider could not be reached to exchange the authorization code (HTTP 500)'
		);
		// A 4xx still reads as a refusal, because it is one.
		expect(describeTokenExchangeFailure(401, '')).toBe(
			'The provider refused the authorization code (HTTP 401)'
		);
	});

	test('a 5xx that carries an OAuth body still reads as unreachable', () => {
		// The status decides the verb. A maintenance notice arriving with a 503 is not
		// the provider refusing this sign-in, and saying so would send somebody to
		// check the client secret.
		const body = JSON.stringify({
			error: 'temporarily_unavailable',
			error_description: 'Service is down for maintenance'
		});
		expect(describeTokenExchangeFailure(503, body)).toBe(
			'The provider could not be reached to exchange the authorization code: Service is down for maintenance'
		);
	});

	test('a non-string description is ignored rather than rendered as an object', () => {
		// The body is whatever the provider sends. A number, an object or an array in
		// that field must not reach the redirect URL as "[object Object]" - fall through
		// to the error code, which is the next most useful thing.
		for (const description of [42, null, { msg: 'x' }, ['a', 'b'], true]) {
			const body = JSON.stringify({ error: 'invalid_grant', error_description: description });
			expect(describeTokenExchangeFailure(400, body)).toBe(
				'The provider refused the authorization code: invalid_grant'
			);
		}
	});

	test('a non-string error code falls through to the status', () => {
		expect(describeTokenExchangeFailure(400, JSON.stringify({ error: 99 }))).toBe(
			'The provider refused the authorization code (HTTP 400)'
		);
	});

	test('JSON that is not an object does not throw', () => {
		// JSON.parse('null') succeeds and returns null, so reading .error off it would
		// be a TypeError inside the handler rather than a message for the user.
		for (const body of ['null', 'false', '"a bare string"', '[1,2,3]', '0']) {
			expect(() => describeTokenExchangeFailure(400, body)).not.toThrow();
			expect(describeTokenExchangeFailure(400, body)).toBe(
				'The provider refused the authorization code (HTTP 400)'
			);
		}
	});

	test('JSON without either field still reports the status', () => {
		expect(describeTokenExchangeFailure(403, JSON.stringify({ message: 'nope' }))).toBe(
			'The provider refused the authorization code (HTTP 403)'
		);
	});

	test('a blank description does not produce a dangling colon', () => {
		expect(describeTokenExchangeFailure(400, JSON.stringify({ error_description: '   ' }))).toBe(
			'The provider refused the authorization code (HTTP 400)'
		);
	});

	test('a blank description falls through to the code, not to the status', () => {
		// A provider that sends the field empty still names the fault in `error`, and
		// "invalid_grant" is worth more to whoever is fixing it than "HTTP 400".
		expect(
			describeTokenExchangeFailure(400, JSON.stringify({ error: 'invalid_grant', error_description: '   ' }))
		).toBe('The provider refused the authorization code: invalid_grant');
		expect(
			describeTokenExchangeFailure(400, JSON.stringify({ error: 'invalid_grant', error_description: '' }))
		).toBe('The provider refused the authorization code: invalid_grant');
	});

	test('truncation never splits a character, so the redirect can encode it', () => {
		// The message is handed to encodeURIComponent on its way into /login?error=,
		// and a lone surrogate makes that throw URIError - which would replace the
		// provider's actual reason with "URI malformed".
		const body = JSON.stringify({ error_description: 'x'.repeat(199) + '\u{1F600}' + 'tail' });
		const out = describeTokenExchangeFailure(400, body);
		expect(() => encodeURIComponent(out)).not.toThrow();

		// And when the text is nothing but astral characters.
		const emoji = JSON.stringify({ error_description: '\u{1F600}'.repeat(300) });
		expect(() => encodeURIComponent(describeTokenExchangeFailure(400, emoji))).not.toThrow();
	});

	test('the description is flattened and bounded', () => {
		// It is free text from the provider, and it reaches a log line and a URL.
		const long = 'x'.repeat(500);
		const out = describeTokenExchangeFailure(400, JSON.stringify({ error_description: `a\n  b ${long}` }));
		expect(out).not.toContain('\n');
		expect(out.length).toBeLessThan(260);
		expect(out).toContain('a b');
	});
});

describe('a provider error body on its way into the log', () => {
	// The exchange request carries the client secret and the authorization code, so a
	// provider that echoes what it received would otherwise put both in our log.
	test('a secret echoed back is masked', () => {
		const body = 'error=invalid_client&client_secret=hunter2&client_id=dockhand';
		const out = redactTokenErrorBody(body);
		expect(out).not.toContain('hunter2');
		expect(out).toContain('<redacted>');
		// What is safe to see stays visible, or the log stops being useful.
		expect(out).toContain('invalid_client');
		expect(out).toContain('dockhand');
	});

	test('a JSON body is masked the same way', () => {
		const body = JSON.stringify({ error: 'invalid_client', client_secret: 'hunter2' });
		const out = redactTokenErrorBody(body);
		expect(out).not.toContain('hunter2');
		expect(out).toContain('invalid_client');
	});

	test('the authorization code is masked too', () => {
		expect(redactTokenErrorBody('error=invalid_grant&code=abc123xyz')).not.toContain('abc123xyz');
	});

	test('a token echoed back is masked', () => {
		for (const field of ['access_token', 'refresh_token', 'id_token']) {
			expect(redactTokenErrorBody(`${field}=sensitive-value-here`)).not.toContain(
				'sensitive-value-here'
			);
		}
	});

	test('an ordinary body is left readable', () => {
		const body = JSON.stringify({ error: 'invalid_grant', error_description: 'Incorrect redirect_uri' });
		expect(redactTokenErrorBody(body)).toContain('Incorrect redirect_uri');
	});

	test('a page of HTML cannot flood the log', () => {
		const out = redactTokenErrorBody('<html>' + 'x'.repeat(5000) + '</html>');
		expect(out.length).toBeLessThan(560);
		expect(out).toContain('truncated');
	});

	test('a renamed secret field does not slip past', () => {
		// The field name is the provider's to choose in its echo, so the match is on the
		// name as a suffix rather than an exact string.
		for (const body of [
			'oauth_client_secret=hunter2',
			JSON.stringify({ clientSecret: 'hunter2' }),
			JSON.stringify({ app_client_secret: 'hunter2' })
		]) {
			expect(redactTokenErrorBody(body)).not.toContain('hunter2');
		}
	});

	test('a request echoed back as a JSON string is still masked', () => {
		// Some providers answer with the whole request embedded as a string, so the
		// quotes around the field arrive escaped.
		const inner = JSON.stringify({ client_secret: 'hunter2', code: 'abc123' });
		const out = redactTokenErrorBody(JSON.stringify(inner));
		expect(out).not.toContain('hunter2');
		expect(out).not.toContain('abc123');
	});

	test('a diagnostic field that merely ends in code stays readable', () => {
		// Masking error_code or status_code would take away the very thing the log is
		// being read for.
		const body = JSON.stringify({ error: 'invalid_grant', error_code: 'AADSTS70008', status_code: 400 });
		const out = redactTokenErrorBody(body);
		expect(out).toContain('AADSTS70008');
		expect(out).toContain('400');
	});

	test('a megabyte of hostile text does not hang the process', () => {
		// The body comes from a remote service, and the pattern must never be the way
		// it gets to spend our CPU. Bounding before matching is what makes this fast.
		for (const body of ['_'.repeat(1_000_000), 'client_secre'.repeat(80_000), 'a='.repeat(500_000)]) {
			const started = Date.now();
			redactTokenErrorBody(body);
			expect(Date.now() - started).toBeLessThan(1000);
		}
	});

	test('a secret holding a space or a comma is masked whole', () => {
		// The value runs to the delimiter of its own encoding, so a JSON secret with an
		// odd character inside does not leave its tail behind in the log.
		for (const secret of ['hun ter2secret', 'hun,ter2secret', 'hun}ter2secret']) {
			const out = redactTokenErrorBody(JSON.stringify({ client_secret: secret }));
			expect(out).not.toContain('ter2secret');
		}
	});

	test('an empty body says so rather than logging nothing', () => {
		expect(redactTokenErrorBody('')).toBe('(empty)');
	});
});
