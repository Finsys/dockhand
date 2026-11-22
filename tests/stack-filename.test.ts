/**
 * isAllowedStackFilename unit tests (#1196).
 *
 * v1.0.34 locked stack writes to a hardcoded set of names (docker-compose.yml,
 * compose.yml, .env) which broke users who name their compose files after
 * the service (e.g. headscale.yml). v1.0.35 relaxes to any .yml / .yaml file
 * plus the .env family.
 *
 * The regex is the only thing standing between the API and writing files
 * with arbitrary extensions, so it gets a focused unit test rather than
 * relying on integration coverage.
 */
import { describe, expect, test } from 'bun:test';
import { isAllowedStackFilename } from '../src/lib/server/stack-filename';

describe('isAllowedStackFilename', () => {
	test.each([
		// Conventional compose names
		['docker-compose.yml'],
		['docker-compose.yaml'],
		['compose.yml'],
		['compose.yaml'],
		// Custom compose names per service (the #1196 case)
		['headscale.yml'],
		['nginx.yaml'],
		['my-custom-thing.yml'],
		// Env file family
		['.env'],
		['.env.local'],
		['.env.production'],
		['prod.env'],
		['staging.env'],
		['prod.env.staging'],
		['.env.prod-eu_1'],
		['.env.production.local'],
		['.env.development.local']
	])('accepts %s', (filename: string) => {
		expect(isAllowedStackFilename(filename)).toBe(true);
	});

	test.each([
		// Shell / executable
		['payload.sh'],
		['evil.bash'],
		// SSH key target
		['authorized_keys'],
		// Cron / systemd files
		['crontab'],
		['my.service'],
		// Web / config files
		['nginx.conf'],
		['index.html'],
		// Plain extensions not in our allowlist
		['data.json'],
		['readme.md'],
		// No extension
		['Caddyfile'],
		// Empty / whitespace
		[''],
		[' '],
		// Tricks: .yml in the middle, not at the end
		['compose.yml.bak'],
		// .env in the middle
		['environment'],
		['notenv'],
		// env-family names a runtime loads as code (Dockhand's own build/env.js)
		['env.js'],
		['handler.env.js'],
		['.env.mjs'],
		['env.cjs'],
		['env.ts'],
		['env.json'],
		['env.node'],
		['env.sh'],
		['env.JS'],
		['.env.local.js'],
		// a suffix with a path-ish or odd character
		['.env.a b']
	])('rejects %s', (filename: string) => {
		expect(isAllowedStackFilename(filename)).toBe(false);
	});
});

describe('isAllowedStackFilename on long input', () => {
	test('a name past NAME_MAX is refused at once', () => {
		const start = performance.now();
		expect(isAllowedStackFilename('.env.a'.repeat(20000) + '!')).toBe(false);
		expect(isAllowedStackFilename('.env' + '.a'.repeat(200))).toBe(false);
		expect(performance.now() - start).toBeLessThan(100);
	});

	test('a long legal name up to 255 characters still passes', () => {
		const name = '.env.' + 'x'.repeat(250);
		expect(name.length).toBe(255);
		expect(isAllowedStackFilename(name)).toBe(true);
		expect(isAllowedStackFilename(name + 'x')).toBe(false);
	});
});
