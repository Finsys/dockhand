import { describe, expect, test } from 'bun:test';

/**
 * OIDC_END_SESSION decides whether logging out also ends the session at the identity
 * provider. It is opt-OUT, which is the unusual direction for a flag here, so the
 * default is worth pinning: reading it as opt-in would silently stop ending provider
 * sessions on every install that never sets the variable.
 *
 * The module reads process.env once at import, so each case imports a fresh copy.
 */

async function flagWith(value: string | undefined): Promise<boolean> {
	const previous = process.env.OIDC_END_SESSION;
	if (value === undefined) delete process.env.OIDC_END_SESSION;
	else process.env.OIDC_END_SESSION = value;

	try {
		// A distinct query string defeats the module cache, so the top-level read runs again.
		const mod = await import(`../src/lib/server/features?end-session=${value ?? 'unset'}`);
		return mod.OIDC_END_SESSION;
	} finally {
		if (previous === undefined) delete process.env.OIDC_END_SESSION;
		else process.env.OIDC_END_SESSION = previous;
	}
}

describe('ending the provider session on logout', () => {
	test('is on when nobody has said otherwise', async () => {
		// Leaving the provider session open means the next visit signs straight back
		// in, so this has to hold without any configuration.
		expect(await flagWith(undefined)).toBe(true);
	});

	test('only the exact string "false" turns it off', async () => {
		expect(await flagWith('false')).toBe(false);
	});

	test('anything else leaves it on', async () => {
		// A half-set variable must not quietly disable a security behaviour.
		for (const value of ['true', '', '0', 'no', 'False', 'FALSE']) {
			expect(await flagWith(value)).toBe(true);
		}
	});
});
