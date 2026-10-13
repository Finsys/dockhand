import { describe, it, expect, afterEach } from 'bun:test';
import { groupSnapshotIdsByDestination, bulkDeleteSnapshots, bulkDeleteToast, bulkDeleteFailure } from '../src/lib/utils/backup';

const snap = (id: string, dest: number) => ({ id, _destinationId: dest });

describe('groupSnapshotIdsByDestination', () => {
	it('groups snapshot ids by their destination (one batch per repo)', () => {
		const g = groupSnapshotIdsByDestination([
			snap('a', 1), snap('b', 2), snap('c', 1), snap('d', 2), snap('e', 3),
		]);
		const byId = Object.fromEntries(g.map((x) => [x.destinationId, x.snapshotIds.sort()]));
		expect(byId[1]).toEqual(['a', 'c']);
		expect(byId[2]).toEqual(['b', 'd']);
		expect(byId[3]).toEqual(['e']);
		expect(g.length).toBe(3);
	});

	it('a single-destination selection is one batch', () => {
		const g = groupSnapshotIdsByDestination([snap('a', 5), snap('b', 5)]);
		expect(g).toEqual([{ destinationId: 5, snapshotIds: ['a', 'b'] }]);
	});

	it('empty input yields no batches', () => {
		expect(groupSnapshotIdsByDestination([])).toEqual([]);
	});

	it('preserves per-destination order (restic forget order is stable)', () => {
		const g = groupSnapshotIdsByDestination([snap('z', 1), snap('a', 1), snap('m', 1)]);
		expect(g[0].snapshotIds).toEqual(['z', 'a', 'm']);
	});
});

describe('bulkDeleteToast', () => {
	it('failed with some deleted -> error naming the count', () => {
		expect(bulkDeleteToast({ deleted: 2, skipped: 0, failed: true }))
			.toEqual({ type: 'error', message: 'Deleted 2, but some snapshots could not be deleted' });
	});
	it('failed with nothing deleted -> plain error', () => {
		expect(bulkDeleteToast({ deleted: 0, skipped: 0, failed: true }))
			.toEqual({ type: 'error', message: 'Snapshots could not be deleted' });
	});
	it('nothing deleted but skipped -> error (not owned / no access), pluralized', () => {
		expect(bulkDeleteToast({ deleted: 0, skipped: 1, failed: false }))
			.toEqual({ type: 'error', message: '1 snapshot could not be deleted (not owned or no access)' });
		expect(bulkDeleteToast({ deleted: 0, skipped: 3, failed: false }).message)
			.toBe('3 snapshots could not be deleted (not owned or no access)');
	});
	it('success -> singular vs plural and optional skipped suffix', () => {
		expect(bulkDeleteToast({ deleted: 1, skipped: 0, failed: false }))
			.toEqual({ type: 'success', message: 'Deleted 1 snapshot' });
		expect(bulkDeleteToast({ deleted: 3, skipped: 0, failed: false }).message).toBe('Deleted 3 snapshots');
		expect(bulkDeleteToast({ deleted: 3, skipped: 2, failed: false }).message).toBe('Deleted 3 snapshots (2 skipped)');
	});
});

describe('bulkDeleteSnapshots', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = realFetch; });

	it('one batch call per destination; sums deleted and skipped across repos', async () => {
		const calls: any[] = [];
		// dest 1 -> deletes a,c; dest 2 -> deletes b, skips d
		globalThis.fetch = (async (_url: string, init: any) => {
			const body = JSON.parse(init.body);
			calls.push(body);
			const per: Record<number, any> = {
				1: { deleted: ['a', 'c'], skipped: [] },
				2: { deleted: ['b'], skipped: ['d'] }
			};
			return { ok: true, json: async () => per[body.destinationId] } as any;
		}) as any;

		const r = await bulkDeleteSnapshots([snap('a', 1), snap('b', 2), snap('c', 1), snap('d', 2)]);
		expect(calls.length).toBe(2);
		expect(r).toEqual({ deleted: 3, skipped: 1, failed: false });
	});

	it('a non-ok response marks failed and does not count that repo\'s skipped', async () => {
		globalThis.fetch = (async (_url: string, init: any) => {
			const body = JSON.parse(init.body);
			if (body.destinationId === 2) return { ok: false, json: async () => ({ deleted: ['b'], skipped: ['x'] }) } as any;
			return { ok: true, json: async () => ({ deleted: ['a'], skipped: [] }) } as any;
		}) as any;
		const r = await bulkDeleteSnapshots([snap('a', 1), snap('b', 2)]);
		// deleted still counts what the failed repo reported forgotten; skipped from a failed repo is not added
		expect(r).toEqual({ deleted: 2, skipped: 0, failed: true });
	});

	it('a thrown fetch marks failed without aborting the other repos', async () => {
		globalThis.fetch = (async (_url: string, init: any) => {
			const body = JSON.parse(init.body);
			if (body.destinationId === 1) throw new Error('network');
			return { ok: true, json: async () => ({ deleted: ['b'], skipped: [] }) } as any;
		}) as any;
		const r = await bulkDeleteSnapshots([snap('a', 1), snap('b', 2)]);
		expect(r.failed).toBe(true);
		expect(r.deleted).toBe(1);
	});

	it('carries the raw restic error from the first failing repo', async () => {
		globalThis.fetch = (async (_url: string, init: any) => {
			const body = JSON.parse(init.body);
			if (body.destinationId === 2) return { ok: false, json: async () => ({ deleted: [], error: 'repository is already locked\ncontext canceled' }) } as any;
			return { ok: true, json: async () => ({ deleted: ['a'], skipped: [] }) } as any;
		}) as any;
		const r = await bulkDeleteSnapshots([snap('a', 1), snap('b', 2)]);
		expect(r.failed).toBe(true);
		expect(r.error).toBe('repository is already locked\ncontext canceled');
	});
});

describe('bulkDeleteFailure', () => {
	it('returns the raw error and deleted count on a hard failure', () => {
		expect(bulkDeleteFailure({ deleted: 1, skipped: 0, failed: true, error: 'repo locked' }))
			.toEqual({ error: 'repo locked', deleted: 1 });
	});
	it('is null when nothing failed (toast handles success/skipped)', () => {
		expect(bulkDeleteFailure({ deleted: 3, skipped: 0, failed: false })).toBeNull();
		expect(bulkDeleteFailure({ deleted: 0, skipped: 2, failed: false })).toBeNull();
	});
	it('is null when failed but no verbatim error (thrown fetch) - toast falls back', () => {
		expect(bulkDeleteFailure({ deleted: 0, skipped: 0, failed: true })).toBeNull();
	});
});
