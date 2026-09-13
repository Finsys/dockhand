import { describe, test, expect } from 'bun:test';
import { collectProviderFormConfig } from '../src/lib/utils/provider-form-config';
import { mergeProviderConfigForWrite, destinationOverridesStored } from '../src/lib/server/secretproviders/shared';

// Field shape (key + isSecret) per provider, mirroring PROVIDER_FIELDS in
// routes/settings/secrets/ProviderModal.svelte. Only the shape matters for what the edit
// form emits, so this is kept as a small local table rather than importing the .svelte
// module. If a provider's fields change there, add/adjust the row here too.
const PROVIDER_FIELD_SHAPES: Record<string, Array<{ key: string; isSecret: boolean }>> = {
	'op-service-account': [{ key: 'token', isSecret: true }],
	'op-connect': [
		{ key: 'host', isSecret: false },
		{ key: 'token', isSecret: true }
	],
	infisical: [
		{ key: 'host', isSecret: false },
		{ key: 'token', isSecret: true },
		{ key: 'clientId', isSecret: false },
		{ key: 'clientSecret', isSecret: true },
		{ key: 'projectId', isSecret: false },
		{ key: 'environment', isSecret: false },
		{ key: 'path', isSecret: false }
	],
	vault: [
		{ key: 'address', isSecret: false },
		{ key: 'token', isSecret: true },
		{ key: 'namespace', isSecret: false },
		{ key: 'mount', isSecret: false }
	],
	doppler: [
		{ key: 'token', isSecret: true },
		{ key: 'project', isSecret: false },
		{ key: 'config', isSecret: false }
	],
	bitwarden: [
		{ key: 'token', isSecret: true },
		{ key: 'serverUrl', isSecret: false }
	],
	proton: [{ key: 'token', isSecret: true }],
	'azure-kv': [
		{ key: 'vaultUri', isSecret: false },
		{ key: 'tenantId', isSecret: false },
		{ key: 'clientId', isSecret: false },
		{ key: 'clientSecret', isSecret: true }
	]
};

const setOf = (...keys: string[]) => new Set(keys);

describe('collectProviderFormConfig - core rules', () => {
	test('a filled field is sent as-is', () => {
		const cfg = collectProviderFormConfig(
			PROVIDER_FIELD_SHAPES.vault,
			{ address: 'http://vault', token: 'hvs.x', mount: 'kv' },
			setOf('address', 'mount')
		);
		expect(cfg).toEqual({ address: 'http://vault', token: 'hvs.x', mount: 'kv' });
	});

	test('a blank secret is omitted (blank = keep stored)', () => {
		const cfg = collectProviderFormConfig(
			PROVIDER_FIELD_SHAPES.vault,
			{ address: 'http://vault', token: '', mount: 'kv' },
			setOf('address', 'token', 'mount')
		);
		expect('token' in cfg).toBe(false);
	});

	test('a cleared loaded non-secret is sent as ""', () => {
		const cfg = collectProviderFormConfig(
			PROVIDER_FIELD_SHAPES.vault,
			{ address: 'http://vault', mount: '' },
			setOf('address', 'mount')
		);
		expect(cfg.mount).toBe('');
	});

	test('a non-secret that was never loaded is not invented as ""', () => {
		const cfg = collectProviderFormConfig(
			PROVIDER_FIELD_SHAPES.vault,
			{ address: 'http://vault' },
			setOf('address') // mount never existed
		);
		expect('mount' in cfg).toBe(false);
	});

	test('whitespace-only values are treated as blank', () => {
		const cfg = collectProviderFormConfig(
			PROVIDER_FIELD_SHAPES.vault,
			{ address: '  ', token: '   ', mount: '  ' },
			setOf('address', 'mount')
		);
		expect(cfg.address).toBe(''); // loaded non-secret -> explicit clear
		expect(cfg.mount).toBe('');
		expect('token' in cfg).toBe(false); // blank secret omitted
	});
});

// The bug (#1448) and the fix must behave correctly for EVERY provider's field set - a
// cleared secret must never be omitted-as-keep when its partner is cleared, and every
// provider's optional non-secret fields must survive a clear as an explicit "".
describe('per-provider: no field is silently dropped or wrongly kept', () => {
	for (const [type, fields] of Object.entries(PROVIDER_FIELD_SHAPES)) {
		const secretKeys = fields.filter((f) => f.isSecret).map((f) => f.key);
		const nonSecretKeys = fields.filter((f) => !f.isSecret).map((f) => f.key);

		test(`${type}: blank secrets omitted, cleared loaded non-secrets sent as ""`, () => {
			// Simulate: everything loaded, user clears every field.
			const allKeys = fields.map((f) => f.key);
			const blankForm: Record<string, string> = {};
			for (const k of allKeys) blankForm[k] = '';
			const cfg = collectProviderFormConfig(fields, blankForm, new Set(allKeys));

			for (const k of secretKeys) {
				expect(k in cfg).toBe(false); // secrets never sent blank
			}
			for (const k of nonSecretKeys) {
				expect(cfg[k]).toBe(''); // cleared non-secrets sent explicitly
			}
		});

		test(`${type}: a fresh full config passes through unchanged`, () => {
			const filled: Record<string, string> = {};
			for (const f of fields) filled[f.key] = `val-${f.key}`;
			const cfg = collectProviderFormConfig(fields, filled, new Set());
			expect(cfg).toEqual(filled);
		});
	}
});

