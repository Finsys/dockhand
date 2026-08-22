/**
 * Behavioural tests for RestoreService against a fake RestorePorts. Pins the
 * restore-specific safety properties:
 *   - the caller must own the snapshot before any read
 *   - requested volumes must exist in the snapshot before anything is touched
 *   - in-place requires explicit confirmation
 *   - new-location is non-destructive (no live-target lock, no stop)
 *   - an undefined restic exit is a failure, never a success
 *   - a pre-restore stop failure aborts before the swap
 *   - a concurrent op on the same live target is rejected
 */
import { describe, it, expect } from 'bun:test';
import { RestoreService, type RestorePorts, type RestoreJob } from '../../src/lib/server/backups/restore-service';
import type { ResticRun } from '../../src/lib/server/backups/models';
import type { OperationHandle } from '../../src/lib/server/backups/backup-service';
import { buildSnapshotLayout, type SnapshotLayout } from '../../src/lib/server/backups/snapshot-layout';

const SNAP = 'a'.repeat(64);

// Build a typed SnapshotLayout for readSnapshotMetadata mocks. `hasStack` toggles the
// stack half (redeploy is refused when absent); `container` is the recreate-as-is inspect.
const layout = (over: { type?: 'container' | 'stack'; container?: unknown; hasStack?: boolean; volumes?: SnapshotLayout['volumes']; environmentId?: number | null } = {}): SnapshotLayout =>
	buildSnapshotLayout({
		type: over.type ?? (over.container ? 'container' : 'stack'),
		targetName: 'web', environmentId: over.environmentId ?? null, backupTime: '2026-08-02T00:00:00.000Z',
		volumes: over.volumes ?? [],
		container: over.container,
		stack: over.hasStack === false ? undefined : { composeFileName: 'docker-compose.yml', fileList: [], excludedBindDirs: [], secrets: [] },
	});

interface Rec {
	guarded: boolean;
	helperRuns: number;
	stopped: boolean;
	restarted: boolean;
	stackStopped: string[];
	notifications: Array<{ event: string; payload: any }>;
	opClosed?: { kind: string; details?: any };
	progress: string[];
	// post-restore spies
	started: string[];
	recreated: string[];
	redeployed: string[];
	localStackFilesWritten: string[];
	localStackFilesOverwrite: boolean[];
	localStackFilesEnvId: Array<number | null | undefined>;
	localStackFilesTargetPath: string[];   // WHERE adopt materialises (must be the canonical stack dir, not job.targetPath)
	// clone spies
	existingVolumes: string[];   // set up front: volumes that already exist on target
	createdVolumes: string[];    // recorded when createTargetVolume is called
}

function makePorts(overrides: Partial<RestorePorts> = {}, rec?: Rec): RestorePorts {
	const r = rec ?? base();
	const op: OperationHandle = {
		id: 1,
		progress: (_s, m) => r.progress.push(m),
		log: () => {},
		close: async (o, d) => { r.opClosed = { kind: o.kind, details: d }; },
		skip: async () => {},
	};
	const base_: RestorePorts = {
		guardSnapshotAccess: async () => { r.guarded = true; },
		listSnapshotVolumes: async () => ['data', 'config'],
		resolveTargets: async () => ({ containers: [{ id: 'c1', name: 'web', state: 'running' }] }),
		stopBeforeRestore: async () => { r.stopped = true; return { restart: async () => { r.restarted = true; } }; },
		stopStackBeforeRestore: async (name) => { r.stackStopped.push(name); return { restart: async () => { r.restarted = true; } }; },
		runInHelper: async () => { r.helperRuns++; return { exitCode: 0, stdout: '', stderr: '' }; },
		resolveVolumeBind: async (_meta, _e, v) => ({ bind: `${v}:/volumes/${v}:rw`, include: `/volumes/${v}`, source: v, type: 'volume' as const }),
		// Uses the REAL resolver so the test exercises the shared clone path-computation.
		resolveCloneTargets: async (job, volumes) => {
			const { resolveRestoreTargets } = await import('../../src/lib/server/backups/restore-targets');
			return resolveRestoreTargets({ job, volumes, metadata: null, stackDir: null }).volumes
				.map((t) => ({ key: t.key, type: t.type, target: t.target, include: t.include, bind: t.bind }));
		},
		volumeExists: async (name) => r.existingVolumes.includes(name),
		createTargetVolume: async (name) => { r.createdVolumes.push(name); },
		acquireLiveTarget: () => () => {},
		serializeDestination: async (_id, fn) => fn(),
		openOperation: async () => op,
		notify: async (event, payload) => { r.notifications.push({ event, payload }); },
		helperName: (s) => `dockhand-restore-${s.slice(0, 12)}`,
		// post-restore: container exists by default (in-place start/recreate rely on
		// this); clone tests that need a FRESH target env override to false. stackExists
		// defaults to false — no stack on a fresh target unless a test says otherwise.
		containerExists: async () => true,
		stackExists: async () => false,
		startContainer: async (name) => { r.started.push(name); },
		recreateContainerFromMetadata: async (name) => { r.recreated.push(name); },
		redeployStack: async (name) => { r.redeployed.push(name); },
		readSnapshotMetadata: async () => layout({ container: { Config: {}, HostConfig: {} } }),
		writeLocalStackFiles: async (_d, _s, name, tp, overwrite, envId) => { r.localStackFilesWritten.push(name); r.localStackFilesTargetPath.push(tp); r.localStackFilesOverwrite.push(overwrite); r.localStackFilesEnvId.push(envId); return true; },
		stackDirFor: async (name, _envId) => `/app/data/stacks/env/${name}`,
	};
	return { ...base_, ...overrides };
}

