import { describe, test, expect } from 'bun:test';
import { parseChownSpec } from '../src/lib/server/chown-spec-core';

function ok(spec: ReturnType<typeof parseChownSpec>): string {
	if ('error' in spec) throw new Error('expected success, got: ' + spec.error);
	return spec.value;
}

describe('parseChownSpec', () => {
	test('numeric uid:gid', () => {
		expect(ok(parseChownSpec('1000:1000'))).toBe('1000:1000');
	});

	test('bare uid stays owner-only', () => {
		expect(ok(parseChownSpec('1000'))).toBe('1000');
	});

	test('user names', () => {
		expect(ok(parseChownSpec('node'))).toBe('node');
		expect(ok(parseChownSpec('www-data:www-data'))).toBe('www-data:www-data');
	});

	test('trims surrounding whitespace', () => {
		expect(ok(parseChownSpec('  1000:1000  '))).toBe('1000:1000');
	});

	test('names with dots and underscores', () => {
		expect(ok(parseChownSpec('systemd-network:_ssh'))).toBe('systemd-network:_ssh');
	});

	test('rejects empty / null', () => {
		expect('error' in parseChownSpec('')).toBe(true);
		expect('error' in parseChownSpec('   ')).toBe(true);
		expect('error' in parseChownSpec(null)).toBe(true);
		expect('error' in parseChownSpec(undefined)).toBe(true);
	});

	test('rejects more than one colon', () => {
		expect('error' in parseChownSpec('a:b:c')).toBe(true);
	});

	test('rejects shell / path metacharacters (injection guard)', () => {
		for (const bad of ['1000; rm -rf /', 'root /etc', '../../root', 'a$(id)', 'a|b', 'a&b', 'a`b`', 'a b', '-R', '/root', 'a:b c']) {
			expect('error' in parseChownSpec(bad)).toBe(true);
		}
	});

	test('rejects a name starting with a dot or dash', () => {
		expect('error' in parseChownSpec('.hidden')).toBe(true);
		expect('error' in parseChownSpec('-flag')).toBe(true);
	});

	test('rejects an empty group after the colon', () => {
		expect('error' in parseChownSpec('1000:')).toBe(true);
	});

	test('rejects an over-long spec', () => {
		expect('error' in parseChownSpec('a'.repeat(200))).toBe(true);
	});
});
