/**
 * Scanner Advanced settings — network mode + DNS resolver (#1219).
 *
 * Verifies the pure helper that decides which networkMode and DNS values to
 * pass to the scanner container, given (auto-detected, user-override) inputs.
 *
 * Run with: bun test tests/unit/scanner-dns-network.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { resolveScannerOverrides } from '../src/lib/utils/scanner-overrides';

describe('resolveScannerOverrides', () => {
	test('backward-compat baseline: undefined inputs → empty result', () => {
		// Pre-feature behavior: nothing set on HostConfig.
		expect(resolveScannerOverrides({}, {})).toEqual({
			networkMode: undefined,
			dns: undefined,
			extraHosts: undefined
		});
	});

	test('backward-compat with auto-detect: returns auto-detected network', () => {
		// User has not set the new fields. Auto-detection produced 'bridge'.
		// Result must match today's behavior (bridge passed through).
		const result = resolveScannerOverrides(
			{ networkMode: 'bridge', extraHosts: ['internal-registry:10.0.0.5'] },
			{}
		);
		expect(result.networkMode).toBe('bridge');
		expect(result.extraHosts).toEqual(['internal-registry:10.0.0.5']);
		expect(result.dns).toBeUndefined();
	});

	test('user network=host overrides auto-detected network', () => {
		// The #1219 case: user explicitly sets host, beats auto-detected.
		const result = resolveScannerOverrides(
			{ networkMode: 'bridge' },
			{ networkMode: 'host' }
		);
		expect(result.networkMode).toBe('host');
	});

	test('user network="" (UI default) falls back to auto-detected', () => {
		// Select default value is empty string; must not override.
		const result = resolveScannerOverrides(
			{ networkMode: 'bridge' },
			{ networkMode: '' }
		);
		expect(result.networkMode).toBe('bridge');
	});

	test('user network whitespace-only falls back to auto-detected', () => {
		const result = resolveScannerOverrides(
			{ networkMode: 'bridge' },
			{ networkMode: '   ' }
		);
		expect(result.networkMode).toBe('bridge');
	});

	test('user DNS set is passed through', () => {
		const result = resolveScannerOverrides(
			{},
			{ dns: ['1.1.1.1', '8.8.8.8'] }
		);
		expect(result.dns).toEqual(['1.1.1.1', '8.8.8.8']);
	});

	test('user DNS empty array → undefined (not empty array)', () => {
		// Empty array would cause `if (options.dns)` to skip the field too, but we
		// want a clean `undefined` for type symmetry and to avoid edge cases.
		const result = resolveScannerOverrides({}, { dns: [] });
		expect(result.dns).toBeUndefined();
	});

	test('user DNS undefined → undefined', () => {
		const result = resolveScannerOverrides({}, {});
		expect(result.dns).toBeUndefined();
	});

	test('user DNS trims whitespace and drops empty entries', () => {
		const result = resolveScannerOverrides(
			{},
			{ dns: ['  1.1.1.1  ', '', '   ', '8.8.8.8'] }
		);
		expect(result.dns).toEqual(['1.1.1.1', '8.8.8.8']);
	});

	test('user DNS all-empty after trimming → undefined', () => {
		const result = resolveScannerOverrides(
			{},
			{ dns: ['', '   ', ''] }
		);
		expect(result.dns).toBeUndefined();
	});

	test('user network + dns: both applied', () => {
		const result = resolveScannerOverrides(
			{},
			{ networkMode: 'host', dns: ['1.1.1.1'] }
		);
		expect(result).toEqual({
			networkMode: 'host',
			dns: ['1.1.1.1'],
			extraHosts: undefined
		});
	});

	test('extraHosts preserved from auto-detect when present', () => {
		const result = resolveScannerOverrides(
			{ networkMode: 'bridge', extraHosts: ['foo:1.2.3.4'] },
			{ networkMode: 'host' }
		);
		expect(result.extraHosts).toEqual(['foo:1.2.3.4']);
		expect(result.networkMode).toBe('host');
	});

	test('extraHosts empty array → undefined (no field set on HostConfig)', () => {
		const result = resolveScannerOverrides(
			{ networkMode: 'bridge', extraHosts: [] },
			{}
		);
		expect(result.extraHosts).toBeUndefined();
	});

	test('garbage DNS strings kept (Docker daemon validates)', () => {
		// We don't validate IP format strictly — the Docker daemon rejects bad
		// input with a clear error. This test pins that behavior so we don't
		// accidentally add over-strict validation later.
		const result = resolveScannerOverrides(
			{},
			{ dns: ['not-an-ip', '1.2.3.4'] }
		);
		expect(result.dns).toEqual(['not-an-ip', '1.2.3.4']);
	});

	test('custom network name as user override (not just host/bridge/none)', () => {
		// Free-form is allowed — users with custom Docker networks should be able
		// to put the scanner on a named bridge.
		const result = resolveScannerOverrides({}, { networkMode: 'my-internal-net' });
		expect(result.networkMode).toBe('my-internal-net');
	});
});