const newLoc: RestoreJob = { destinationId: 3, snapshotId: SNAP, mode: 'new-location', volumes: ['data'], environmentId: null, targetPath: '/restore/here' };
const inPlace: RestoreJob = { destinationId: 3, snapshotId: SNAP, mode: 'in-place', volumes: ['data'], environmentId: null, confirmOverwrite: true, targetName: 'web' };
const inPlaceStack: RestoreJob = { destinationId: 3, snapshotId: SNAP, mode: 'in-place', targetType: 'stack', volumes: ['data'], environmentId: null, confirmOverwrite: true, targetName: 'mystack' };
const newLocStack: RestoreJob = { destinationId: 3, snapshotId: SNAP, mode: 'new-location', targetType: 'stack', volumes: ['data'], environmentId: null, targetPath: '/restore/here', targetName: 'mystack' };

describe('RestoreService — ownership + existence gates run first', () => {
	it('checks snapshot ownership before restoring', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		await svc.run(newLoc);
		expect(rec.guarded).toBe(true);
	});
	it('refuses when ownership check throws', async () => {
		const svc = new RestoreService(makePorts({ guardSnapshotAccess: async () => { throw new Error('not yours'); } }));
		const res = await svc.run(newLoc);
		expect(res.status).toBe('error');
	});
	it('refuses a volume not present in the snapshot (before touching anything)', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ listSnapshotVolumes: async () => ['other'] }, rec));
		const res = await svc.run({ ...inPlace, volumes: ['data'] });
		expect(res.status).toBe('error');
		expect(rec.helperRuns).toBe(0); // never ran the restore
	});
});

describe('RestoreService — new-location (non-destructive)', () => {
	it('restores to the fresh path and succeeds', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run(newLoc);
		expect(res.status).toBe('success');
		if (res.status === 'success') expect(res.targetPath).toBe('/restore/here');
		expect(rec.stopped).toBe(false); // no stop for new-location
	});
	it('fails on an undefined restic exit (unknown outcome)', async () => {
		const svc = new RestoreService(makePorts({ runInHelper: async () => ({ exitCode: undefined, stdout: '', stderr: 'killed' }) }));
		const res = await svc.run(newLoc);
		expect(res.status).toBe('error');
	});
	it('binds the target path OUT so the extracted data is durable (not lost in the helper)', async () => {
		// restic --target writes inside the helper container; without a bind of
		// targetPath the extracted data vanishes when the helper exits (a silent
		// no-op restore). The helper must mount targetPath through to the host.
		let capturedBinds: string[] = [];
		const svc = new RestoreService(makePorts({
			runInHelper: async (spec) => { capturedBinds = spec.binds; return { exitCode: 0, stdout: '', stderr: '' }; },
		}));
		const res = await svc.run(newLoc);
		expect(res.status).toBe('success');
		expect(capturedBinds).toContain('/restore/here:/restore/here');
	});
	it('REFUSES a new-location restore into a protected system dir (never mounts it)', async () => {
		// Defense-in-depth: even if the request bypassed API validation, the service must
		// not bind-mount /etc rw as root and let restic write into it.
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run({ ...newLoc, targetPath: '/etc' });
		expect(res.status).toBe('error');
		expect(rec.helperRuns).toBe(0);
	});
});

