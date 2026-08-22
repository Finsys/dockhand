// Unit tests for the 1Password service-account provider's log/client hygiene (#1436).
// Mocks @1password/sdk (process-global via bun mock.module) and drives the REAL
// serviceAccountProvider. No other unit test imports service-account.ts, so this
// mock does not leak into another suite.
import { describe, test, expect, mock, beforeEach } from 'bun:test';

let createClientCalls = 0;
let resolveAllCalls = 0;

mock.module('@1password/sdk', () => ({
	createClient: async () => {
		createClientCalls++;
		return {
			secrets: {
				resolveAll: async (refs: string[]) => {
					resolveAllCalls++;
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
				getVariables: async () => ({ variables: [{ name: 'BULK_A', value: 'a' }] })
			}
		};
	}
}));

const { serviceAccountProvider } = await import('../src/lib/server/secretproviders/service-account.ts');
const config = { token: 'ops_faketoken_for_test' } as any;

describe('1Password service-account provider (#1436 hygiene)', () => {
	beforeEach(() => {
		createClientCalls = 0;
		resolveAllCalls = 0;
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
		const freshConfig = { token: 'ops_fresh_token_for_shared_client_test' } as any;
		// Simulate what resolveProviderEnvVars does per deploy: one bulk, then one inline.
		await serviceAccountProvider.resolveBulk(freshConfig, 'Docker_Production');
		await serviceAccountProvider.resolveSecretReferences(freshConfig, ['op://v/item/password'], '[1Password]');
		// Both operations run, but createClient is cached per token -> one handshake.
		expect(createClientCalls).toBe(1);
		expect(resolveAllCalls).toBe(1);
	});
});
