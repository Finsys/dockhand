/**
 * REGISTRY_REQUEST_TIMEOUT bounds every registry request of an update check: the
 * digest read and both tag listings give up on a registry that never answers.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registryRequestSignal, registryRequestTimeoutMs } from '../src/lib/server/registry/request-timeout';

describe('REGISTRY_REQUEST_TIMEOUT', () => {
	test('a 1 s setting cuts off the digest read and both tag listings', () => {
		const result = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/registry-timeout-probe.ts', import.meta.url))], {
			cwd: fileURLToPath(new URL('..', import.meta.url)),
			encoding: 'utf8',
			timeout: 15000,
			env: { ...process.env, REGISTRY_REQUEST_TIMEOUT: '1' }
		});
		expect(result.status).toBe(0);
		const out = JSON.parse(result.stdout.trim().split('\n').pop()!);

		expect(out.hub.error).toBe('TimeoutError');
		expect(out.v2.error).toBe('TimeoutError');
		expect(out.digest.value).toEqual({ digest: null, reason: 'Registry did not answer in time: ghcr.io' });
		// The digest read is a challenge then a manifest HEAD, each with its own second.
		for (const ms of [out.hub.ms, out.v2.ms]) expect(ms).toBeGreaterThanOrEqual(900);
		for (const ms of [out.hub.ms, out.v2.ms]) expect(ms).toBeLessThan(3000);
		expect(out.digest.ms).toBeLessThan(3000);
		expect(out.authSignal).toBe(true);
	});

	test('unset is the 10 s default; whole seconds 1-600 are taken as seconds', () => {
		expect(registryRequestTimeoutMs(undefined)).toBe(10_000);
		expect(registryRequestTimeoutMs('')).toBe(10_000);
		expect(registryRequestTimeoutMs('30')).toBe(30_000);
		expect(registryRequestTimeoutMs('1')).toBe(1_000);
		expect(registryRequestTimeoutMs('600')).toBe(600_000);
	});

	test('anything else falls back to the default instead of disabling the timeout', () => {
		for (const bad of ['0', '-5', '601', '2.5', 'abc', '30s']) expect(registryRequestTimeoutMs(bad)).toBe(10_000);
	});
});

describe('registryRequestSignal', () => {
	test('a live caller signal does not switch the timeout off', async () => {
		const caller = new AbortController();
		const signal = registryRequestSignal(caller.signal, 20);
		await new Promise((r) => setTimeout(r, 60));
		expect(signal.aborted).toBe(true);
		expect(caller.signal.aborted).toBe(false);
	});

	test('the caller cancelling aborts the request before the timeout', () => {
		const caller = new AbortController();
		const signal = registryRequestSignal(caller.signal, 60_000);
		caller.abort();
		expect(signal.aborted).toBe(true);
	});
});