describe('RestoreService — in-place (destructive)', () => {
	it('requires explicit confirmation', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run({ ...inPlace, confirmOverwrite: false });
		expect(res.status).toBe('error');
		expect(rec.helperRuns).toBe(0);
	});
	it('runs the swap (restic helper) on an in-place restore', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run(inPlace);
		expect(res.status).toBe('success');
		expect(rec.helperRuns).toBeGreaterThan(0);
	});
	it('restarts the target on the catch path if the swap itself fails', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ runInHelper: async () => ({ exitCode: undefined, stdout: '', stderr: 'killed mid-swap' }) }, rec));
		const res = await svc.run(inPlace);
		expect(res.status).toBe('error');
		// The catch path restarts the target so it is back up after a failed swap.
		expect(rec.restarted).toBe(true);
	});
		it('surfaces a STILL STOPPED warning + notification if the catch-path restart itself fails', async () => {
			// No boot-time recovery exists, so a failed restart of a target stopped for
			// the restore MUST be surfaced — the user has to start it by hand.
			const rec = base();
			const svc = new RestoreService(makePorts({
				runInHelper: async () => ({ exitCode: undefined, stdout: '', stderr: 'killed mid-swap' }),
				stopBeforeRestore: async () => { rec.stopped = true; return { restart: async () => { throw new Error('daemon down'); } }; },
			}, rec));
			const res = await svc.run(inPlace);
			expect(res.status).toBe('error');
			expect(rec.progress.some((m) => /STILL STOPPED/.test(m))).toBe(true);
			expect(rec.notifications.some((n) => n.event === 'restore_failed' && n.payload?.errorCode === 'STOPPED_RESTART_FAILED')).toBe(true);
		});
	it('stops the target and starts it back via the default post-restore action', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run(inPlace);
		expect(res.status).toBe('success');
		expect(rec.stopped).toBe(true);
		// The default 'start' action brings the container back up.
		expect(rec.started).toEqual(['web']);
		if (res.status === 'success') expect(res.postRestore).toEqual({ action: 'start', ok: true });
	});
	it('aborts before the swap if the pre-restore stop fails', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ stopBeforeRestore: async () => { throw new Error('cannot stop'); } }, rec));
		const res = await svc.run(inPlace);
		expect(res.status).toBe('error');
		expect(rec.helperRuns).toBe(0); // swap never ran
	});
	it('rejects when the live-target lock is held', async () => {
		const svc = new RestoreService(makePorts({ acquireLiveTarget: () => null }));
		const res = await svc.run(inPlace);
		expect(res.status).toBe('skipped');
	});

	// DATA-SAFETY: in-place restore of a BIND volume writes to the snapshot's SOURCE-env
	// host path. Doing that on a DIFFERENT env clobbers an unrelated dir on the wrong host.
	describe('bind-mount in-place cross-env guard', () => {
		// A snapshot taken on env 5 whose only volume is a bind at /srv/appA/data.
		const bindMeta = (sourceEnv: number | null) => async () => layout({
			type: 'container', container: { Config: {}, HostConfig: {} }, environmentId: sourceEnv,
			volumes: [{ key: 'data', name: 'data', source: '/srv/appA/data', type: 'bind' }],
		});
		const bindResolve = async (_meta: any, _e: any, v: string) => ({ bind: `/srv/appA/data:/volumes/${v}:rw`, include: `/volumes/${v}`, source: '/srv/appA/data', type: 'bind' as const });

		it('REFUSES a bind in-place restore onto a different env (fail-closed, no swap)', async () => {
			const rec = base();
			const svc = new RestoreService(makePorts({ readSnapshotMetadata: bindMeta(5), resolveVolumeBind: bindResolve }, rec));
			const res = await svc.run({ ...inPlace, environmentId: 9, confirmOverwrite: true }); // target 9 != source 5
			expect(res.status).toBe('error');
			expect(res.status === 'error' && res.code).toBe('VALIDATION');
			expect(rec.helperRuns).toBe(0);       // never touched a volume
			expect(rec.stopped).toBe(false);       // aborted before stopping the target
		});

		it('ALLOWS a bind in-place restore onto the SAME env as the snapshot', async () => {
			const rec = base();
			const svc = new RestoreService(makePorts({ readSnapshotMetadata: bindMeta(5), resolveVolumeBind: bindResolve }, rec));
			const res = await svc.run({ ...inPlace, environmentId: 5, confirmOverwrite: true }); // target 5 == source 5
			expect(res.status).toBe('success');
			expect(rec.helperRuns).toBe(1);
		});

		it('ALLOWS a NAMED-volume in-place restore cross-env (name resolves on the local daemon)', async () => {
			const rec = base();
			// default resolveVolumeBind returns type:'volume'; metadata says the volume is named.
			const svc = new RestoreService(makePorts({
				readSnapshotMetadata: async () => layout({ type: 'container', container: { Config: {}, HostConfig: {} }, environmentId: 5, volumes: [{ key: 'data', name: 'data', source: 'data', type: 'volume' }] }),
			}, rec));
			const res = await svc.run({ ...inPlace, environmentId: 9, confirmOverwrite: true }); // cross-env, but named vol
			expect(res.status).toBe('success');
			expect(rec.helperRuns).toBe(1);
		});

		it('fails CLOSED when metadata is unreadable and volumes were requested', async () => {
			const rec = base();
			const svc = new RestoreService(makePorts({ readSnapshotMetadata: async () => null }, rec));
			const res = await svc.run({ ...inPlace, environmentId: 9, confirmOverwrite: true });
			expect(res.status).toBe('error');
			expect(rec.helperRuns).toBe(0);
		});

		it('C2: null metadata never slug-binds a bind - fail-closed BEFORE resolving any bind', async () => {
			// The gate reads metadata once and reuses it. If that read is null (transient dump
			// failure), metaUnreadable fires and the restore aborts before the resolve loop, so a
			// bind can never fall through to bindFor(key,key,'volume') (an orphan-volume data loss).
			// A resolveVolumeBind that WOULD slug-bind on null must never be reached.
			const rec = base();
			let resolveCalls = 0;
			const svc = new RestoreService(makePorts({
				readSnapshotMetadata: async () => null,
				resolveVolumeBind: async (_m, _e, v) => { resolveCalls++; return { bind: `${v}:/volumes/${v}:rw`, include: `/volumes/${v}`, source: v, type: 'volume' as const }; },
			}, rec));
			const res = await svc.run({ ...inPlace, environmentId: 5, confirmOverwrite: true }); // same-env
			expect(res.status).toBe('error');       // metaUnreadable -> fail-closed
			expect(resolveCalls).toBe(0);            // never reached the bind resolver
			expect(rec.helperRuns).toBe(0);
		});
	});
});

