/**
 * Unit tests for backups/snapshots.ts — the ownership guards that keep one
 * installation / environment from reading another's backups on a shared repo.
 * The restic reader and access context are injected fakes, so no repo is needed.
 */
import { describe, it, expect } from 'bun:test';
import {
	assertInstanceOwned,
	assertEnvAccess,
	guardSnapshotAccess,
	listSnapshots,
	resolveSnapshotEnvId,
	filterSnapshotsByAccessibleEnv,
	type ResticReader,
	type AccessContext,
} from '../../src/lib/server/backups/snapshots';
import type { ResticRun } from '../../src/lib/server/backups/models';

const SNAP = 'a'.repeat(64);

/** A restic reader whose `snapshots` call returns a fixed set of snapshots. */
function reader(snapshots: Array<{ id: string; tags: string[] }>, exitCode = 0): ResticReader {
	return {
		async runLocal(): Promise<ResticRun> {
			const stdout = JSON.stringify(snapshots.map((s) => ({ id: s.id, short_id: s.id.slice(0, 8), tags: s.tags })));
			return { exitCode, stdout, stderr: exitCode === 0 ? '' : 'restic error' };
		},
	};
}

const freeAccess: AccessContext = { isEnterprise: false, canAccessEnvironment: async () => true };
function enterprise(allowed: number[]): AccessContext {
	return { isEnterprise: true, canAccessEnvironment: async (id) => allowed.includes(id) };
}

describe('assertInstanceOwned', () => {
	it('returns the tags when the snapshot is our own', async () => {
		const r = reader([{ id: SNAP, tags: ['dockhand:instance=me', 'dockhand:envid=3'] }]);
		const tags = await assertInstanceOwned(r, {}, 'me', SNAP);
		expect(tags).toContain('dockhand:envid=3');
	});
	it('NON-ENTERPRISE allows a FOREIGN Dockhand snapshot (orphan from a copied/shared repo) - #1351', async () => {
		// A snapshot written by another instance is a legitimate restorable orphan in free.
		const r = reader([{ id: SNAP, tags: ['dockhand:instance=OTHER', 'dockhand:envid=1'] }]);
		const tags = await assertInstanceOwned(r, {}, 'me', SNAP, false);
		expect(tags).toContain('dockhand:instance=OTHER');
	});
	it('ENTERPRISE still refuses a foreign snapshot (strict per-instance; enterprise does not copy repos)', async () => {
		// Enterprise queries with the instance tag; restic returns nothing for a foreign snap.
		const r = reader([]); // instance-filtered query finds nothing
		await expect(assertInstanceOwned(r, {}, 'me', SNAP, true)).rejects.toThrow(/not found for this installation/);
	});
	it('refuses a NON-DOCKHAND snapshot (another app sharing the repo has no dockhand:instance tag)', async () => {
		const r = reader([{ id: SNAP, tags: ['borgapp:host=nas'] }]);
		await expect(assertInstanceOwned(r, {}, 'me', SNAP, false)).rejects.toThrow(/not found for this installation/);
	});
	it('refuses when the snapshot id is absent from the repo', async () => {
		const r = reader([]);
		await expect(assertInstanceOwned(r, {}, 'me', SNAP, false)).rejects.toThrow(/not found for this installation/);
	});
	it('rejects an invalid snapshot id before touching restic', async () => {
		const r = reader([]);
		await expect(assertInstanceOwned(r, {}, 'me', 'nothex!')).rejects.toThrow(/invalid snapshot id/);
	});
	it('surfaces a restic failure (not a silent empty)', async () => {
		const r = reader([], 1);
		await expect(assertInstanceOwned(r, {}, 'me', SNAP)).rejects.toThrow(/could not verify snapshot ownership/);
	});
});

describe('assertEnvAccess — resolves env from the snapshot tag, fails closed', () => {
	it('is a no-op for non-enterprise', async () => {
		await expect(assertEnvAccess(freeAccess, [])).resolves.toBeUndefined();
	});
	it('allows an env the caller can access', async () => {
		await expect(assertEnvAccess(enterprise([3]), ['dockhand:envid=3'])).resolves.toBeUndefined();
	});
	it('denies an env the caller cannot access', async () => {
		await expect(assertEnvAccess(enterprise([1]), ['dockhand:envid=3'])).rejects.toThrow(/access denied/);
	});
	it('allows an unscoped (local) snapshot', async () => {
		await expect(assertEnvAccess(enterprise([]), ['dockhand:envid=local'])).resolves.toBeUndefined();
	});
	it('FAILS CLOSED when the env tag is absent/malformed', async () => {
		await expect(assertEnvAccess(enterprise([3]), ['no env tag'])).rejects.toThrow(/could not resolve/);
		await expect(assertEnvAccess(enterprise([3]), ['dockhand:envid=abc'])).rejects.toThrow(/could not resolve/);
	});
});

describe('guardSnapshotAccess — instance AND env, in order', () => {
	it('passes for our snapshot in an accessible env', async () => {
		const r = reader([{ id: SNAP, tags: ['dockhand:instance=me', 'dockhand:envid=3'] }]);
		await expect(guardSnapshotAccess(r, {}, 'me', SNAP, enterprise([3]))).resolves.toBeUndefined();
	});
	it('blocks a foreign-instance snapshot before the env check', async () => {
		const r = reader([]); // not ours
		await expect(guardSnapshotAccess(r, {}, 'me', SNAP, enterprise([3]))).rejects.toThrow(/not found/);
	});
	it('blocks our snapshot in an inaccessible env', async () => {
		const r = reader([{ id: SNAP, tags: ['dockhand:instance=me', 'dockhand:envid=9'] }]);
		await expect(guardSnapshotAccess(r, {}, 'me', SNAP, enterprise([3]))).rejects.toThrow(/access denied/);
	});
});

