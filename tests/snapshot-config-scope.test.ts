/**
 * snapshotMatchesConfigScope: the stack/container Backups view must show only THIS
 * env's snapshots. Same-name stacks on different envs share one repo and all carry
 * `dockhand:name=<stack>`, so a name-only filter leaked snapshots (and "latest")
 * across environments (#1546). Scoping by the env-scoped configid tag fixes it.
 */
import { describe, it, expect } from 'bun:test';
import { snapshotMatchesConfigScope, selectOwnSnapshotsFromDestination } from '../src/lib/utils/backup';

const tags = (name: string, configid: number, envid: number | 'local') => [
	'dockhand:instance=inst-1',
	`dockhand:configid=${configid}`,
	`dockhand:envid=${envid}`,
	'dockhand:type=stack',
	`dockhand:name=${name}`,
];

describe('snapshotMatchesConfigScope', () => {
	it('keeps a snapshot whose configid is in this env’s config set', () => {
		expect(snapshotMatchesConfigScope(tags('caddy', 1, 1), [1], 'caddy')).toBe(true);
	});

	it('DROPS a same-name snapshot from another env (different configid) - the #1546 leak', () => {
		// env-1 view has config 1; a caddy snapshot from env-2 (config 5) must not show.
		expect(snapshotMatchesConfigScope(tags('caddy', 5, 2), [1], 'caddy')).toBe(false);
	});

	it('matches any of several env-scoped configs (a stack with configs on >1 destination)', () => {
		expect(snapshotMatchesConfigScope(tags('caddy', 8, 3), [7, 8, 9], 'caddy')).toBe(true);
		expect(snapshotMatchesConfigScope(tags('caddy', 5, 2), [7, 8, 9], 'caddy')).toBe(false);
	});

	it('name tag alone is NOT enough once configIds are known', () => {
		// Same name, but its configid (99) is not one of ours -> excluded despite the name match.
		expect(snapshotMatchesConfigScope(tags('caddy', 99, 4), [1], 'caddy')).toBe(false);
	});

	it('falls back to the name tag when no configIds are known (defensive, pre-config)', () => {
		expect(snapshotMatchesConfigScope(tags('caddy', 1, 1), [], 'caddy')).toBe(true);
		expect(snapshotMatchesConfigScope(tags('other', 1, 1), [], 'caddy')).toBe(false);
	});

	it('handles missing/empty tags without throwing', () => {
		expect(snapshotMatchesConfigScope(undefined, [1], 'caddy')).toBe(false);
		expect(snapshotMatchesConfigScope([], [1], 'caddy')).toBe(false);
		expect(snapshotMatchesConfigScope([], [], 'caddy')).toBe(false);
	});

	it('ignores a configid substring/prefix false match', () => {
		// configIds=[1] must NOT match dockhand:configid=15 or =10
		expect(snapshotMatchesConfigScope(tags('caddy', 15, 1), [1], 'caddy')).toBe(false);
		expect(snapshotMatchesConfigScope(tags('caddy', 10, 1), [1], 'caddy')).toBe(false);
	});
});

// The wired filter the Backups panel actually applies per destination. Testing THIS
// (not just snapshotMatchesConfigScope in isolation) makes the panel's call site
// load-bearing: a regression back to a name-only filter fails here (#1546 review).
describe('selectOwnSnapshotsFromDestination', () => {
	const dest = { id: 7, name: 'Restic Server', repository: 'rest:http://repo' };

	it('keeps only this env-scoped config’s snapshots and stamps the destination', () => {
		const snaps = [
			{ id: 'a', tags: tags('caddy', 1, 1) }, // env A (config 1)
			{ id: 'b', tags: tags('caddy', 5, 2) }, // env B (config 5) - same name, must be dropped
		];
		const mine = selectOwnSnapshotsFromDestination(snaps, dest, [1], 'caddy');
		expect(mine.map((s) => s.id)).toEqual(['a']); // NOT 'b' - the #1546 leak is closed
		expect(mine[0]._destinationId).toBe(7);
		expect(mine[0]._destinationName).toBe('Restic Server');
		expect(mine[0]._destinationRepository).toBe('rest:http://repo');
	});

	it('a name-only filter would have kept both - this asserts we do NOT', () => {
		const snaps = [
			{ id: 'a', tags: tags('caddy', 1, 1) },
			{ id: 'b', tags: tags('caddy', 5, 2) },
		];
		// name-only (the old, buggy behaviour) keeps both; the wired helper keeps one.
		const nameOnly = snaps.filter((s) => s.tags.includes('dockhand:name=caddy'));
		expect(nameOnly.length).toBe(2);
		expect(selectOwnSnapshotsFromDestination(snaps, dest, [1], 'caddy').length).toBe(1);
	});
});
