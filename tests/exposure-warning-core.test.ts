import { describe, test, expect } from 'bun:test';
import { isLoopbackHost, shouldWarnExposure } from '../src/lib/server/exposure-warning-core';

describe('isLoopbackHost', () => {
	test('loopback and empty hosts are local', () => {
		for (const h of ['127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST', '', '  ', '0:0:0:0:0:0:0:1']) {
			expect(isLoopbackHost(h)).toBe(true);
		}
	});

	test('a wildcard or routable bind is not local', () => {
		for (const h of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'dockhand.example.com', '116.203.251.106']) {
			expect(isLoopbackHost(h)).toBe(false);
		}
	});
});

describe('shouldWarnExposure', () => {
	const base = { authEnabled: false, host: '0.0.0.0', dockerSocketRW: true as boolean | null };

	test('warns only when all three risk conditions hold (the #1822 config)', () => {
		expect(shouldWarnExposure(base)).toBe(true);
	});

	test('auth enabled never warns', () => {
		expect(shouldWarnExposure({ ...base, authEnabled: true })).toBe(false);
	});

	test('a loopback bind never warns, even with auth off and socket writable', () => {
		expect(shouldWarnExposure({ ...base, host: '127.0.0.1' })).toBe(false);
		expect(shouldWarnExposure({ ...base, host: 'localhost' })).toBe(false);
		expect(shouldWarnExposure({ ...base, host: '' })).toBe(false);
	});

	test('a read-only socket never warns', () => {
		expect(shouldWarnExposure({ ...base, dockerSocketRW: false })).toBe(false);
	});

	test('an unknown socket state never warns (fail-safe, no false alarm)', () => {
		expect(shouldWarnExposure({ ...base, dockerSocketRW: null })).toBe(false);
	});

	test('only two of three is not enough', () => {
		// auth off + routable, but socket not writable
		expect(shouldWarnExposure({ authEnabled: false, host: '0.0.0.0', dockerSocketRW: false })).toBe(false);
		// auth off + writable socket, but loopback
		expect(shouldWarnExposure({ authEnabled: false, host: '127.0.0.1', dockerSocketRW: true })).toBe(false);
		// routable + writable socket, but auth on
		expect(shouldWarnExposure({ authEnabled: true, host: '0.0.0.0', dockerSocketRW: true })).toBe(false);
	});
});