describe('listSnapshots — filters to accessible environments (enterprise)', () => {
	const snaps = [
		{ id: 'x'.repeat(64), tags: ['dockhand:instance=me', 'dockhand:envid=3'] },
		{ id: 'y'.repeat(64), tags: ['dockhand:instance=me', 'dockhand:envid=9'] },
		{ id: 'z'.repeat(64), tags: ['dockhand:instance=me', 'dockhand:envid=local'] },
	];
	it('non-enterprise sees all of its own snapshots', async () => {
		const out = await listSnapshots(reader(snaps), {}, 'me', freeAccess);
		expect(out).toHaveLength(3);
	});
	it('enterprise sees only accessible envs plus unscoped', async () => {
		const out = await listSnapshots(reader(snaps), {}, 'me', enterprise([3]));
		// env 3 (allowed) + local (unscoped); env 9 filtered out
		expect(out.map((s) => s.tags.find((t) => t.startsWith('dockhand:envid'))).sort())
			.toEqual(['dockhand:envid=3', 'dockhand:envid=local']);
	});
	it('enterprise FAILS CLOSED on a snapshot with an absent or malformed env tag (would otherwise leak a scoped snapshot)', async () => {
		const scoped = [
			{ id: 'a'.repeat(64), tags: ['dockhand:instance=me', 'dockhand:envid=3'] },      // allowed
			{ id: 'b'.repeat(64), tags: ['dockhand:instance=me'] },                            // NO env tag -> drop
			{ id: 'c'.repeat(64), tags: ['dockhand:instance=me', 'dockhand:envid=abc'] },      // malformed -> drop
			{ id: 'd'.repeat(64), tags: ['dockhand:instance=me', 'dockhand:envid=9'] },        // not allowed -> drop
		];
		const out = await listSnapshots(reader(scoped), {}, 'me', enterprise([3]));
		expect(out.map((s) => s.id.slice(0, 1))).toEqual(['a']);   // ONLY the allowed, env-tagged one
	});
	it('surfaces a restic error instead of returning []', async () => {
		await expect(listSnapshots(reader([], 1), {}, 'me', freeAccess)).rejects.toThrow();
	});
});

describe('resolveSnapshotEnvId — stable-id env resolution, fail closed', () => {
	it('resolves a numeric env from the snapshot tag', async () => {
		const r = reader([{ id: SNAP, tags: ['dockhand:instance=me', 'dockhand:envid=7'] }]);
		expect(await resolveSnapshotEnvId(r, {}, 'me', SNAP)).toEqual({ envId: 7, resolved: true });
	});
	it('treats a local snapshot as unscoped (envId null, resolved)', async () => {
		const r = reader([{ id: SNAP, tags: ['dockhand:instance=me', 'dockhand:envid=local'] }]);
		expect(await resolveSnapshotEnvId(r, {}, 'me', SNAP)).toEqual({ envId: null, resolved: true });
	});
	it('fails closed when the snapshot is not ours (empty result)', async () => {
		const r = reader([]);
		expect(await resolveSnapshotEnvId(r, {}, 'me', SNAP)).toEqual({ envId: undefined, resolved: false });
	});
	it('fails closed on a restic error', async () => {
		const r = reader([], 1);
		expect(await resolveSnapshotEnvId(r, {}, 'me', SNAP)).toEqual({ envId: undefined, resolved: false });
	});
	it('fails closed when the env tag is absent/malformed', async () => {
		const r = reader([{ id: SNAP, tags: ['dockhand:instance=me'] }]);
		expect(await resolveSnapshotEnvId(r, {}, 'me', SNAP)).toEqual({ envId: undefined, resolved: false });
	});
	it('fails closed on an invalid snapshot id without touching restic', async () => {
		const r = reader([{ id: SNAP, tags: ['dockhand:envid=7'] }]);
		expect(await resolveSnapshotEnvId(r, {}, 'me', 'nothex!')).toEqual({ envId: undefined, resolved: false });
	});
});

describe('filterSnapshotsByAccessibleEnv — stable-id env disclosure guard', () => {
	const snaps = [
		{ tags: ['dockhand:envid=3'], id: 'a' },
		{ tags: ['dockhand:envid=9'], id: 'b' },
		{ tags: ['dockhand:envid=local'], id: 'c' },
		{ tags: ['no env tag'], id: 'd' },
	];
	it('keeps accessible envs + unscoped, drops inaccessible and unresolvable', async () => {
		const out = await filterSnapshotsByAccessibleEnv(snaps, async (id) => id === 3);
		expect(out.map((s) => s.id)).toEqual(['a', 'c']); // env 3 + local; 9 denied; no-tag dropped
	});
	it('memoises the access check per env id', async () => {
		let calls = 0;
		const many = [
			{ tags: ['dockhand:envid=3'], id: '1' },
			{ tags: ['dockhand:envid=3'], id: '2' },
			{ tags: ['dockhand:envid=3'], id: '3' },
		];
		await filterSnapshotsByAccessibleEnv(many, async () => { calls++; return true; });
		expect(calls).toBe(1);
	});
});
