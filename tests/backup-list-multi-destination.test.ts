/**
 * The Backups list derives every row from each destination's full snapshot listing:
 * a config moved from one destination to another keeps its older snapshots on the first.
 * Tags come from the same builder the backup run uses.
 */
import { describe, test, expect } from 'bun:test';
import { indexDestinationSnapshots, rowDestinationIds, withoutConfigSnapshots, applyDestinationListing, canDiffSnapshots } from '../src/lib/utils/backup';
import { buildSnapshotTags } from '../src/lib/server/backups/models';

const SELF = 'instance-a';
let seq = 0;
const snap = (configId: number, time: string, { targetName = 'web', instanceId = SELF, id = `s${++seq}` } = {}) => ({
	id,
	time,
	tags: buildSnapshotTags({ instanceId, configId, environmentId: 1, targetName, type: 'container' })
});
const ids = (list: { id: string }[] | undefined) => (list ?? []).map((s) => s.id);

describe('indexDestinationSnapshots', () => {
	test('a config lists its snapshots from every destination holding them, newest first', () => {
		const { perConfig } = indexDestinationSnapshots(
			new Map([
				[1, [snap(7, '2026-10-01T00:00:00Z', { id: 'old' })]],
				[2, [snap(7, '2026-10-03T00:00:00Z', { id: 'new' }), snap(7, '2026-10-02T00:00:00Z', { id: 'mid' })]]
			]),
			new Set([7]),
			SELF
		);
		expect(ids(perConfig.get(7))).toEqual(['new', 'mid', 'old']);
	});

	test('two destinations on the same repository list a snapshot once', () => {
		const a = snap(7, '2026-10-01T00:00:00Z', { id: 'a' });
		const { perConfig } = indexDestinationSnapshots(new Map([[1, [a]], [2, [a]]]), new Set([7]), SELF);
		expect(ids(perConfig.get(7))).toEqual(['a']);
	});

	test('configs on one destination stay apart', () => {
		const { perConfig } = indexDestinationSnapshots(
			new Map([[1, [snap(7, '2026-10-01T00:00:00Z', { id: 'a' }), snap(8, '2026-10-01T00:00:00Z', { id: 'b' })]]]),
			new Set([7, 8]),
			SELF
		);
		expect(ids(perConfig.get(7))).toEqual(['a']);
		expect(ids(perConfig.get(8))).toEqual(['b']);
	});

	test("a deleted config's and another install's snapshots are orphans per destination and name", () => {
		const { perConfig, orphans } = indexDestinationSnapshots(
			new Map([
				[1, [snap(9, '2026-10-01T00:00:00Z', { targetName: 'db', id: 'gone' }), snap(7, '2026-10-02T00:00:00Z', { instanceId: 'instance-b', id: 'foreign' })]],
				[2, [snap(9, '2026-10-03T00:00:00Z', { targetName: 'db', id: 'gone2' })]]
			]),
			new Set([7]),
			SELF
		);
		expect(perConfig.get(7)).toBeUndefined();
		expect(orphans.map((o) => [o.destinationId, o.targetName, ids(o.snapshots)])).toEqual([
			[1, 'db', ['gone']],
			[1, 'web', ['foreign']],
			[2, 'db', ['gone2']]
		]);
	});

	test('an orphan without a name tag is named unknown, keyed by name and destination', () => {
		const { orphans } = indexDestinationSnapshots(new Map([[3, [{ id: 'x', time: '2026-10-01T00:00:00Z', tags: ['foo'] }]]]), new Set([7]), SELF);
		expect(orphans.map((o) => [o.key, o.targetName])).toEqual([['orphan-unknown-3', 'unknown']]);
	});

	test('an orphan lists its newest snapshot first', () => {
		const { orphans } = indexDestinationSnapshots(
			new Map([[1, [snap(9, '2026-10-01T00:00:00Z', { id: 'older' }), snap(9, '2026-10-05T00:00:00Z', { id: 'newer' })]]]),
			new Set(),
			SELF
		);
		expect(ids(orphans[0].snapshots)).toEqual(['newer', 'older']);
	});
});

describe('rowDestinationIds', () => {
	const all = [1, 2, 3, 4];
	const listed = new Set([1, 2, 3]);
	const isListed = (id: number) => listed.has(id);

	test('the current destination, those the row lists from, and any not read yet', () => {
		expect(rowDestinationIds(2, [{ _destinationId: 3 }], all, isListed)).toEqual([2, 3, 4]);
	});

	test('a read destination holding none of the row is left out', () => {
		expect(rowDestinationIds(1, [], all, isListed)).toEqual([1, 4]);
		expect(rowDestinationIds(1, [], all, () => true)).toEqual([1]);
	});
});

describe('withoutConfigSnapshots', () => {
	const lists = () => new Map([
		[1, [snap(7, '2026-10-01T00:00:00Z', { id: 'gone' }), snap(8, '2026-10-01T00:00:00Z', { id: 'other' }), snap(7, '2026-10-01T00:00:00Z', { instanceId: 'instance-b', id: 'foreign' })]],
		[2, [snap(7, '2026-10-02T00:00:00Z', { id: 'older-dest' })]]
	]);

	test("drops only that config's snapshots of this install, on the destination they were forgotten on", () => {
		const left = withoutConfigSnapshots(lists(), 1, 7, SELF);
		expect([...left].map(([id, l]) => [id, ids(l)])).toEqual([[1, ['other', 'foreign']], [2, ['older-dest']]]);
	});

	test('config 7 does not match config 70, and an unlisted destination changes nothing', () => {
		const one = new Map([[1, [snap(70, '2026-10-01T00:00:00Z', { id: 'keep' })]]]);
		expect(ids(withoutConfigSnapshots(one, 1, 7, SELF).get(1))).toEqual(['keep']);
		expect(withoutConfigSnapshots(one, 9, 70, SELF)).toBe(one);
	});
});

describe('applyDestinationListing', () => {
	const prev = new Map([[1, ['a']], [2, ['b']]]);

	test('a list replaces the previous one and clears the error', () => {
		const r = applyDestinationListing(prev, new Map([[1, 'timed out']]), 1, { snapshots: ['c'] });
		expect([...r.lists]).toEqual([[1, ['c']], [2, ['b']]]);
		expect(r.errors.size).toBe(0);
	});

	test('a failure records the error and keeps the previous list', () => {
		const r = applyDestinationListing(prev, new Map(), 1, { error: 'timed out' });
		expect(r.lists.get(1)).toEqual(['a']);
		expect(r.errors.get(1)).toBe('timed out');
	});

	test('an empty list is a list, not a failure', () => {
		const r = applyDestinationListing(prev, new Map([[2, 'x']]), 2, { snapshots: [] });
		expect(r.lists.get(2)).toEqual([]);
		expect(r.errors.has(2)).toBe(false);
	});
});

describe('canDiffSnapshots', () => {
	test('only two snapshots of the same destination are compared', () => {
		expect(canDiffSnapshots({ _destinationId: 1 }, { _destinationId: 1 })).toBe(true);
		expect(canDiffSnapshots({ _destinationId: 1 }, { _destinationId: 2 })).toBe(false);
	});
});
