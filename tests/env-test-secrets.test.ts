import { describe, test, expect } from 'bun:test';
import { fillStoredSecrets } from '../src/lib/server/env-test-secrets';
import { readFileSync } from 'node:fs';

// Test connection reuses an environment's stored hawserToken / tlsKey only while it still
// targets that environment's own host, port and protocol; a changed target gets nothing.
const stored = { host: '10.0.0.5', port: 2376, protocol: 'https', hawserToken: 'tok-stored', tlsKey: 'key-stored' };

describe('fillStoredSecrets', () => {
	test('same target: blank secrets are filled from the stored environment', () => {
		const c = { host: '10.0.0.5', port: 2376, protocol: 'https' } as Record<string, unknown>;
		fillStoredSecrets(c, stored);
		expect(c.hawserToken).toBe('tok-stored');
		expect(c.tlsKey).toBe('key-stored');
	});

	test('a freshly typed secret still wins on the same target', () => {
		const c = { host: '10.0.0.5', port: 2376, protocol: 'https', hawserToken: 'typed' } as Record<string, unknown>;
		fillStoredSecrets(c, stored);
		expect(c.hawserToken).toBe('typed');
	});

	test.each([
		['another host', { host: 'attacker.example', port: 2376, protocol: 'https' }],
		['another port', { host: '10.0.0.5', port: 9999, protocol: 'https' }],
		['plain http instead of https', { host: '10.0.0.5', port: 2376, protocol: 'http' }],
		['no host', { port: 2376, protocol: 'https' }]
	])('%s: no stored secret is attached', (_n, c: Record<string, unknown>) => {
		fillStoredSecrets(c, stored);
		expect(c.hawserToken).toBeUndefined();
		expect(c.tlsKey).toBeUndefined();
	});

	test('defaults on both sides count as the same target', () => {
		const c = { host: 'h' } as Record<string, unknown>;
		fillStoredSecrets(c, { host: 'h', port: null, protocol: null, hawserToken: 't' });
		expect(c.hawserToken).toBe('t');
	});
});

// The route loads docker.ts and the database, so its wiring is pinned in the source.
describe('POST /api/environments/test wiring', () => {
	const src = readFileSync('src/routes/api/environments/test/+server.ts', 'utf8');

	test('reusing stored secrets needs environments:edit on that environment', () => {
		expect(src).toMatch(/!\(await auth\.canAccessEnvironment\(config\.environmentId\)\) \|\|\s+!\(await auth\.can\('environments', 'edit', config\.environmentId\)\)\s+\) \{\s+return json\(/);
	});

	test('stored secrets reach the config only through fillStoredSecrets', () => {
		expect(src).toContain('if (stored) fillStoredSecrets(config, stored);');
		expect(src).not.toMatch(/config\.(hawserToken|tlsKey)\s*=/);
	});
});
