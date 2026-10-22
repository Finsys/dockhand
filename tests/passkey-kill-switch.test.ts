/**
 * The passkey kill switch, as wiring.
 *
 * Hiding the login button is presentation; refusing the endpoints is the feature.
 * Both halves have to hold, and neither can be unit-tested directly: the handlers
 * reach the database through their imports and bun cannot load better-sqlite3. So
 * these read the source, the fallback this repo already uses for that situation
 * (see env-file-values.test.ts).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const CEREMONY_ROUTES = [
	['login/options', '../src/routes/api/auth/passkeys/login/options/+server.ts'],
	['login/verify', '../src/routes/api/auth/passkeys/login/verify/+server.ts'],
	['register/options', '../src/routes/api/auth/passkeys/register/options/+server.ts'],
	['register/verify', '../src/routes/api/auth/passkeys/register/verify/+server.ts']
] as const;

describe('every ceremony endpoint enforces the setting', () => {
	for (const [name, path] of CEREMONY_ROUTES) {
		test(`${name} refuses when passkeys are off`, () => {
			const src = read(path);
			// The negation is INSIDE the match: a regex that starts after it reads an
			// inverted gate as correct, and an inverted gate refuses exactly the
			// instances that allow passkeys.
			expect(src).toMatch(/if \(!\(await getPasskeysEnabled\(\)\)\)\s*return json\([^;]*403/);
			expect(src).not.toMatch(/if \(\(await getPasskeysEnabled\(\)\)\)/);
		});

		test(`${name} checks it before doing any work`, () => {
			// The guard has to sit with the other entry checks, not after a ceremony has
			// been consumed or a credential written. Measured from the handler body, so
			// a name appearing in the import block does not count as work.
			const src = read(path);
			const body = src.slice(src.search(/export const (GET|POST|DELETE):/));
			const gate = body.indexOf('getPasskeysEnabled()');
			const work = Math.min(
				...['webAuthnChallenges.issue', 'webAuthnChallenges.consume', 'createPasskeyCredential']
					.map((m) => body.indexOf(m))
					.filter((i) => i !== -1)
					.concat([body.length])
			);
			expect(gate).toBeGreaterThan(-1);
			expect(gate).toBeLessThan(work);
		});
	}
});

describe('the login page only offers what the server advertises', () => {
	test('the providers endpoint feeds both inputs into the decision', () => {
		// Asserting the names APPEAR is satisfied by an import or a dead call. What
		// matters is that each one reaches the argument, and that the result is what
		// gets returned rather than a value ORed past it.
		const src = read('../src/routes/api/auth/providers/+server.ts');
		const call = src.match(/passkeysOffered\(\{[\s\S]{0,200}?\}\)/);
		expect(call).not.toBeNull();
		expect(call![0]).toMatch(/enabled:\s*passkeysEnabled/);
		expect(call![0]).toMatch(/originUsable:\s*isWebAuthnConfigured\(\)/);
		expect(src).toMatch(/const passkeys = passkeysOffered\(/);
		expect(src).toContain('getPasskeysEnabled()');
	});

	test('a failure to read the settings advertises nothing', () => {
		// The catch path must not fall back to offering passkeys: a password form that
		// works beats a button that may not.
		const src = read('../src/routes/api/auth/providers/+server.ts');
		const fallback = src.slice(src.lastIndexOf('} catch'));
		expect(fallback).toMatch(/passkeys:\s*false/);
	});

	test('the button is gated on the advertised flag', () => {
		const src = read('../src/routes/login/+page.svelte');
		expect(src).toMatch(/\{#if passkeysOffered && !requiresMfa\}/);
		// Default closed, so a slow or failed fetch does not flash a dead button.
		expect(src).toMatch(/let passkeysOffered = \$state\(false\)/);
	});
});
