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

	test('strips git program-runner vars (GIT_SSH_COMMAND, GIT_PROXY_COMMAND)', () => {
		// git runs $GIT_PROXY_COMMAND for a git:// remote and GIT_SSH_COMMAND for ssh,
		// so a compose include: pointing at such a remote would run it in the child.
		const out = stripReservedEnvKeys({
			GIT_SSH: '/tmp/s', GIT_SSH_COMMAND: '/tmp/x', GIT_EXEC_PATH: '/tmp/e',
			GIT_PROXY_COMMAND: '/bin/sh', OK: 'y'
		});
		expect(Object.keys(out)).toEqual(['OK']);
	});

	test('strips DOCKER_* daemon-targeting vars a stack must not override', () => {
		const out = stripReservedEnvKeys({ DOCKER_HOST: 'tcp://evil:2375', DOCKER_CONFIG: '/tmp', APP_PORT: '8080' });
		expect(out.DOCKER_HOST).toBeUndefined();
		expect(out.DOCKER_CONFIG).toBeUndefined();
		expect(out.APP_PORT).toBe('8080');
	});

	test('strips HOME and BUILDX_CONFIG, which steer where the docker CLI finds its plugins', () => {
		const out = stripReservedEnvKeys({ HOME: '/data/stacks/x', BUILDX_CONFIG: '/tmp/b', HOMEPAGE_URL: 'https://x', APP_HOME: '/app' });
		expect(out).toEqual({ HOMEPAGE_URL: 'https://x', APP_HOME: '/app' });
	});

	test("strips git's configuration-by-environment family (GIT_CONFIG_*)", () => {
		const out = stripReservedEnvKeys({
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: 'protocol.allow',
			GIT_CONFIG_VALUE_0: 'always',
			GIT_CONFIG_KEY_1: 'url.ext::sh -c id.insteadOf',
			GIT_CONFIG_VALUE_1: 'git@example.invalid:any/repo.git',
			GIT_CONFIG_PARAMETERS: "'protocol.allow'='always'",
			GIT_CONFIG_GLOBAL: '/tmp/gitconfig',
			GIT_CONFIG_SYSTEM: '/tmp/system-gitconfig',
			// near-misses that are NOT the config family and must survive
			GIT_CONFIGURED_THING: 'kept',
			MY_GIT_CONFIG_DIR: 'kept'
		});
		expect(Object.keys(out).sort()).toEqual(['GIT_CONFIGURED_THING', 'MY_GIT_CONFIG_DIR']);
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
