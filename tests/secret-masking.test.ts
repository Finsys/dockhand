/**
 * Secret Masking Logic Tests
 *
 * Unit tests for the env var masking logic used in container inspect endpoints.
 * Tests key-based matching and compose interpolation parsing.
 *
 * Run with: bun test tests/unit/secret-masking.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { parseEnvInterpolation } from '../src/lib/server/env-interpolation';

/**
 * Mirrors the masking logic from containers/[id]/inspect/+server.ts
 */
function maskEnvVars(envEntries: string[], secretKeys: Set<string>): string[] {
	return envEntries.map((entry) => {
		const eqIdx = entry.indexOf('=');
		if (eqIdx === -1) return entry;
		const key = entry.substring(0, eqIdx);
		if (secretKeys.has(key)) {
			return `${key}=***`;
		}
		return entry;
	});
}

/**
 * Simulates getSecretKeysToMask: combines DB secret keys with provider-injected
 * key names and interpolation mappings. Mirrors the real merge order in
 * db.ts::getSecretKeysToMask (DB secrets + injected, THEN interpolation).
 */
function buildMaskSet(
	dbSecretKeys: string[],
	composeContent?: string,
	injectedProviderKeys: string[] = []
): Set<string> {
	const keys = new Set(dbSecretKeys);
	for (const k of injectedProviderKeys) keys.add(k);
	if (composeContent) {
		const interpolated = parseEnvInterpolation(composeContent);
		for (const [containerKey, varName] of interpolated) {
			if (keys.has(varName)) {
				keys.add(containerKey);
			}
		}
	}
	return keys;
}

// ─── parseEnvInterpolation ─────────────────────────────────────────

describe('parseEnvInterpolation', () => {
	test('extracts simple interpolation', () => {
		const compose = `services:
  app:
    environment:
      - MYSQL_PASSWORD=\${db_secret}
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([['MYSQL_PASSWORD', 'db_secret']]);
	});

	test('extracts interpolation with default value', () => {
		const compose = `services:
  app:
    environment:
      - DB_HOST=\${database_host:-localhost}
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([['DB_HOST', 'database_host']]);
	});

	test('extracts interpolation with error message', () => {
		const compose = `services:
  app:
    environment:
      - API_KEY=\${secret_key?API key is required}
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([['API_KEY', 'secret_key']]);
	});

	test('extracts interpolation with alternate value', () => {
		const compose = `services:
  app:
    environment:
      - USE_SSL=\${ssl_enabled:+true}
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([['USE_SSL', 'ssl_enabled']]);
	});

	test('extracts interpolation with short fallback (no colon)', () => {
		const compose = `services:
  app:
    environment:
      - DB_HOST=\${database_host-localhost}
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([['DB_HOST', 'database_host']]);
	});

	test('extracts interpolation with required error (colon question)', () => {
		const compose = `services:
  app:
    environment:
      - API_KEY=\${secret_key:?API key must be set}
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([['API_KEY', 'secret_key']]);
	});

	test('skips same-name interpolation', () => {
		const compose = `services:
  app:
    environment:
      - DB_PASS=\${DB_PASS}
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([]);
	});

	test('extracts multiple interpolations', () => {
		const compose = `services:
  app:
    environment:
      - MYSQL_USER=\${db_user}
      - MYSQL_PASSWORD=\${db_pass}
      - APP_NAME=myapp
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([
			['MYSQL_USER', 'db_user'],
			['MYSQL_PASSWORD', 'db_pass']
		]);
	});

	test('ignores non-environment lines', () => {
		const compose = `services:
  app:
    image: \${IMAGE_NAME}
    command: echo \${GREETING}
    environment:
      - REAL_VAR=\${secret_ref}
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([['REAL_VAR', 'secret_ref']]);
	});

	test('handles multiple services', () => {
		const compose = `services:
  web:
    environment:
      - WEB_SECRET=\${shared_secret}
  worker:
    environment:
      - WORKER_TOKEN=\${api_token}
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([
			['WEB_SECRET', 'shared_secret'],
			['WORKER_TOKEN', 'api_token']
		]);
	});

	test('handles empty compose', () => {
		expect(parseEnvInterpolation('')).toEqual([]);
	});

	test('handles compose without environment section', () => {
		const compose = `services:
  app:
    image: nginx:alpine
    ports:
      - "80:80"
`;
		expect(parseEnvInterpolation(compose)).toEqual([]);
	});

	test('extracts multiple vars from one line', () => {
		const compose = `services:
  app:
    environment:
      - DB_URL=postgres://\${db_user}:\${db_pass}@host/db
`;
		const result = parseEnvInterpolation(compose);
		expect(result).toEqual([
			['DB_URL', 'db_user'],
			['DB_URL', 'db_pass']
		]);
	});
});

// ─── buildMaskSet (simulates getSecretKeysToMask) ──────────────────