describe('RestoreService — in-place STACK restore', () => {
	it('stops the whole stack (compose stop) before the swap, not individual containers', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run(inPlaceStack);
		expect(res.status).toBe('success');
		expect(rec.stackStopped).toEqual(['mystack']); // native compose stop
		expect(rec.stopped).toBe(false);                // NOT the per-container stop path
	});
	it('redeploys the stack from stored compose files after the swap', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run(inPlaceStack);
		expect(res.status).toBe('success');
		expect(rec.redeployed).toEqual(['mystack']); // redeploy is the stack post-action
		expect(rec.started).toHaveLength(0);          // NOT the container 'start' action
	});
	it('a failed swap is a hard error (live data left intact)', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ runInHelper: async () => ({ exitCode: undefined, stdout: '', stderr: 'killed' }) }, rec));
		const res = await svc.run(inPlaceStack);
		expect(res.status).toBe('error');
	});
	it('a missing stored compose file downgrades to warning (data restored, redeploy failed)', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ redeployStack: async () => { throw new Error('no stack files stored in this snapshot'); } }, rec));
		const res = await svc.run(inPlaceStack);
		expect(res.status).toBe('warning');
		if (res.status === 'warning') expect(res.postRestore.action).toBe('redeploy');
	});
});

describe('RestoreService — new-location STACK restore', () => {
	it('restores the volume data AND the stored compose files to the target', async () => {
		let capturedArgs: string[] = [];
		const svc = new RestoreService(makePorts({
			runInHelper: async (spec) => { capturedArgs = spec.args ?? []; return { exitCode: 0, stdout: '', stderr: '' }; },
		}));
		const res = await svc.run(newLocStack);
		expect(res.status).toBe('success');
		// The restore includes the data volume AND the captured stack dir (always at
		// /volumes/__dockhand_stackdir__ now - unified snapshot structure).
		expect(capturedArgs).toContain('/volumes/data');
		expect(capturedArgs).toContain('/volumes/__dockhand_stackdir__');
	});
	it('does NOT stop or redeploy anything (non-destructive)', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		await svc.run(newLocStack);
		expect(rec.stackStopped).toHaveLength(0);
		expect(rec.redeployed).toHaveLength(0);
	});
	it('ALWAYS materialises stack files into Dockhand (a stack restore registers a managed stack)', async () => {
		// Load-bearing: Dockhand needs the compose locally to edit/redeploy, especially for a
		// remote env where the compose otherwise lives only on the remote host. So a stack
		// new-location restore materialises unconditionally (no opt-in).
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		await svc.run(newLocStack);
		expect(rec.localStackFilesWritten).toContain('mystack');
	});
	it('materialises into the CANONICAL managed stack dir, NOT job.targetPath (the host data path)', async () => {
		// Guard against the bug where it wrote to job.targetPath (the HOST path where the volume
		// DATA landed, e.g. /restore/here) instead of the managed stack dir. It MUST use
		// stackDirFor() so the stack lands where Dockhand manages it and the containment guard
		// accepts it.
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		await svc.run(newLocStack);
		expect(rec.localStackFilesTargetPath).toEqual(['/app/data/stacks/env/mystack']);
		expect(rec.localStackFilesTargetPath).not.toContain('/restore/here');
	});
	it('materialises with overwrite=true by default (replace, clearing stale files)', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		await svc.run(newLocStack);
		expect(rec.localStackFilesOverwrite).toEqual([true]);
	});
	it('honours an explicit mergeStackFiles:true as a merge (keeps stale files)', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		await svc.run({ ...newLocStack, mergeStackFiles: true });
		expect(rec.localStackFilesOverwrite).toEqual([false]);
	});
	it('skipStackFiles: excludes the stack dir from the restore includes AND does not materialise', async () => {
		let capturedArgs: string[] = [];
		const rec = base();
		const svc = new RestoreService(makePorts({
			runInHelper: async (spec) => { capturedArgs = spec.args ?? []; return { exitCode: 0, stdout: '', stderr: '' }; },
		}, rec));
		await svc.run({ ...newLocStack, skipStackFiles: true });
		expect(capturedArgs).toContain('/volumes/data');
		expect(capturedArgs).not.toContain('/volumes/__dockhand_stackdir__');
		expect(rec.localStackFilesWritten).toHaveLength(0);   // data-only: nothing materialised
	});
});

