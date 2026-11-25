import { describe, expect, test } from 'bun:test';
import {
	buildBuildPruneQuery,
	usesReservedSpace
} from '../src/lib/server/build-cache-prune-core';

// A query string is order-independent; parse it back for stable assertions.
const parse = (qs: string) => Object.fromEntries(new URLSearchParams(qs));

describe('usesReservedSpace (the 1.48 boundary)', () => {
	test('1.48 and above use reserved-space', () => {
		expect(usesReservedSpace('1.48')).toBe(true);
		expect(usesReservedSpace('1.49')).toBe(true);
		expect(usesReservedSpace('1.51')).toBe(true);
		expect(usesReservedSpace('2.0')).toBe(true);
	});

	test('below 1.48 keep-storage', () => {
		expect(usesReservedSpace('1.47')).toBe(false);
		expect(usesReservedSpace('1.45')).toBe(false);
		expect(usesReservedSpace('1.31')).toBe(false);
		expect(usesReservedSpace('0.99')).toBe(false);
	});

	test('unknown or unparseable version falls back to keep-storage', () => {
		// keep-storage is the long-standing field; sending reserved-space to a pre-1.48
		// daemon is ignored and would prune everything, so default to the safe one.
		expect(usesReservedSpace(null)).toBe(false);
		expect(usesReservedSpace(undefined)).toBe(false);
		expect(usesReservedSpace('')).toBe(false);
		expect(usesReservedSpace('garbage')).toBe(false);
	});
});

describe('buildBuildPruneQuery', () => {
	test('empty options -> empty query (dangling-only default)', () => {
		expect(buildBuildPruneQuery({}, '1.48')).toBe('');
	});

	test('all=true sets all', () => {
		expect(parse(buildBuildPruneQuery({ all: true }, '1.48'))).toEqual({ all: 'true' });
	});

	test('all falsey is omitted (default dangling)', () => {
		expect(buildBuildPruneQuery({ all: false }, '1.48')).toBe('');
	});

	test('until goes inside the filters JSON map, not a top-level param', () => {
		const q = parse(buildBuildPruneQuery({ until: '336h' }, '1.48'));
		expect(q.filters).toBe(JSON.stringify({ until: ['336h'] }));
		expect(q.until).toBeUndefined();
	});

	test('blank until is ignored', () => {
		expect(buildBuildPruneQuery({ until: '   ' }, '1.48')).toBe('');
	});

	test('reservedSpace maps to reserved-space on API >= 1.48', () => {
		const q = parse(buildBuildPruneQuery({ reservedSpace: 10737418240 }, '1.48'));
		expect(q['reserved-space']).toBe('10737418240');
		expect(q['keep-storage']).toBeUndefined();
	});

	test('reservedSpace maps to keep-storage on API < 1.48', () => {
		const q = parse(buildBuildPruneQuery({ reservedSpace: 10737418240 }, '1.47'));
		expect(q['keep-storage']).toBe('10737418240');
		expect(q['reserved-space']).toBeUndefined();
	});

	test('reservedSpace falls back to keep-storage when version is unknown', () => {
		const q = parse(buildBuildPruneQuery({ reservedSpace: 1024 }, null));
		expect(q['keep-storage']).toBe('1024');
	});

	test('zero / negative / non-finite reservedSpace is omitted', () => {
		expect(buildBuildPruneQuery({ reservedSpace: 0 }, '1.48')).toBe('');
		expect(buildBuildPruneQuery({ reservedSpace: -5 }, '1.48')).toBe('');
		expect(buildBuildPruneQuery({ reservedSpace: NaN }, '1.48')).toBe('');
	});

	test('fractional bytes are floored', () => {
		const q = parse(buildBuildPruneQuery({ reservedSpace: 1024.9 }, '1.48'));
		expect(q['reserved-space']).toBe('1024');
	});

	test('all + until + reservedSpace combine', () => {
		const q = parse(buildBuildPruneQuery({ all: true, until: '24h', reservedSpace: 2048 }, '1.49'));
		expect(q).toEqual({
			all: 'true',
			filters: JSON.stringify({ until: ['24h'] }),
			'reserved-space': '2048'
		});
	});
});
