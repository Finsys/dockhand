/**
 * Unit Tests for Utility Functions
 *
 * Tests pure utility functions that require no mocking or external dependencies.
 * Covers: version.ts, diff.ts, ip.ts
 */
import { describe, test, expect } from 'bun:test';
import { compareVersions, shouldShowWhatsNew } from '../src/lib/utils/version';
import { computeAuditDiff, formatFieldName } from '../src/lib/utils/diff';
import { ipToNumber } from '../src/lib/utils/ip';

// =============================================================================
// version.ts
// =============================================================================

describe('compareVersions', () => {
	test('equal versions return 0', () => {
		expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
		expect(compareVersions('0.0.0', '0.0.0')).toBe(0);
		expect(compareVersions('10.20.30', '10.20.30')).toBe(0);
	});

	test('greater version returns 1', () => {
		expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
		expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
		expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
	});

	test('lesser version returns -1', () => {
		expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
		expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
		expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
	});

	test('handles v-prefix', () => {
		expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
		expect(compareVersions('v2.0.0', 'v1.0.0')).toBe(1);
		expect(compareVersions('v1.0.0', 'v2.0.0')).toBe(-1);
	});

	test('handles different segment lengths', () => {
		expect(compareVersions('1.0', '1.0.0')).toBe(0);
		expect(compareVersions('1.0.0', '1.0')).toBe(0);
		expect(compareVersions('1.0.1', '1.0')).toBe(1);
		expect(compareVersions('1.0', '1.0.1')).toBe(-1);
	});

	test('handles multi-digit segments', () => {
		expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
		expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
	});
});

describe('shouldShowWhatsNew', () => {
	test('returns false when currentVersion is null', () => {
		expect(shouldShowWhatsNew(null, null)).toBe(false);
		expect(shouldShowWhatsNew(null, '1.0.0')).toBe(false);
	});

	test('returns false when currentVersion is "unknown"', () => {
		expect(shouldShowWhatsNew('unknown', null)).toBe(false);
		expect(shouldShowWhatsNew('unknown', '1.0.0')).toBe(false);
	});

	test('returns true when lastSeenVersion is null (first visit)', () => {
		expect(shouldShowWhatsNew('1.0.0', null)).toBe(true);
	});

	test('returns false when same version', () => {
		expect(shouldShowWhatsNew('1.0.0', '1.0.0')).toBe(false);
	});

	test('returns true when current version is newer', () => {
		expect(shouldShowWhatsNew('1.1.0', '1.0.0')).toBe(true);
		expect(shouldShowWhatsNew('2.0.0', '1.9.9')).toBe(true);
	});

	test('returns false when current version is older', () => {
		expect(shouldShowWhatsNew('1.0.0', '1.1.0')).toBe(false);
	});
});

// =============================================================================
// diff.ts
// =============================================================================

