import { describe, test, expect } from 'bun:test';
import { stripReservedEnvKeys } from '../src/lib/server/env-key-guard';

describe('stripReservedEnvKeys - blocks loader/PATH hijack via stack env vars', () => {
	test('strips PATH (the RCE vector)', () => {
		const out = stripReservedEnvKeys({ PATH: '/tmp/evil', FOO: 'bar' });
		expect(out.PATH).toBeUndefined();
		expect(out.FOO).toBe('bar');
	});

	test('strips the dynamic-loader family (LD_* and DYLD_*)', () => {
		const out = stripReservedEnvKeys({
			LD_PRELOAD: '/tmp/x.so',
			LD_LIBRARY_PATH: '/tmp',
			LD_AUDIT: '/tmp/a.so',
			DYLD_INSERT_LIBRARIES: '/tmp/y.dylib',
			KEEP: '1'
		});
		expect(Object.keys(out)).toEqual(['KEEP']);
	});

	test('strips shell-startup and node-option vectors', () => {
		const out = stripReservedEnvKeys({ BASH_ENV: '/tmp/b', ENV: '/tmp/e', NODE_OPTIONS: '--require /tmp/x', IFS: ' ', SHELL: '/tmp/sh', OK: 'y' });
		expect(Object.keys(out)).toEqual(['OK']);
	});

	test('strips DOCKER_* daemon-targeting vars a stack must not override', () => {
		const out = stripReservedEnvKeys({ DOCKER_HOST: 'tcp://evil:2375', DOCKER_CONFIG: '/tmp', APP_PORT: '8080' });
		expect(out.DOCKER_HOST).toBeUndefined();
		expect(out.DOCKER_CONFIG).toBeUndefined();
		expect(out.APP_PORT).toBe('8080');
	});

	test('keeps ordinary application env vars untouched', () => {
		const vars = { DATABASE_URL: 'postgres://x', API_KEY: 'secret', MY_PATH_SETTING: '/app', PATHOLOGY: 'ok' };
		// near-misses: MY_PATH_SETTING and PATHOLOGY are NOT PATH and must survive
		expect(stripReservedEnvKeys(vars)).toEqual(vars);
	});

	test('null/undefined input yields an empty object', () => {
		expect(stripReservedEnvKeys(undefined)).toEqual({});
		expect(stripReservedEnvKeys(null)).toEqual({});
	});
});
