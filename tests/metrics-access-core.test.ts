// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { metricsPublicFromEnv } from '../src/lib/server/metrics-access-core';

describe('metricsPublicFromEnv is default-off and fail-closed (#1698)', () => {
	test('unset or empty keeps /metrics authenticated', () => {
		expect(metricsPublicFromEnv(undefined)).toBe(false);
		expect(metricsPublicFromEnv('')).toBe(false);
	});

	test('only the exact string "true" opens it', () => {
		expect(metricsPublicFromEnv('true')).toBe(true);
	});

	test('any other truthy-looking value does NOT open it (strict opt-in)', () => {
		// A typo must never expose the endpoint.
		for (const v of ['1', 'yes', 'TRUE', 'True', 'on', 'enabled', ' true', 'true ']) {
			expect(metricsPublicFromEnv(v)).toBe(false);
		}
	});

	test('explicit false stays closed', () => {
		expect(metricsPublicFromEnv('false')).toBe(false);
	});
});

describe('both enforcement points honour the flag (source-pinned, #1698)', () => {
	// hooks.server.ts and src/routes/metrics/+server.ts transitively import
	// better-sqlite3, which bun cannot load, so the wiring is pinned at the source
	// level (the pattern tests/env-file-values.test.ts uses). A black-box HTTP test
	// of /metrics would be the stronger proof; these catch a widened/dropped guard.
	const read = (p: string) => require('node:fs').readFileSync(p, 'utf8');

	test('the hooks gate forwards the real METRICS_PUBLIC flag, not a hard-coded true', () => {
		const src = read('src/hooks.server.ts');
		expect(src).toContain('isPublicPath(event.url.pathname, METRICS_PUBLIC)');
		// A widened call that unconditionally opens the path must not be present.
		expect(src).not.toContain('isPublicPath(event.url.pathname, true)');
	});

	test('the /metrics handler keeps the !METRICS_PUBLIC term in its 401 check', () => {
		const src = read('src/routes/metrics/+server.ts');
		expect(src).toContain('auth.authEnabled && !auth.isAuthenticated && !METRICS_PUBLIC');
	});
});
