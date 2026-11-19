import { describe, test, expect } from 'bun:test';
import { filterByAccessibleEnv } from '../src/lib/server/env-scope-filter';

/**
 * The env-scope filter behind the git-repository (and other) "stacks using this" lists.
 * A scoped caller must see only their environments' rows plus null-env rows; a full-access
 * caller (null) sees everything. An inverted or dropped clause is a cross-tenant leak.
 */
describe('filterByAccessibleEnv', () => {
	const rows = [
		{ environmentId: 1, name: 'a' },
		{ environmentId: 2, name: 'b' },
		{ environmentId: null, name: 'local' }
	];

	test('full access (null) returns every row', () => {
		expect(filterByAccessibleEnv(rows, null)).toEqual(rows);
	});

	test('a scoped caller gets only their envs plus null-env rows', () => {
		expect(filterByAccessibleEnv(rows, [1]).map((r) => r.name)).toEqual(['a', 'local']);
	});

	test('a row in an inaccessible env is excluded', () => {
		// The near miss: env 2 must NOT appear for a caller scoped to env 1.
		expect(filterByAccessibleEnv(rows, [1]).some((r) => r.environmentId === 2)).toBe(false);
	});

	test('a null-env row is always kept, even with an empty access list', () => {
		expect(filterByAccessibleEnv(rows, []).map((r) => r.name)).toEqual(['local']);
	});

	test('no accessible envs and no null-env rows yields nothing', () => {
		expect(filterByAccessibleEnv([{ environmentId: 5 }], [1, 2])).toEqual([]);
	});
});