describe('RestoreService — in-place post-restore actions', () => {
	it("default 'start' starts the container when it exists → success", async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run(inPlace);
		expect(res.status).toBe('success');
		expect(rec.started).toEqual(['web']);
		if (res.status === 'success') expect(res.postRestore).toEqual({ action: 'start', ok: true });
	});

	it("'none' does not start/restart the target (left stopped)", async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run({ ...inPlace, postRestore: 'none' });
		expect(res.status).toBe('success');
		expect(rec.started).toHaveLength(0);
		expect(rec.restarted).toBe(false);
		if (res.status === 'success') expect(res.postRestore).toEqual({ action: 'none', ok: true });
	});

	it("'start' when the container is MISSING → warning (data still restored)", async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ containerExists: async () => false }, rec));
		const res = await svc.run(inPlace);
		expect(res.status).toBe('warning');
		expect(rec.started).toHaveLength(0);
		if (res.status === 'warning') {
			expect(res.restoredVolumes).toEqual(['data']);
			expect(res.postRestore.ok).toBe(false);
			expect(res.postRestore.error).toContain('Recreate');
		}
		// The op is closed as a warning, not an error, and the swap is NOT rolled back.
		expect(rec.opClosed?.kind).toBe('warning');
	});

	it("'recreate' when the container is missing + metadata present → recreates → success", async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ containerExists: async () => false }, rec));
		const res = await svc.run({ ...inPlace, postRestore: 'recreate' });
		expect(res.status).toBe('success');
		expect(rec.recreated).toEqual(['web']);
		if (res.status === 'success') expect(res.postRestore).toEqual({ action: 'recreate', ok: true });
	});

	it("'recreate' when the container still exists prefers start (never destroys a live one)", async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ containerExists: async () => true }, rec));
		const res = await svc.run({ ...inPlace, postRestore: 'recreate' });
		expect(res.status).toBe('success');
		expect(rec.started).toEqual(['web']);
		expect(rec.recreated).toHaveLength(0);
	});

	it("'recreate' when no container metadata is stored → warning", async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({
			containerExists: async () => false,
			readSnapshotMetadata: async () => layout({ type: 'container', hasStack: false }),
		}, rec));
		const res = await svc.run({ ...inPlace, postRestore: 'recreate' });
		expect(res.status).toBe('warning');
		if (res.status === 'warning') {
			expect(res.postRestore.ok).toBe(false);
			expect(res.postRestore.error).toContain('no container metadata');
		}
		expect(rec.recreated).toHaveLength(0);
	});

	it("'redeploy' when stack files are stored → redeploys → success", async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run({ ...inPlace, postRestore: 'redeploy' });
		expect(res.status).toBe('success');
		expect(rec.redeployed).toEqual(['web']);
		if (res.status === 'success') expect(res.postRestore).toEqual({ action: 'redeploy', ok: true });
	});

	it("'redeploy' when no stack files are stored → warning", async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({
			readSnapshotMetadata: async () => layout({ hasStack: false }),
		}, rec));
		const res = await svc.run({ ...inPlace, postRestore: 'redeploy' });
		expect(res.status).toBe('warning');
		if (res.status === 'warning') {
			expect(res.postRestore.ok).toBe(false);
			expect(res.postRestore.error).toContain('no stack files');
		}
		expect(rec.redeployed).toHaveLength(0);
	});

	it('a post-restore action that THROWS → warning (not error), data still reported restored', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({
			startContainer: async () => { throw new Error('docker start blew up'); },
		}, rec));
		const res = await svc.run(inPlace);
		expect(res.status).toBe('warning');
		if (res.status === 'warning') {
			expect(res.restoredVolumes).toEqual(['data']);
			expect(res.postRestore.ok).toBe(false);
			expect(res.postRestore.error).toContain('docker start blew up');
		}
		expect(rec.opClosed?.kind).toBe('warning');
	});

	it('a PLAIN new-location (no destinations, no recreate/redeploy action) starts nothing', async () => {
		// The loose-files extract remains non-destructive: without volumeDestinations
		// and without a recreate/redeploy postRestore, new-location touches nothing live.
		const rec = base();
		const svc = new RestoreService(makePorts({}, rec));
		const res = await svc.run({ ...newLoc, postRestore: 'start' } as RestoreJob);
		expect(res.status).toBe('success');
		expect(rec.started).toHaveLength(0);
		expect(rec.recreated).toHaveLength(0);
		expect(rec.redeployed).toHaveLength(0);
		if (res.status === 'success') expect(res.postRestore).toBeUndefined();
	});
});

