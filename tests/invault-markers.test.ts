import { describe, test, expect } from 'bun:test';
import { classifyMarker, resolvedRefVarNames, effectiveMissing } from '../src/lib/utils/invault-markers';

describe('classifyMarker', () => {
	const inVault = new Set(['DB_PASSWORD', 'API_KEY']);

	test('a defined var is required regardless of the provider set', () => {
		expect(classifyMarker('APP_ENV', false, inVault, false)).toBe('required');
	});

	test('a missing var present in the provider is invault (green)', () => {
		expect(classifyMarker('DB_PASSWORD', true, inVault, false)).toBe('invault');
	});

	test('a missing var absent from the provider stays missing (red)', () => {
		expect(classifyMarker('DUMMY', true, inVault, false)).toBe('missing');
	});

	test('probe failure forces MISSING even for a key that would be in the provider', () => {
		// Never a false green when we could not reach the provider.
		expect(classifyMarker('DB_PASSWORD', true, inVault, true)).toBe('missing');
	});

	test('empty provider set -> every missing var is missing', () => {
		expect(classifyMarker('DB_PASSWORD', true, new Set(), false)).toBe('missing');
	});
});

// The editor's live marker must never depend on a provider being present. A user
// with NO provider (or one that was unbound after a deploy) sees the exact old
// behavior: missing vars are red MISSING, never a stray green.
describe('classifyMarker - no-provider / unbound regression', () => {
	test('no provider bound: runProbe leaves an empty set + no error -> plain MISSING', () => {
		// This is the state runProbe() sets when formSecretProviderId === null.
		const noProvider = new Set<string>();
		expect(classifyMarker('DB_PASSWORD', true, noProvider, false)).toBe('missing');
		expect(classifyMarker('API_KEY', true, noProvider, false)).toBe('missing');
	});

	test('a defined var is required with no provider (editor unaffected)', () => {
		expect(classifyMarker('APP_ENV', false, new Set(), false)).toBe('required');
	});

	test('provider unbound after a deploy: live probe set is empty, so those keys go MISSING in the editor (banner history is separate)', () => {
		// DB has injected_secret_keys from a past deploy, but the provider is now
		// unbound -> the live probe set is empty. The EDITOR must show MISSING; the
		// last-deploy banner (driven separately by injectedSecretKeys) is not this path.
		const liveSetAfterUnbind = new Set<string>();
		expect(classifyMarker('DB_PASSWORD', true, liveSetAfterUnbind, false)).toBe('missing');
	});
});

// The panel's missing count / "Add missing" list must match the editor's IN VAULT
// markers - both drop ONLY the keys the LIVE probe found in the provider. The
// last-deploy injected table is never consulted here (that drives only the banner).
describe('effectiveMissing (panel <-> editor consistency, live only)', () => {
	test('drops LIVE provider keys from missing, so the panel agrees with IN VAULT', () => {
		// The bug: editor showed IN VAULT but the panel still counted them missing.
		const missing = ['DB_PASSWORD', 'API_KEY', 'REDIS_URL', 'MISSING_ONE'];
		const live = new Set(['DB_PASSWORD', 'API_KEY', 'REDIS_URL']);
		expect(effectiveMissing(missing, live)).toEqual(['MISSING_ONE']);
	});

	test('probe failed / no provider (empty live set) -> nothing dropped, stays missing', () => {
		const missing = ['DB_PASSWORD', 'MISSING_ONE'];
		expect(effectiveMissing(missing, new Set())).toEqual(missing);
	});
});

describe('resolvedRefVarNames', () => {
	test('maps resolved ref STRINGS back to their var names', () => {
		const pairs = [
			{ varName: 'DB_PASSWORD', ref: 'op://vault/db/password' },
			{ varName: 'API_KEY', ref: 'op://vault/api/key' },
			{ varName: 'STALE', ref: 'op://vault/gone/secret' }
		];
		// provider resolved only the first two refs
		expect(resolvedRefVarNames(pairs, ['op://vault/db/password', 'op://vault/api/key']))
			.toEqual(['DB_PASSWORD', 'API_KEY']);
	});

	test('a ref that did not resolve is dropped', () => {
		const pairs = [{ varName: 'STALE', ref: 'op://vault/gone/secret' }];
		expect(resolvedRefVarNames(pairs, [])).toEqual([]);
	});

	test('no inline refs -> empty', () => {
		expect(resolvedRefVarNames([], ['op://whatever'])).toEqual([]);
	});
});