describe('computeAuditDiff', () => {
	test('returns null for null/undefined inputs', () => {
		expect(computeAuditDiff(null, { a: 1 })).toBeNull();
		expect(computeAuditDiff({ a: 1 }, null)).toBeNull();
		expect(computeAuditDiff(undefined, { a: 1 })).toBeNull();
		expect(computeAuditDiff(null, null)).toBeNull();
	});

	test('returns null for identical objects', () => {
		expect(computeAuditDiff({ name: 'foo' }, { name: 'foo' })).toBeNull();
		expect(computeAuditDiff({ a: 1, b: 2 }, { a: 1, b: 2 })).toBeNull();
	});

	test('detects changed fields', () => {
		const result = computeAuditDiff({ name: 'old' }, { name: 'new' });
		expect(result).not.toBeNull();
		expect(result!.changes).toHaveLength(1);
		expect(result!.changes[0]).toEqual({ field: 'name', oldValue: 'old', newValue: 'new' });
	});

	test('detects added fields', () => {
		const result = computeAuditDiff({}, { name: 'new' });
		expect(result).not.toBeNull();
		expect(result!.changes[0].field).toBe('name');
		expect(result!.changes[0].oldValue).toBeNull();
		expect(result!.changes[0].newValue).toBe('new');
	});

	test('skips internal fields (id, createdAt, updatedAt)', () => {
		const result = computeAuditDiff(
			{ id: 1, createdAt: 'old', updatedAt: 'old', name: 'same' },
			{ id: 2, createdAt: 'new', updatedAt: 'new', name: 'same' }
		);
		expect(result).toBeNull();
	});

	test('masks sensitive fields (password)', () => {
		const result = computeAuditDiff(
			{ password: 'old-secret' },
			{ password: 'new-secret' }
		);
		expect(result).not.toBeNull();
		expect(result!.changes[0]).toEqual({
			field: 'password',
			oldValue: '••••••••',
			newValue: '••••••••'
		});
	});

	test('masks sensitive field set to null', () => {
		const result = computeAuditDiff(
			{ password: 'secret' },
			{ password: null }
		);
		expect(result).not.toBeNull();
		expect(result!.changes[0].oldValue).toBe('••••••••');
		expect(result!.changes[0].newValue).toBeNull();
	});

	test('masks sensitive field set from null', () => {
		const result = computeAuditDiff(
			{ password: null },
			{ password: 'secret' }
		);
		expect(result).not.toBeNull();
		expect(result!.changes[0].oldValue).toBeNull();
		expect(result!.changes[0].newValue).toBe('••••••••');
	});

	test('skips fields in SENSITIVE_FIELDS that are not MASKED (like tlsCert, tlsCa)', () => {
		const result = computeAuditDiff(
			{ tlsCert: 'old-cert' },
			{ tlsCert: 'new-cert' }
		);
		// tlsCert is in SENSITIVE_FIELDS but not in MASKED_FIELDS → skipped entirely
		expect(result).toBeNull();
	});

	test('respects includeFields option', () => {
		const result = computeAuditDiff(
			{ name: 'old', host: 'old-host' },
			{ name: 'new', host: 'new-host' },
			{ includeFields: ['name'] }
		);
		expect(result).not.toBeNull();
		expect(result!.changes).toHaveLength(1);
		expect(result!.changes[0].field).toBe('name');
	});

	test('respects excludeFields option', () => {
		const result = computeAuditDiff(
			{ name: 'old', host: 'old-host' },
			{ name: 'new', host: 'new-host' },
			{ excludeFields: ['host'] }
		);
		expect(result).not.toBeNull();
		expect(result!.changes).toHaveLength(1);
		expect(result!.changes[0].field).toBe('name');
	});

	test('skips undefined new values', () => {
		const result = computeAuditDiff(
			{ name: 'old', host: 'old-host' },
			{ name: 'new' } // host is undefined in new
		);
		expect(result).not.toBeNull();
		expect(result!.changes).toHaveLength(1);
		expect(result!.changes[0].field).toBe('name');
	});

	test('handles deep equality for arrays', () => {
		expect(computeAuditDiff(
			{ tags: ['a', 'b'] },
			{ tags: ['a', 'b'] }
		)).toBeNull();

		const result = computeAuditDiff(
			{ tags: ['a', 'b'] },
			{ tags: ['a', 'c'] }
		);
		expect(result).not.toBeNull();
	});

	test('handles deep equality for nested objects', () => {
		expect(computeAuditDiff(
			{ config: { port: 80, host: 'localhost' } },
			{ config: { port: 80, host: 'localhost' } }
		)).toBeNull();

		const result = computeAuditDiff(
			{ config: { port: 80 } },
			{ config: { port: 443 } }
		);
		expect(result).not.toBeNull();
	});

	test('truncates long string values in diff output', () => {
		const longString = 'x'.repeat(300);
		const result = computeAuditDiff(
			{ data: 'short' },
			{ data: longString }
		);
		expect(result).not.toBeNull();
		expect(result!.changes[0].newValue.length).toBeLessThan(longString.length);
		expect(result!.changes[0].newValue).toContain('...');
	});

	test('summarizes large arrays', () => {
		const largeArray = Array.from({ length: 15 }, (_, i) => `item-${i}`);
		const result = computeAuditDiff(
			{ items: [] },
			{ items: largeArray }
		);
		expect(result).not.toBeNull();
		expect(result!.changes[0].newValue).toBe('[15 items]');
	});

	test('summarizes objects with many properties', () => {
		const largeObj: Record<string, number> = {};
		for (let i = 0; i < 15; i++) largeObj[`key${i}`] = i;
		const result = computeAuditDiff(
			{ config: {} },
			{ config: largeObj }
		);
		expect(result).not.toBeNull();
		expect(result!.changes[0].newValue).toBe('{15 properties}');
	});
});

describe('formatFieldName', () => {
	test('converts camelCase to Title Case', () => {
		expect(formatFieldName('userName')).toBe('User Name');
		expect(formatFieldName('firstName')).toBe('First Name');
	});

	test('handles special cases', () => {
		expect(formatFieldName('tlsCa')).toBe('TLS CA');
		expect(formatFieldName('tlsCert')).toBe('TLS certificate');
		expect(formatFieldName('tlsKey')).toBe('TLS key');
		expect(formatFieldName('sshPrivateKey')).toBe('SSH private key');
		expect(formatFieldName('envVars')).toBe('Environment variables');
		expect(formatFieldName('ipAddress')).toBe('IP address');
		expect(formatFieldName('connectionType')).toBe('Connection type');
		expect(formatFieldName('socketPath')).toBe('Socket path');
	});

	test('handles single-word fields', () => {
		expect(formatFieldName('name')).toBe('Name');
		expect(formatFieldName('host')).toBe('Host');
	});
});

// =============================================================================
// ip.ts
// =============================================================================

describe('ipToNumber', () => {
	test('converts standard IPv4 addresses', () => {
		expect(ipToNumber('0.0.0.0')).toBe(0);
		expect(ipToNumber('0.0.0.1')).toBe(1);
		expect(ipToNumber('10.0.0.1')).toBe(167772161);
		expect(ipToNumber('192.168.1.1')).toBe(3232235777);
		expect(ipToNumber('255.255.255.255')).toBe(4294967295);
	});

	test('strips CIDR notation', () => {
		expect(ipToNumber('192.168.1.0/24')).toBe(ipToNumber('192.168.1.0'));
		expect(ipToNumber('10.0.0.0/8')).toBe(ipToNumber('10.0.0.0'));
	});

	test('returns Infinity for null/undefined/empty', () => {
		expect(ipToNumber(null)).toBe(Infinity);
		expect(ipToNumber(undefined)).toBe(Infinity);
		expect(ipToNumber('-')).toBe(Infinity);
	});

	test('returns Infinity for invalid IPs', () => {
		expect(ipToNumber('not-an-ip')).toBe(Infinity);
		expect(ipToNumber('1.2.3')).toBe(Infinity);
		expect(ipToNumber('1.2.3.4.5')).toBe(Infinity);
	});

	test('maintains sort order', () => {
		expect(ipToNumber('10.0.0.1')).toBeLessThan(ipToNumber('10.0.0.2'));
		expect(ipToNumber('10.0.0.255')).toBeLessThan(ipToNumber('10.0.1.0'));
		expect(ipToNumber('192.168.0.1')).toBeGreaterThan(ipToNumber('10.0.0.1'));
	});
});