describe('RestoreService — config-only (metadata-only) snapshot restore', () => {
	// A snapshot of a container/stack with no volumes/binds carries only /metadata.
	// listSnapshotVolumes returns [] and the caller requests no volumes.
	const metaJob = (over: Partial<RestoreJob> = {}): RestoreJob =>
		({ destinationId: 3, snapshotId: SNAP, mode: 'new-location', volumes: [], environmentId: null, targetPath: '/restore/here', ...over });

	it('new-location extracts /metadata (the stored config) when the snapshot has no volumes', async () => {
		let capturedArgs: string[] = [];
		const svc = new RestoreService(makePorts({
			listSnapshotVolumes: async () => [],
			runInHelper: async (spec) => { capturedArgs = spec.args ?? []; return { exitCode: 0, stdout: '', stderr: '' }; },
		}));
		const res = await svc.run(metaJob());
		expect(res.status).toBe('success');
		expect(capturedArgs).toContain('/metadata'); // config extracted…
		expect(capturedArgs.some((a) => a.startsWith('/volumes/'))).toBe(false); // …no volume paths
	});

	it('in-place skips the volume swap (no restic restore) but still recreates a gone container from config', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({
			listSnapshotVolumes: async () => [],
			containerExists: async () => false, // container gone → recreate rebuilds from stored config
		}, rec));
		const res = await svc.run(metaJob({ mode: 'in-place', confirmOverwrite: true, targetName: 'web', postRestore: 'recreate' }));
		expect(res.status).toBe('success');
		expect(rec.helperRuns).toBe(0); // no restic restore helper — nothing to swap
		expect(rec.recreated).toEqual(['web']); // config still recreated post-restore
	});
});

