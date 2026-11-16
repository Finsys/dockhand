/**
 * Stored stack paths follow an environment rename.
 */

import { describe, test, expect } from 'bun:test';
import { rebaseStackPath, rebaseStackSourceRow, planStackSourceRebase } from '../src/lib/server/stack-path-rebase';

const OLD = '/data/stacks/home';
const NEW = '/data/stacks/house';

describe('rebaseStackPath', () => {
	test('moves a compose path under the old env dir', () => {
		expect(rebaseStackPath('/data/stacks/home/web/docker-compose.yml', OLD, NEW)).toBe('/data/stacks/house/web/docker-compose.yml');
	});

	test('moves an env path under the old env dir', () => {
		expect(rebaseStackPath('/data/stacks/home/web/.env', OLD, NEW)).toBe('/data/stacks/house/web/.env');
	});

	test('moves the dir itself', () => {
		expect(rebaseStackPath(OLD, OLD, NEW)).toBe(NEW);
	});

	test('moves a path stored with redundant segments', () => {
		expect(rebaseStackPath('/data//stacks/home/web/.env', OLD, NEW)).toBe('/data/stacks/house/web/.env');
		expect(rebaseStackPath('/data/stacks/home/./web/compose.yaml', OLD, NEW)).toBe('/data/stacks/house/web/compose.yaml');
		expect(rebaseStackPath('/data/stacks/other/../home/web/compose.yaml', OLD, NEW)).toBe('/data/stacks/house/web/compose.yaml');
	});

	test('accepts an old dir given with a trailing slash', () => {
		expect(rebaseStackPath('/data/stacks/home/web/.env', '/data/stacks/home/', NEW)).toBe('/data/stacks/house/web/.env');
	});

	test('leaves a sibling env whose name shares the prefix', () => {
		expect(rebaseStackPath('/data/stacks/home2/web/docker-compose.yml', OLD, NEW)).toBe('/data/stacks/home2/web/docker-compose.yml');
	});

	test('leaves a custom location outside the stacks dir untouched, as stored', () => {
		expect(rebaseStackPath('/opt/stacks/home/web/compose.yml', OLD, NEW)).toBe('/opt/stacks/home/web/compose.yml');
		expect(rebaseStackPath('/opt//stacks/web/compose.yml', OLD, NEW)).toBe('/opt//stacks/web/compose.yml');
	});

	test('keeps null and the empty "no env file" marker', () => {
		expect(rebaseStackPath(null, OLD, NEW)).toBeNull();
		expect(rebaseStackPath('', OLD, NEW)).toBe('');
	});
});

describe('rebaseStackSourceRow', () => {
	test('moves both the compose and the env path', () => {
		expect(rebaseStackSourceRow({
			composePath: '/data/stacks/home/web/compose.yaml',
			envPath: '/data/stacks/home/web/.env'
		}, OLD, NEW)).toEqual({
			composePath: '/data/stacks/house/web/compose.yaml',
			envPath: '/data/stacks/house/web/.env',
			changed: true
		});
	});

	test('moves an env path even when the compose path lives elsewhere', () => {
		expect(rebaseStackSourceRow({
			composePath: '/opt/web/compose.yaml',
			envPath: '/data/stacks/home/web/.env'
		}, OLD, NEW)).toEqual({
			composePath: '/opt/web/compose.yaml',
			envPath: '/data/stacks/house/web/.env',
			changed: true
		});
	});

	test('moves a compose-only row (the common shape: no env path stored)', () => {
		expect(rebaseStackSourceRow({ composePath: '/data/stacks/home/web/compose.yaml', envPath: null }, OLD, NEW)).toEqual({
			composePath: '/data/stacks/house/web/compose.yaml',
			envPath: null,
			changed: true
		});
	});

	test('reports no change for a row outside the old dir', () => {
		expect(rebaseStackSourceRow({ composePath: '/opt/web/compose.yaml', envPath: null }, OLD, NEW).changed).toBe(false);
		expect(rebaseStackSourceRow({ composePath: null, envPath: '' }, OLD, NEW).changed).toBe(false);
	});

	test('reverts with the directions swapped', () => {
		const moved = rebaseStackSourceRow({ composePath: '/data/stacks/home/web/compose.yaml', envPath: null }, OLD, NEW);
		expect(rebaseStackSourceRow(moved, NEW, OLD).composePath).toBe('/data/stacks/home/web/compose.yaml');
	});
});

describe('planStackSourceRebase', () => {
	const rows = [
		{ id: 1, composePath: '/data/stacks/home/a/compose.yaml', envPath: null },
		{ id: 2, composePath: '/opt/b/compose.yaml', envPath: '/data/stacks/home/b/.env' },
		{ id: 3, composePath: '/opt/c/compose.yaml', envPath: null },
		{ id: 4, composePath: '/data/stacks/house/old/compose.yaml', envPath: null }
	];

	test('plans only the rows under the old dir', () => {
		expect(planStackSourceRebase(rows, OLD, NEW)).toEqual([
			{ id: 1, composePath: '/data/stacks/house/a/compose.yaml', envPath: null },
			{ id: 2, composePath: '/opt/b/compose.yaml', envPath: '/data/stacks/house/b/.env' }
		]);
	});

	test('a revert limited to the changed ids leaves a row already under the new dir alone', () => {
		// Row 4 sat under the new name before the rename; only rows 1 and 2 were moved.
		expect(planStackSourceRebase(rows, NEW, OLD, [1, 2]).map((r) => r.id)).toEqual([]);
		expect(planStackSourceRebase(rows, NEW, OLD).map((r) => r.id)).toEqual([4]);
		const moved = rows.map((r) => ({ ...r, ...planStackSourceRebase([r], OLD, NEW)[0] }));
		expect(planStackSourceRebase(moved, NEW, OLD, [1, 2]).map((r) => r.id)).toEqual([1, 2]);
	});
});
