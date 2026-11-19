// Unit tests for the 1Password service-account provider's log/client hygiene (#1436).
// Mocks @1password/sdk (process-global via bun mock.module) and drives the REAL
// serviceAccountProvider. No other unit test imports service-account.ts, so this
// mock does not leak into another suite.
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { probeCombinedCached } from '../src/lib/server/secretproviders/probe-cache';
import { isInlineProviderRef, resolvedRefVarNames } from '../src/lib/utils/invault-markers';

let createClientCalls = 0;
let resolveAllCalls = 0;
let environmentReads: string[] = [];
let resolvedVaultRefs: string[] = [];
let environmentReadError: Error | undefined;
let environments = new Map<string, { name: string; value: string }[]>();

mock.module('@1password/sdk', () => ({
	createClient: async () => {
		createClientCalls++;
		return {
			secrets: {
				resolveAll: async (refs: string[]) => {
					resolveAllCalls++;
					resolvedVaultRefs.push(...refs);
					const individualResponses: Record<string, any> = {};
					for (const r of refs) {
						// op://vault/item/field is valid; anything with < 3 segments is malformed.
						const segs = r.replace('op://', '').split('/');
						individualResponses[r] =
							segs.length < 3
								? { error: { message: 'invalid format', type: 'BadRef' } }
								: { content: { secret: `secret-for-${r}` } };
					}
					return { individualResponses };
				}
			},
			environments: {
				getVariables: async (id: string) => {
					environmentReads.push(id);
					if (environmentReadError) throw environmentReadError;
					const variables = environments.get(id);
					if (!variables) throw new Error('Environment not accessible');
					return { variables };
				}
			}
		};
	}
}));

const { serviceAccountProvider } = await import('../src/lib/server/secretproviders/service-account.ts');
const config = { token: 'ops_faketoken_for_test' };