describe('RestoreService — clone (cross-env restore with per-volume destinations)', () => {
	const cloneJob = (over: Partial<RestoreJob> = {}): RestoreJob => ({
		destinationId: 3, snapshotId: SNAP, mode: 'new-location', volumes: ['data'],
		environmentId: 9, targetName: 'web', targetPath: '/restore/here',
		volumeDestinations: [{ volume: 'data', kind: 'volume', target: 'data' }],
		postRestore: 'recreate', ...over,
	});

	it('populates a fresh named volume on the target env then recreates the container', async () => {
		const rec = base();
		let capturedBinds: string[] = [];
		const svc = new RestoreService(makePorts({
			containerExists: async () => false, // gone on target → recreate rebuilds it
			runInHelper: async (spec) => { rec.helperRuns++; capturedBinds = spec.binds; return { exitCode: 0, stdout: '', stderr: '' }; },
		}, rec));
		const res = await svc.run(cloneJob());
		expect(res.status).toBe('success');
		expect(rec.createdVolumes).toEqual(['data']);       // fresh volume created on target
		expect(capturedBinds).toContain('data:/volumes/data:rw'); // populated via helper
		expect(rec.recreated).toEqual(['web']);             // container rebuilt on target env
	});

	it('FAILS CLOSED when a named-volume destination already exists on the target env', async () => {
		const rec = base();
		rec.existingVolumes = ['data']; // collision
		// Fresh target for the CONTAINER name so we exercise the VOLUME collision path.
		const svc = new RestoreService(makePorts({ containerExists: async () => false }, rec));
		const res = await svc.run(cloneJob());
		expect(res.status).toBe('error');
		if (res.status === 'error') expect(res.error).toMatch(/already exists on the target/i);
		expect(rec.createdVolumes).toHaveLength(0); // nothing created
		expect(rec.helperRuns).toBe(0);             // nothing populated
		expect(rec.recreated).toHaveLength(0);      // nothing started
	});

	it('FAILS CLOSED when a container of the target name already exists on the target env (recreate)', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ containerExists: async () => true }, rec));
		const res = await svc.run(cloneJob()); // postRestore: 'recreate', targetName: 'web'
		expect(res.status).toBe('error');
		if (res.status === 'error') expect(res.error).toMatch(/container "web" already exists on the target/i);
		expect(rec.createdVolumes).toHaveLength(0); // aborted before touching anything
		expect(rec.helperRuns).toBe(0);
		expect(rec.recreated).toHaveLength(0);
		expect(rec.started).toHaveLength(0);        // never starts the pre-existing container
	});

	it('FAILS CLOSED when a stack of the target name already exists on the target env (redeploy)', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ stackExists: async () => true }, rec));
		const res = await svc.run(cloneJob({ targetType: 'stack', postRestore: 'redeploy' }));
		expect(res.status).toBe('error');
		if (res.status === 'error') expect(res.error).toMatch(/stack "web" already exists on the target/i);
		expect(rec.helperRuns).toBe(0);
		expect(rec.redeployed).toHaveLength(0);     // never redeploys over the existing stack
	});

	it('does NOT check the target name when postRestore is none (no container/stack is created)', async () => {
		const rec = base();
		// A name clash is harmless when nothing is brought up — the clone just
		// populates the volume and stops. containerExists=true must NOT block it.
		const svc = new RestoreService(makePorts({ containerExists: async () => true }, rec));
		const res = await svc.run(cloneJob({ postRestore: 'none' }));
		expect(res.status).toBe('success');
		expect(rec.createdVolumes).toEqual(['data']); // volume populated as usual
		expect(rec.recreated).toHaveLength(0);
	});

	it("a clone STACK with postRestore 'none' still MATERIALISES the compose/.env dir (so there's a stack to edit + redeploy)", async () => {
		// The UI tells the user to "update the compose file to the new volume names, then
		// redeploy" - so the compose dir MUST exist even when nothing is brought up. Clone
		// only materialised on redeploy (via redeployStack), leaving 'none' with NO compose
		// dir at all - a real bug (#1351 follow-up): the user restored volumes to host paths
		// with 'none' and had no teslamate/ dir or compose.yaml to edit.
		const rec = base();
		const svc = new RestoreService(makePorts({ containerExists: async () => false }, rec));
		const res = await svc.run(cloneJob({ targetType: 'stack', postRestore: 'none', environmentId: 9 }));
		expect(res.status).toBe('success');
		expect(rec.localStackFilesWritten).toContain('web'); // compose/.env dir written locally
		// envId is threaded through so the port can register the stack as INTERNAL (managed) -
		// without it the restored stack is EXTERNAL and the UI can't edit/redeploy it.
		expect(rec.localStackFilesEnvId).toContain(9);
		expect(rec.redeployed).toHaveLength(0);              // but nothing redeployed ('none')
	});

	it('binds an absolute-path destination as-is WITHOUT creating a volume', async () => {
		const rec = base();
		let capturedBinds: string[] = [];
		const svc = new RestoreService(makePorts({
			containerExists: async () => false,
			runInHelper: async (spec) => { rec.helperRuns++; capturedBinds = spec.binds; return { exitCode: 0, stdout: '', stderr: '' }; },
		}, rec));
		const res = await svc.run(cloneJob({ volumeDestinations: [{ volume: 'data', kind: 'path', target: '/srv/data' }] }));
		expect(res.status).toBe('success');
		expect(rec.createdVolumes).toHaveLength(0);            // a bind path is not a volume
		expect(capturedBinds).toContain('/srv/data:/volumes/data:rw');
	});

	it('config-only clone (no destinations) recreates on the target env without a helper run', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ listSnapshotVolumes: async () => [], containerExists: async () => false }, rec));
		const res = await svc.run(cloneJob({ volumes: [], volumeDestinations: [] }));
		expect(res.status).toBe('success');
		expect(rec.helperRuns).toBe(0);       // nothing to populate
		expect(rec.createdVolumes).toHaveLength(0);
		expect(rec.recreated).toEqual(['web']); // still rebuilt from stored config
	});

	it('extracts un-mapped volumes to targetPath (loose fallback) alongside a mapped one', async () => {
		const rec = base();
		const targets: string[] = [];
		const svc = new RestoreService(makePorts({
			listSnapshotVolumes: async () => ['data', 'logs'],
			containerExists: async () => false,
			runInHelper: async (spec) => { rec.helperRuns++; targets.push(...(spec.args ?? [])); return { exitCode: 0, stdout: '', stderr: '' }; },
		}, rec));
		// 'data' → named volume; 'logs' → un-mapped → loose extract to targetPath.
		const res = await svc.run(cloneJob({ volumes: ['data', 'logs'] }));
		expect(res.status).toBe('success');
		expect(rec.createdVolumes).toEqual(['data']);   // only the mapped one
		expect(rec.helperRuns).toBe(2);                 // one populate + one loose extract
		expect(targets).toContain('/volumes/logs');     // loose include went to the extract run
	});

	it('FAILS (not silent success) when un-mapped volumes have no targetPath to land in', async () => {
		// volumes:[] expands to ALL snapshot volumes; a partial destination map leaves some
		// un-mapped. With no targetPath, those can't be extracted anywhere - the old code
		// silently skipped them and still reported success, redeploying with EMPTY volumes.
		// Must fail-closed instead.
		const rec = base();
		const svc = new RestoreService(makePorts({
			listSnapshotVolumes: async () => ['data', 'logs'],
			containerExists: async () => false,
		}, rec));
		const res = await svc.run(cloneJob({
			volumes: [],                                                     // = all (data, logs)
			volumeDestinations: [{ volume: 'data', kind: 'volume', target: 'data' }], // logs un-mapped
			targetPath: undefined,                                          // nowhere for logs to go
			postRestore: 'redeploy',
		}));
		expect(res.status).toBe('error');
		if (res.status === 'error') expect(res.error).toContain('logs');    // names the dropped volume
	});

	it('a stack clone redeploys on the target env', async () => {
		const rec = base();
		const svc = new RestoreService(makePorts({ containerExists: async () => false }, rec));
		const res = await svc.run(cloneJob({ targetType: 'stack', postRestore: 'redeploy' }));
		expect(res.status).toBe('success');
		expect(rec.redeployed).toEqual(['web']);
	});

	it('FAILS (error) when the post-restore step fails, surfacing the RAW docker error', async () => {
		// A clone exists to bring the target up on the new env, so if recreate/redeploy
		// fails (e.g. a source network/image missing on the target) it's a hard error —
		// the user sees the raw Docker message verbatim, not a quiet "warning". The
		// volume data is still populated (not rolled back).
		const rec = base();
		const svc = new RestoreService(makePorts({
			containerExists: async () => false,
			recreateContainerFromMetadata: async () => { throw new Error('network anton not found'); },
		}, rec));
		const res = await svc.run(cloneJob());
		expect(res.status).toBe('error');
		if (res.status === 'error') {
			expect(res.error).toBe('network anton not found'); // raw docker error, not parsed
			expect(res.code).toBe('DOCKER');
		}
		expect(rec.createdVolumes).toEqual(['data']); // the data DID land (not rolled back)
	});
});

function base(): Rec {
	return { guarded: false, helperRuns: 0, stopped: false, restarted: false, stackStopped: [], notifications: [], progress: [], started: [], recreated: [], redeployed: [], localStackFilesWritten: [], localStackFilesOverwrite: [], localStackFilesEnvId: [], localStackFilesTargetPath: [], existingVolumes: [], createdVolumes: [] };
}
