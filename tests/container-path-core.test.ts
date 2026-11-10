/**
 * assertSafeContainerPath validates a container/volume file-browser path: it REJECTS a
 * malformed/dangerous path and returns everything else UNCHANGED. The regression it guards:
 * a filename with legal special characters (the reported olcDatabase={2}mdb.ldif) must pass
 * through intact, not be stripped into a different, non-existent path.
 */
import { describe, test, expect } from 'bun:test';
import { assertSafeContainerPath } from '../src/lib/server/container-path-core';

describe('assertSafeContainerPath - legal names pass through UNCHANGED', () => {
	// The old code stripped { } ( ) [ ] etc.; these must now survive byte-for-byte.
	const legal = [
		'/etc/ldap/slapd.d/olcDatabase={2}mdb.ldif',  // the reported case
		'/data/x[1]=y#z.conf',
		'/app/a (b) & c.txt',
		'/srv/weird;name|with`backticks$().log',
		'/mnt/with spaces/file name.yaml',
		'/data/ustawienia-ąęś.conf',                  // Unicode
		'/etc/.env',                                  // leading-dot filename (not a .. segment)
		'/etc/..foo',                                 // starts with dots, still not a .. segment
		'config/app.conf',                            // volume-relative (no leading slash) is allowed
		'/'                                           // root
	];
	for (const p of legal) {
		test(`passes unchanged: ${JSON.stringify(p)}`, () => {
			expect(assertSafeContainerPath(p)).toBe(p);
		});
	}
});

describe('assertSafeContainerPath - rejects malformed/dangerous paths', () => {
	test('rejects a null byte (C-string truncation)', () => {
		expect(() => assertSafeContainerPath('/etc/passwd\0.txt')).toThrow(/null byte/);
	});

	test('rejects a ".." path segment (traversal), in container and volume-relative forms', () => {
		expect(() => assertSafeContainerPath('/a/../b')).toThrow(/\.\./);
		expect(() => assertSafeContainerPath('/a/b/..')).toThrow(/\.\./);
		expect(() => assertSafeContainerPath('../escape')).toThrow(/\.\./);
		expect(() => assertSafeContainerPath('a/../../etc')).toThrow(/\.\./);
	});

	test('rejects empty / non-string', () => {
		expect(() => assertSafeContainerPath('')).toThrow();
		// @ts-expect-error - defensive: a non-string must not slip through
		expect(() => assertSafeContainerPath(null)).toThrow();
	});

	test('a single-dot segment is allowed (only ".." is traversal)', () => {
		// `.` resolves to the same dir and is harmless; the browser never emits it but it is
		// not a traversal, so do not reject it (keeps the rule exact, not over-broad).
		expect(assertSafeContainerPath('/a/./b')).toBe('/a/./b');
	});
});