describe('1Password service-account provider', () => {
	beforeEach(() => {
		createClientCalls = 0;
		resolveAllCalls = 0;
		environmentReads = [];
		resolvedVaultRefs = [];
		environmentReadError = undefined;
		environments = new Map([
			['Docker_Production', [{ name: 'BULK_A', value: 'a' }]],
			['env-id', [
				{ name: 'APP_POSTGRES_PASSWORD', value: 'app-password' },
				{ name: 'OTHER_POSTGRES_PASSWORD', value: 'other-password' },
				{ name: 'EMPTY', value: '' },
				{ name: 'UNREQUESTED', value: 'do-not-inject' }
			]],
			['other-env', [{ name: 'APP_POSTGRES_PASSWORD', value: 'different-environment' }]]
		]);
	});

	test('detects Environment and Vault references, including surrounding quotes', () => {
		for (const ref of ['op-env://env-id/KEY', 'op://vault/item/password']) {
			expect(serviceAccountProvider.isReference(ref)).toBe(true);
			expect(serviceAccountProvider.isReference(`  "${ref}"  `)).toBe(true);
			expect(serviceAccountProvider.isReference(`'${ref}'`)).toBe(true);
		}
		expect(serviceAccountProvider.isReference('literal')).toBe(false);
		expect(serviceAccountProvider.isReference(undefined)).toBe(false);
	});

	test('resolves only mapped Environment secrets without any Vault lookup', async () => {
		const ref = 'op-env://env-id/APP_POSTGRES_PASSWORD';
		const resolved = await serviceAccountProvider.resolveSecretReferences(config, [ref]);
		expect([...resolved]).toEqual([[ref, 'app-password']]);
		expect(environmentReads).toEqual(['env-id']);
		expect(resolveAllCalls).toBe(0);
	});

	test('the editor probe confirms destination variable names without returning secret values', async () => {
		const pair = {
			varName: 'POSTGRES_PASSWORD',
			ref: 'op-env://env-id/APP_POSTGRES_PASSWORD'
		};
		const refs = [pair].filter((p) => isInlineProviderRef(p.ref)).map((p) => p.ref);
		const result = await probeCombinedCached(987654, serviceAccountProvider, config, undefined, refs);
		expect(result).toEqual({ bulkKeys: [], resolvedRefs: [pair.ref] });
		expect(resolvedRefVarNames([pair], result.resolvedRefs)).toEqual(['POSTGRES_PASSWORD']);
		expect(environmentReads).toEqual(['env-id']);
	});

	test('groups references by Environment and keeps same-name secrets isolated', async () => {
		const refs = [
			'op-env://env-id/APP_POSTGRES_PASSWORD',
			'op-env://env-id/OTHER_POSTGRES_PASSWORD',
			'op-env://other-env/APP_POSTGRES_PASSWORD'
		];
		const resolved = await serviceAccountProvider.resolveSecretReferences(config, [...refs, refs[0]]);
		expect([...resolved]).toEqual([
			[refs[0], 'app-password'],
			[refs[1], 'other-password'],
			[refs[2], 'different-environment']
		]);
		expect(environmentReads).toEqual(['env-id', 'other-env']);
	});

	test('resolves Environment and Vault references together without sending mappings to resolveAll', async () => {
		const environmentRef = 'op-env://env-id/EMPTY';
		const vaultRef = 'op://vault/item/password';
		const resolved = await serviceAccountProvider.resolveSecretReferences(config, [environmentRef, vaultRef]);
		expect(resolved.get(environmentRef)).toBe('');
		expect(resolved.get(vaultRef)).toBe(`secret-for-${vaultRef}`);
		expect(resolvedVaultRefs).toEqual([vaultRef]);
	});

	test('fails for missing or wrong-case keys instead of deploying a literal reference', async () => {
		for (const name of ['MISSING', 'app_postgres_password']) {
			await expect(serviceAccountProvider.resolveSecretReferences(config, [
				`op-env://env-id/${name}`
			])).rejects.toThrow('1Password Environment secret not found');
		}
	});

	test('rejects malformed Environment references before calling the SDK', async () => {
		for (const ref of [
			'op-env://env-id', 'op-env:///KEY', 'op-env://env-id/',
			'op-env://env-id/KEY/extra', 'op-env://env-id/KEY?query',
			'op-env://env-id/KEY#fragment', 'op-env://env id/KEY'
		]) {
			await expect(serviceAccountProvider.resolveSecretReferences(
				{ token: 'ops_unused_malformed_reference_token' }, [ref]
			)).rejects.toThrow('need op-env://<environment-id>/<secret-name>');
		}
		expect(environmentReads).toEqual([]);
		expect(resolveAllCalls).toBe(0);
		expect(createClientCalls).toBe(0);
	});

	test('propagates Environment read errors', async () => {
		environmentReadError = new Error('Environment access denied');
		await expect(serviceAccountProvider.resolveSecretReferences(config, [
			'op-env://env-id/APP_POSTGRES_PASSWORD'
		])).rejects.toThrow('Environment access denied');
	});

	test('reads fresh values on the next resolution, without retaining Environment secrets', async () => {
		const ref = 'op-env://env-id/APP_POSTGRES_PASSWORD';
		await serviceAccountProvider.resolveSecretReferences(config, [ref]);
		environments.set('env-id', [{ name: 'APP_POSTGRES_PASSWORD', value: 'rotated-password' }]);
		const resolved = await serviceAccountProvider.resolveSecretReferences(config, [ref]);
		expect(resolved.get(ref)).toBe('rotated-password');
		expect(environmentReads).toEqual(['env-id', 'env-id']);
	});

	test('collapses malformed refs into a single warning, not one per ref', async () => {
		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
		try {
			const refs = [
				'op://Docker_Production/LEAFWIKI_PASSWORD', // malformed (no field)
				'op://Docker_Production/LEAFWIKI_JWT_TOKEN', // malformed
				'op://Docker_Production/EMILSE_MAIN_USER', // malformed
				'op://Docker_Production/item/password' // valid
			];
			const resolved = await serviceAccountProvider.resolveSecretReferences(config, refs, '[1Password]');
			// Exactly one summary warning for the 3 bad refs, not three.
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain('Skipped 3 of 4');
			expect(warnings[0]).toContain('op://<vault>/<item>/<field>');
			// The valid ref still resolves.
			expect(resolved.get('op://Docker_Production/item/password')).toBe(
				'secret-for-op://Docker_Production/item/password'
			);
			expect(resolved.size).toBe(1);
		} finally {
			console.warn = origWarn;
		}
	});

	test('does not warn when every ref resolves', async () => {
		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
		try {
			const refs = ['op://v/item/password', 'op://v/item/token'];
			const resolved = await serviceAccountProvider.resolveSecretReferences(config, refs, '[1Password]');
			expect(warnings.length).toBe(0);
			expect(resolved.size).toBe(2);
		} finally {
			console.warn = origWarn;
		}
	});

	test('reuses one SDK client across bulk + inline in a deploy (single handshake)', async () => {
		// A token unique to this test so the module-level client cache starts cold here.
		const freshConfig = { token: 'ops_fresh_token_for_shared_client_test' };
		// Simulate what resolveProviderEnvVars does per deploy: one bulk, then one inline.
		await serviceAccountProvider.resolveBulk(freshConfig, 'Docker_Production');
		await serviceAccountProvider.resolveSecretReferences(freshConfig, ['op://v/item/password'], '[1Password]');
		// Both operations run, but createClient is cached per token -> one handshake.
		expect(createClientCalls).toBe(1);
		expect(resolveAllCalls).toBe(1);
	});
});