describe('buildMaskSet: key + interpolation', () => {
	test('direct key match only (no compose)', () => {
		const keys = buildMaskSet(['DB_PASS', 'API_KEY']);
		expect(keys.has('DB_PASS')).toBe(true);
		expect(keys.has('API_KEY')).toBe(true);
		expect(keys.has('OTHER')).toBe(false);
	});

	test('adds interpolated container keys from compose', () => {
		const compose = `services:
  app:
    environment:
      - MYSQL_PASSWORD=\${db_secret}
      - APP_TOKEN=\${api_key}
`;
		const keys = buildMaskSet(['db_secret', 'api_key'], compose);
		// Direct keys
		expect(keys.has('db_secret')).toBe(true);
		expect(keys.has('api_key')).toBe(true);
		// Interpolated container keys
		expect(keys.has('MYSQL_PASSWORD')).toBe(true);
		expect(keys.has('APP_TOKEN')).toBe(true);
	});

	test('does not add interpolated keys for non-secret vars', () => {
		const compose = `services:
  app:
    environment:
      - HOST_NAME=\${hostname}
      - DB_PASS=\${secret_pw}
`;
		// Only secret_pw is a secret, not hostname
		const keys = buildMaskSet(['secret_pw'], compose);
		expect(keys.has('DB_PASS')).toBe(true);
		expect(keys.has('HOST_NAME')).toBe(false);
	});

	test('handles compose without interpolation', () => {
		const compose = `services:
  app:
    environment:
      - APP_NAME=myapp
      - PORT=3000
`;
		const keys = buildMaskSet(['DB_PASS'], compose);
		expect(keys.has('DB_PASS')).toBe(true);
		expect(keys.size).toBe(1);
	});
});

// ─── Provider-injected keys (H1) ───────────────────────────────────
// Bulk-pulled keys (Vault/Doppler) and promoted op:// refs live only in the
// provider, never in stack_env_vars, so getSecretKeysToMask merges the names
// persisted at deploy. Without that merge they leak plaintext in inspect.

describe('buildMaskSet: provider-injected keys', () => {
	test('masks bulk-pulled keys that are NOT in the DB', () => {
		// No DB secret rows at all - keys came entirely from a Vault bulk pull.
		const keys = buildMaskSet([], undefined, ['DB_PASSWORD', 'REDIS_URL']);
		expect(keys.has('DB_PASSWORD')).toBe(true);
		expect(keys.has('REDIS_URL')).toBe(true);
	});

	test('masks a promoted op:// ref key alongside DB secrets', () => {
		const keys = buildMaskSet(['DB_PASS'], undefined, ['API_KEY']);
		expect(keys.has('DB_PASS')).toBe(true); // DB secret
		expect(keys.has('API_KEY')).toBe(true); // promoted from .env op:// ref
	});

	test('injected keys still drive compose interpolation masking', () => {
		// A bulk key `db_secret` is referenced by a container var via ${db_secret}.
		const compose = `services:
  app:
    environment:
      - MYSQL_PASSWORD=\${db_secret}
`;
		const keys = buildMaskSet([], compose, ['db_secret']);
		expect(keys.has('db_secret')).toBe(true);
		expect(keys.has('MYSQL_PASSWORD')).toBe(true);
	});

	test('the leak case: WITHOUT injected keys a Vault secret is exposed', () => {
		// Same container env, but the injected-keys merge is skipped (old behavior).
		const leaky = buildMaskSet([], undefined, []);
		const masked = maskEnvVars(['DB_PASSWORD=fromVault'], leaky);
		expect(masked).toEqual(['DB_PASSWORD=fromVault']); // plaintext leaks
		// With the merge, it is masked.
		const safe = buildMaskSet([], undefined, ['DB_PASSWORD']);
		expect(maskEnvVars(['DB_PASSWORD=fromVault'], safe)).toEqual(['DB_PASSWORD=***']);
	});
});

// ─── Full masking pipeline ─────────────────────────────────────────

describe('maskEnvVars with interpolation-aware keys', () => {
	test('masks direct secret keys', () => {
		const keys = buildMaskSet(['DB_PASS']);
		const result = maskEnvVars(
			['DB_PASS=secret123', 'APP_NAME=myapp'],
			keys
		);
		expect(result).toEqual(['DB_PASS=***', 'APP_NAME=myapp']);
	});

	test('masks interpolated secret keys', () => {
		const compose = `services:
  app:
    environment:
      - MYSQL_PASSWORD=\${db_secret}
`;
		const keys = buildMaskSet(['db_secret'], compose);
		const result = maskEnvVars(
			['MYSQL_PASSWORD=hunter2', 'APP_NAME=myapp', 'db_secret=hunter2'],
			keys
		);
		expect(result).toEqual(['MYSQL_PASSWORD=***', 'APP_NAME=myapp', 'db_secret=***']);
	});

	test('does not mask unrelated vars', () => {
		const compose = `services:
  app:
    environment:
      - MYSQL_PASSWORD=\${db_secret}
`;
		const keys = buildMaskSet(['db_secret'], compose);
		const result = maskEnvVars(
			['PATH=/usr/bin', 'NODE_ENV=production', 'PORT=3000'],
			keys
		);
		expect(result).toEqual(['PATH=/usr/bin', 'NODE_ENV=production', 'PORT=3000']);
	});

	test('no false positives on matching values', () => {
		// Even though PORT has value "3000" which could appear elsewhere,
		// it should NOT be masked because there's no key or interpolation match
		const keys = buildMaskSet(['SECRET_KEY']);
		const result = maskEnvVars(
			['PORT=3000', 'SECRET_KEY=3000'],
			keys
		);
		expect(result).toEqual(['PORT=3000', 'SECRET_KEY=***']);
	});
});
