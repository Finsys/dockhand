import { describe, test, expect } from 'bun:test';
import { isJsonResponse, mergeProviderConfigForWrite } from '../src/lib/server/secretproviders/shared';

// A 2xx status alone does not prove a host is the expected backend - a parked domain,
// captive portal, or reverse proxy can answer 200 with an HTML page. testConnection
// requires a JSON body before reporting success. This guards that predicate.
describe('isJsonResponse', () => {
	test('accepts a JSON object', () => {
		expect(isJsonResponse('{"data":{"cas_required":false}}')).toBe(true);
	});
	test('accepts a JSON array (e.g. Connect /vaults)', () => {
		expect(isJsonResponse('[]')).toBe(true);
		expect(isJsonResponse('[{"id":"v1"}]')).toBe(true);
	});
	test('accepts a flat secret map (Doppler download)', () => {
		expect(isJsonResponse('{"DB_PASSWORD":"x","API_KEY":"y"}')).toBe(true);
	});

	test('rejects an HTML page (the parked-domain failure mode)', () => {
		expect(isJsonResponse('<!DOCTYPE html><html><body>Error. Page cannot be displayed.</body></html>')).toBe(false);
	});
	test('rejects an empty or whitespace body', () => {
		expect(isJsonResponse('')).toBe(false);
		expect(isJsonResponse('   \n')).toBe(false);
		expect(isJsonResponse(null)).toBe(false);
		expect(isJsonResponse(undefined)).toBe(false);
	});
	test('rejects bare JSON scalars (a 200 body of `5` or `true` is not a backend answer)', () => {
		expect(isJsonResponse('5')).toBe(false);
		expect(isJsonResponse('true')).toBe(false);
		expect(isJsonResponse('"a string"')).toBe(false);
	});
	test('rejects malformed JSON', () => {
		expect(isJsonResponse('{')).toBe(false);
		expect(isJsonResponse('{"a":}')).toBe(false);
	});
});

// The edit form leaves the token blank ("keep stored"). A write OR an edit-mode Test must
// merge the typed non-secret fields over the stored config, keeping the stored token when
// blank - so a Test validates exactly what a Save would persist.
describe('mergeProviderConfigForWrite', () => {
	const stored = { address: 'http://good:8200', token: 'stored-tok', mount: 'secret' };

	test('typed non-secret fields override the stored ones', () => {
		const merged = mergeProviderConfigForWrite(
			{ address: 'http://bad:8203', token: '', mount: 'seacret' },
			stored
		);
		expect(merged.address).toBe('http://bad:8203');
		expect(merged.mount).toBe('seacret');
	});

	test('a blank token falls back to the stored secret', () => {
		const merged = mergeProviderConfigForWrite({ address: 'http://x', token: '' }, stored);
		expect(merged.token).toBe('stored-tok');
	});

	test('an absent token falls back to the stored secret', () => {
		const merged = mergeProviderConfigForWrite({ address: 'http://x' }, stored);
		expect(merged.token).toBe('stored-tok');
	});

	test('a typed token is used as-is (not overwritten by stored)', () => {
		const merged = mergeProviderConfigForWrite({ address: 'http://x', token: 'new-tok' }, stored);
		expect(merged.token).toBe('new-tok');
	});

	// #1448: switching Infisical Universal Auth -> static token. clientSecret is a masked
	// field paired with clientId; clearing clientId must drop the orphaned stored secret,
	// otherwise validation wedges on "Client ID is required when a client secret is set".
	describe('paired secret (Infisical Universal Auth <-> token)', () => {
		const uaStored = { host: 'http://infisical', clientId: 'stored-cid', clientSecret: 'stored-sec' };

		test('clearing clientId drops the stored clientSecret (switch to token auth)', () => {
			const merged = mergeProviderConfigForWrite(
				{ host: 'http://infisical', clientId: '', clientSecret: '', token: 'new-tok' },
				uaStored
			);
			expect(merged.token).toBe('new-tok');
			expect(merged.clientSecret).toBeUndefined();
			expect(merged.clientId).toBe('');
		});

		test('clearing clientId while leaving clientSecret blank also drops it', () => {
			// The realistic form submission: user empties clientId, types a token, leaves the
			// masked clientSecret field blank.
			const merged = mergeProviderConfigForWrite(
				{ host: 'http://infisical', clientId: '', token: 'new-tok' },
				uaStored
			);
			expect(merged.clientSecret).toBeUndefined();
		});

		test('keeping clientId set still preserves the stored clientSecret (blank = keep)', () => {
			// User edits a non-secret coordinate but keeps Universal Auth: the masked secret
			// must still be carried over.
			const merged = mergeProviderConfigForWrite(
				{ host: 'http://infisical-new', clientId: 'stored-cid', clientSecret: '' },
				uaStored
			);
			expect(merged.clientSecret).toBe('stored-sec');
			expect(merged.clientId).toBe('stored-cid');
		});

		test('a fresh clientSecret is used as-is even if clientId is unchanged', () => {
			const merged = mergeProviderConfigForWrite(
				{ host: 'http://infisical', clientId: 'stored-cid', clientSecret: 'rotated-sec' },
				uaStored
			);
			expect(merged.clientSecret).toBe('rotated-sec');
		});

		test('clientId absent (not in incoming) still keeps the stored secret', () => {
			// A partial incoming that never mentions clientId is NOT an explicit clear, so the
			// stored secret is preserved (blank-means-keep semantics unchanged).
			const merged = mergeProviderConfigForWrite({ host: 'http://infisical', clientSecret: '' }, uaStored);
			expect(merged.clientSecret).toBe('stored-sec');
		});
	});
});
