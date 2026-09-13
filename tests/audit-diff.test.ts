import { describe, test, expect } from 'bun:test';
import { computeAuditDiff, formatFieldName } from '../src/lib/utils/diff';

describe('computeAuditDiff', () => {
	test('returns null when no changes', () => {
		expect(computeAuditDiff({ name: 'foo' }, { name: 'foo' })).toBeNull();
	});

	test('returns null for null inputs', () => {
		expect(computeAuditDiff(null, { name: 'foo' })).toBeNull();
		expect(computeAuditDiff({ name: 'foo' }, null)).toBeNull();
	});

	test('detects simple field change', () => {
		const diff = computeAuditDiff({ name: 'old' }, { name: 'new' });
		expect(diff).not.toBeNull();
		expect(diff!.changes).toHaveLength(1);
		expect(diff!.changes[0]).toEqual({ field: 'name', oldValue: 'old', newValue: 'new' });
	});

	test('detects added field', () => {
		const diff = computeAuditDiff({ name: 'foo' }, { name: 'foo', host: 'localhost' });
		expect(diff).not.toBeNull();
		expect(diff!.changes[0].field).toBe('host');
	});

	test('skips internal fields (id, createdAt, updatedAt)', () => {
		const diff = computeAuditDiff(
			{ id: 1, name: 'foo', createdAt: 'old', updatedAt: 'old' },
			{ id: 2, name: 'foo', createdAt: 'new', updatedAt: 'new' }
		);
		expect(diff).toBeNull();
	});

	test('masks sensitive fields', () => {
		const diff = computeAuditDiff({ password: 'old-pass' }, { password: 'new-pass' });
		expect(diff).not.toBeNull();
		expect(diff!.changes[0].oldValue).toBe('••••••••');
		expect(diff!.changes[0].newValue).toBe('••••••••');
	});

	test('shows masked field set to null', () => {
		const diff = computeAuditDiff({ password: 'secret' }, { password: null });
		expect(diff).not.toBeNull();
		expect(diff!.changes[0].oldValue).toBe('••••••••');
		expect(diff!.changes[0].newValue).toBeNull();
	});

	test('respects includeFields option', () => {
		const diff = computeAuditDiff(
			{ name: 'old', host: 'old', port: 1 },
			{ name: 'new', host: 'new', port: 2 },
			{ includeFields: ['name'] }
		);
		expect(diff!.changes).toHaveLength(1);
		expect(diff!.changes[0].field).toBe('name');
	});

	test('respects excludeFields option', () => {
		const diff = computeAuditDiff(
			{ name: 'old', host: 'old' },
			{ name: 'new', host: 'new' },
			{ excludeFields: ['host'] }
		);
		expect(diff!.changes).toHaveLength(1);
		expect(diff!.changes[0].field).toBe('name');
	});

	test('truncates long strings', () => {
		const longStr = 'a'.repeat(300);
		const diff = computeAuditDiff({ desc: 'short' }, { desc: longStr });
		expect(diff!.changes[0].newValue.length).toBeLessThan(300);
		expect(diff!.changes[0].newValue).toContain('...');
	});

	test('handles array changes', () => {
		const diff = computeAuditDiff({ tags: ['a', 'b'] }, { tags: ['a', 'c'] });
		expect(diff).not.toBeNull();
		expect(diff!.changes[0].field).toBe('tags');
	});
});

describe('formatFieldName', () => {
	test('converts camelCase to title case', () => {
		expect(formatFieldName('hostName')).toBe('Host Name');
	});

	test('handles special cases', () => {
		expect(formatFieldName('tlsCa')).toBe('TLS CA');
		expect(formatFieldName('tlsCert')).toBe('TLS certificate');
		expect(formatFieldName('sshPrivateKey')).toBe('SSH private key');
		expect(formatFieldName('ipAddress')).toBe('IP address');
		expect(formatFieldName('connectionType')).toBe('Connection type');
	});

	test('capitalizes first letter', () => {
		expect(formatFieldName('name')).toBe('Name');
	});

	test('handles multi-word camelCase', () => {
		expect(formatFieldName('socketPath')).toBe('Socket path');
		expect(formatFieldName('collectActivity')).toBe('Collect activity');
	});
});