// #1448 is Infisical-specific (clientSecret paired with clientId), but the client rule is
// generic. Prove the full chain (form output -> server merge) for the paired case, and that
// no OTHER provider's stored secret is dropped just because a non-secret was cleared.
describe('#1448 full chain: form output -> server merge', () => {
	test('infisical: clearing clientId drops the orphaned clientSecret', () => {
		const stored = { host: 'http://infisical', clientId: 'cid', clientSecret: 'sec' };
		const emitted = collectProviderFormConfig(
			PROVIDER_FIELD_SHAPES.infisical,
			{ host: 'http://infisical', clientId: '', clientSecret: '', token: 'new-tok' },
			setOf('host', 'clientId', 'clientSecret')
		);
		const merged = mergeProviderConfigForWrite(emitted, stored);
		expect(merged.token).toBe('new-tok');
		expect(merged.clientSecret).toBeUndefined();
	});

	test('infisical: keeping clientId preserves the stored clientSecret', () => {
		const stored = { host: 'http://infisical', clientId: 'cid', clientSecret: 'sec' };
		const emitted = collectProviderFormConfig(
			PROVIDER_FIELD_SHAPES.infisical,
			{ host: 'http://new', clientId: 'cid', clientSecret: '' },
			setOf('host', 'clientId')
		);
		const merged = mergeProviderConfigForWrite(emitted, stored);
		expect(merged.clientSecret).toBe('sec');
	});

	test('azure-kv: clearing a non-secret does NOT drop the stored clientSecret (not a merge-paired secret)', () => {
		// azure-kv's clientSecret has no PAIRED_SECRET_PARTNERS entry, so a blank clientSecret
		// keeps the stored one regardless of other fields - clearing tenantId must not wipe it.
		const stored = { vaultUri: 'https://v', tenantId: 'tid', clientId: 'cid', clientSecret: 'sec' };
		const emitted = collectProviderFormConfig(
			PROVIDER_FIELD_SHAPES['azure-kv'],
			{ vaultUri: 'https://v', tenantId: '', clientId: 'cid', clientSecret: '' },
			setOf('vaultUri', 'tenantId', 'clientId')
		);
		const merged = mergeProviderConfigForWrite(emitted, stored);
		expect(merged.clientSecret).toBe('sec'); // kept
		expect(merged.tenantId).toBe(''); // cleared coordinate honored
	});

	test('vault: clearing mount keeps the stored token (blank secret = keep)', () => {
		const stored = { address: 'http://vault', token: 'hvs.stored', mount: 'kv' };
		const emitted = collectProviderFormConfig(
			PROVIDER_FIELD_SHAPES.vault,
			{ address: 'http://vault', mount: '' },
			setOf('address', 'mount')
		);
		const merged = mergeProviderConfigForWrite(emitted, stored);
		expect(merged.token).toBe('hvs.stored');
		expect(merged.mount).toBe(''); // server reads '' as the default mount
	});
});

// The test endpoint must not send a stored credential to a caller-chosen host. It decides via
// destinationOverridesStored: if the override changes host/address, the stored secret is NOT
// reattached and the caller needs secrets:edit.
describe('destinationOverridesStored (credential-exfil guard)', () => {
	test('Vault: changed address is a redirect', () => {
		const stored = { address: 'https://vault.internal:8200', token: 'hvs.REAL' };
		expect(destinationOverridesStored({ address: 'http://attacker.example:8902' }, stored)).toBe(true);
	});

	test('same address (edit form keeps host, blank token) is NOT a redirect', () => {
		const stored = { address: 'https://vault.internal:8200', token: 'hvs.REAL' };
		expect(destinationOverridesStored({ address: 'https://vault.internal:8200', mount: 'kv2' }, stored)).toBe(false);
	});

	test('1Password Connect / Infisical: changed host is a redirect', () => {
		const stored = { host: 'https://connect.internal', token: 'ey.REAL' };
		expect(destinationOverridesStored({ host: 'https://evil.example' }, stored)).toBe(true);
	});

	test('Bitwarden: changed serverUrl is a redirect (full stored-token leak vector)', () => {
		const stored = { serverUrl: 'https://vault.bitwarden.eu', token: 'bws.REAL' };
		expect(destinationOverridesStored({ serverUrl: 'http://attacker.example:8902' }, stored)).toBe(true);
	});

	test('Azure Key Vault: changed vaultUri is a redirect', () => {
		const stored = { vaultUri: 'https://kv.vault.azure.net', clientSecret: 'REAL' };
		expect(destinationOverridesStored({ vaultUri: 'https://evil.example' }, stored)).toBe(true);
	});

	test('override that omits the destination entirely is NOT a redirect', () => {
		const stored = { address: 'https://vault.internal:8200', token: 'hvs.REAL' };
		expect(destinationOverridesStored({ mount: 'kv2' }, stored)).toBe(false);
	});

	test('a cleared (blank) destination is not treated as a redirect', () => {
		const stored = { host: 'https://connect.internal', token: 'ey.REAL' };
		expect(destinationOverridesStored({ host: '   ' }, stored)).toBe(false);
	});
});
