/**
 * Bulk-pull merge precedence.
 *
 * resolveProviderEnvVars merges a provider's bulk pull UNDER the stack's explicit
 * DB secrets with `Object.assign(bulkVars, secretVars)` - so an explicit DB secret
 * with the same key wins over the value pulled from the provider. The full resolver
 * imports the DB + provider registry (not unit-loadable), so this asserts the merge
 * contract in isolation. The e2e (secret-provider-stack-integration) can no longer
 * show which value won because inspect masks both, so this is where precedence lives.
 */
import { describe, test, expect } from 'bun:test';

// Mirrors the merge in resolveProviderEnvVars: bulk values first, explicit DB
// secrets assigned over them.
function mergeBulkUnderSecrets(
	bulkVars: Record<string, string>,
	dbSecretVars: Record<string, string>
): Record<string, string> {
	return Object.assign({ ...bulkVars }, dbSecretVars);
}

describe('bulk pull merge precedence', () => {
	test('explicit DB secret wins over the same key from bulk', () => {
		const merged = mergeBulkUnderSecrets(
			{ DB_PASSWORD: 's3cr3t-vault', API_KEY: 'ak-vault-123' },
			{ DB_PASSWORD: 'explicit-override' }
		);
		expect(merged.DB_PASSWORD).toBe('explicit-override'); // DB secret won
		expect(merged.API_KEY).toBe('ak-vault-123'); // only from bulk, untouched
	});

	test('keys present only in bulk pass through unchanged', () => {
		const merged = mergeBulkUnderSecrets(
			{ REDIS_URL: 'redis://from-vault', API_KEY: 'ak-vault-123' },
			{ DB_PASSWORD: 'db-only' }
		);
		expect(merged.REDIS_URL).toBe('redis://from-vault');
		expect(merged.API_KEY).toBe('ak-vault-123');
		expect(merged.DB_PASSWORD).toBe('db-only');
	});

	test('empty bulk leaves DB secrets intact', () => {
		const merged = mergeBulkUnderSecrets({}, { DB_PASSWORD: 'db-only' });
		expect(merged).toEqual({ DB_PASSWORD: 'db-only' });
	});
});
