import { describe, test, expect } from 'bun:test';
import { mapContainerRows, mapStackRows, roundRobin } from '../src/lib/utils/palette-data';

const env = { id: 7, name: 'prod', icon: 'server' };

describe('mapContainerRows', () => {
	test('maps camelCase container fields and stamps env identity', () => {
		const rows = mapContainerRows(
			[{ id: 'abc123', name: 'nginx', state: 'running', image: 'nginx:latest' }],
			env
		);
		expect(rows).toEqual([
			{
				id: 'abc123',
				name: 'nginx',
				displayName: 'nginx',
				state: 'running',
				image: 'nginx:latest',
				envId: 7,
				envName: 'prod',
				envIcon: 'server'
			}
		]);
	});

	test('displayName comes from the dockhand.name label, name stays real', () => {
		const rows = mapContainerRows(
			[{ id: 'a', name: 'acme-grafana', state: 'running', image: 'grafana', labels: { 'dockhand.name': 'grafana' } }],
			env
		);
		expect(rows[0].name).toBe('acme-grafana');
		expect(rows[0].displayName).toBe('grafana');
	});

	test('falls back to globe when the env has no icon', () => {
		const rows = mapContainerRows([{ id: 'x', name: 'c', state: 'exited', image: 'busybox' }], {
			id: 3,
			name: 'edge'
		});
		expect(rows[0].envIcon).toBe('globe');
	});

	test('non-array input yields an empty list (offline env / error body)', () => {
		expect(mapContainerRows(null, env)).toEqual([]);
		expect(mapContainerRows(undefined, env)).toEqual([]);
		expect(mapContainerRows({ error: 'nope' }, env)).toEqual([]);
	});

	test('does not read Docker PascalCase fields', () => {
		// A raw Docker payload (Id/Names/Image) must NOT map through - guards the regression.
		const rows = mapContainerRows([{ Id: 'abc', Names: ['/nginx'], Image: 'nginx', State: 'running' }], env);
		expect(rows[0].id).toBeUndefined();
		expect(rows[0].name).toBeUndefined();
		expect(rows[0].image).toBeUndefined();
	});
});

describe('mapStackRows', () => {
	test('namespaces the id by env and stamps env identity', () => {
		const rows = mapStackRows([{ name: 'web', icon: 'custom:stack' }], env);
		expect(rows).toEqual([
			{
				id: '7:web',
				name: 'web',
				icon: 'custom:stack',
				envId: 7,
				envName: 'prod',
				envIcon: 'server'
			}
		]);
	});

	test('missing icon becomes null', () => {
		const rows = mapStackRows([{ name: 'db' }], env);
		expect(rows[0].icon).toBeNull();
	});

	test('non-array input yields an empty list', () => {
		expect(mapStackRows(null, env)).toEqual([]);
		expect(mapStackRows('oops', env)).toEqual([]);
	});
});

describe('roundRobin', () => {
	test('interleaves one from each group in turn', () => {
		expect(roundRobin([['a1', 'a2', 'a3'], ['b1', 'b2']])).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
	});

	test('uneven group lengths drain in order', () => {
		expect(roundRobin([['a1'], ['b1', 'b2', 'b3'], ['c1', 'c2']])).toEqual(['a1', 'b1', 'c1', 'b2', 'c2', 'b3']);
	});

	test('empty groups are skipped', () => {
		expect(roundRobin([[], ['b1', 'b2'], []])).toEqual(['b1', 'b2']);
	});

	test('no groups -> empty', () => {
		expect(roundRobin([])).toEqual([]);
		expect(roundRobin([[], []])).toEqual([]);
	});

	test('single group is returned in order', () => {
		expect(roundRobin([['x', 'y', 'z']])).toEqual(['x', 'y', 'z']);
	});
});
