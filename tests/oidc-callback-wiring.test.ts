import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * That the callback ACTS on the answers its checks give it.
 *
 * `handleOidcCallback` lives in auth.ts, which reaches the database through
 * better-sqlite3 - a module bun cannot load - so no unit test can call it. The
 * decisions themselves are covered in oidc-callback-core.test.ts; what is left, and
 * what this covers, is the wiring: a refusal that is computed and then dropped on the
 * floor grants exactly the sign-in it was meant to stop, and reads as working code.
 *
 * Source inspection is the available instrument, so these assertions are deliberately
 * narrow: they name the specific line that must remain, not the shape of the function.
 */

const AUTH = readFileSync(new URL('../src/lib/server/auth.ts', import.meta.url), 'utf8');

/** The body of handleOidcCallback, so a match elsewhere in the file cannot satisfy these. */
const CALLBACK = (() => {
	const start = AUTH.indexOf('export async function handleOidcCallback');
	expect(start).toBeGreaterThan(-1);
	const end = AUTH.indexOf('\nexport ', start + 1);
	return AUTH.slice(start, end === -1 ? undefined : end);
})();

describe('the callback acts on its own checks', () => {
	test('a token response with no id_token ends the sign-in', () => {
		expect(CALLBACK).toContain('requireIdToken(tokens)');
		// Computed and ignored would mean building an identity from userinfo alone.
		expect(CALLBACK).toMatch(/if \(!present\.proceed\)[\s\S]{0,120}return \{\s*success: false/);
	});

	test('a token that fails verification ends the sign-in', () => {
		expect(CALLBACK).toContain('verifyIdToken(');
		// The throw has to become a refusal, not a warning the flow continues past.
		expect(CALLBACK).toMatch(/catch \(error\)[\s\S]{0,400}return \{ success: false/);
	});

	test('a userinfo response about a different subject ends the sign-in', () => {
		// The one that matters most: userinfo is unsigned, its values override the
		// token's, and the admin claim is read after the merge.
		expect(CALLBACK).toContain('applyUserinfo(claims, userinfo, config.name)');
		expect(CALLBACK).toMatch(/if \(!step\.proceed\)[\s\S]{0,200}return \{ success: false, error: step\.error \}/);
	});

	test('the merged claims come from the step, never from the raw response', () => {
		// `claims = userinfo` or `{...claims, ...userinfo}` would skip the check
		// entirely while still calling it.
		expect(CALLBACK).toContain('claims = step.claims');
		expect(CALLBACK).not.toMatch(/claims\s*=\s*\{\s*\.\.\.claims,\s*\.\.\.userinfo/);
		expect(CALLBACK).not.toMatch(/claims\s*=\s*userinfo/);
	});

	test('admin rights are decided from the verified claims', () => {
		expect(CALLBACK).toContain('claimsGrantAdmin(claims');
	});
});

describe('the reason reaches the login page intact', () => {
	// The refusal travels as /login?error=<encoded>, and a provider is free to put a
	// literal '%' in it ("Client secret is 100% wrong"). searchParams.get() already
	// decodes, so decoding a second time throws URIError - and that throw lands before
	// the page fetches its providers, leaving no way to sign in at all.
	const page = readFileSync(new URL('../src/routes/login/+page.svelte', import.meta.url), 'utf8');

	test('the login page does not decode what searchParams already decoded', () => {
		expect(page).not.toMatch(/error\s*=\s*decodeURIComponent\(urlError\)/);
		expect(page).toMatch(/const urlError = \$derived\(\$page\.url\.searchParams\.get\('error'\)\)/);
	});

	test('a percent in the reason survives the round trip the callback uses', () => {
		// Exactly what the callback does: encodeURIComponent into the query, then the
		// page reads it back.
		const reason = 'The provider refused the authorization code: Client secret is 100% wrong';
		const url = new URL(`https://example.invalid/login?error=${encodeURIComponent(reason)}`);
		expect(url.searchParams.get('error')).toBe(reason);
	});
});

describe('a refused token exchange reports what the provider said', () => {
	// The reason is computed in oidc-callback-core and tested there. What is left is
	// that auth.ts USES it: reverting to a fixed string, or dropping the provider name
	// from the log, leaves every test green while undoing the whole point.
	const auth = readFileSync(new URL('../src/lib/server/auth.ts', import.meta.url), 'utf8');
	const block = auth.slice(
		auth.indexOf('if (!tokenResponse.ok)'),
		auth.indexOf('const tokens = await tokenResponse.json()')
	);

	test('the returned error is the described one, not a fixed string', () => {
		expect(block).toContain('describeTokenExchangeFailure(tokenResponse.status, errorBody)');
		expect(block).not.toMatch(/error:\s*'Failed to exchange the authorization code'/);
	});

	test('both log lines name the provider and carry the OIDC prefix', () => {
		// Without these a second configured provider makes the log unreadable, and
		// `grep OIDC` misses the failure entirely.
		const logs = block.match(/console\.error\(`[^`]*`\)/g) ?? [];
		expect(logs.length).toBeGreaterThanOrEqual(2);
		for (const line of logs) {
			expect(line).toContain('[OIDC]');
			expect(line).toContain('${config.name}');
		}
	});

	test('the body is redacted before it reaches the log', () => {
		// The request carried the client secret; a provider that echoes it back must
		// not put it in our log.
		expect(block).toContain('redactTokenErrorBody(errorBody)');
		expect(block).not.toMatch(/\$\{errorBody\}/);
	});
});
