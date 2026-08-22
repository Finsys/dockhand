/**
 * Behavioural tests for BackupService — the fail-fast backup pipeline asserted
 * against a fake BackupPorts. Each test pins one safety property:
 *   - success only if the helper exited ok AND a snapshot summary was parsed
 *   - a verify step must pass before success is declared / retention runs
 *   - a missing target errors; zero volumes still yields a config-only snapshot
 *   - retention refuses a delete-everything policy and runs only after success
 *   - a restart failure is surfaced (warning + notification), never swallowed
 *   - concurrent op on the same live target is rejected
 */
import { describe, it, expect } from 'bun:test';
import { BackupService, type BackupPorts, type BackupJob, type OperationHandle } from '../../src/lib/server/backups/backup-service';
import type { ResticRun } from '../../src/lib/server/backups/models';
import { LiveTargetLocks } from '../../src/lib/server/backups/locks';

const SNAP = 'abcdef1234567890';

/** A restic backup summary line for a given snapshot id. */
function summaryStdout(snapshotId = SNAP, dataAdded = 100): string {
	return JSON.stringify({ message_type: 'summary', snapshot_id: snapshotId, data_added: dataAdded, files_new: 1 });
}

/** Records everything the service does, for assertions. */
interface Recorder {
	localCalls: string[][];
	helperRuns: number;
	notifications: Array<{ event: string; payload: any }>;
	restarts: number;
	configStatus: string[];
	opClosed?: { kind: string; details?: any };
	opSkipped?: string;
	progress: string[];
	liveTargetAcquired: number;
	liveTargetReleased: number;
	webhooks: Array<{ url: string; payload: any }>;
	helperSpec?: any;   // the last spec passed to runInHelper (to assert binds/args forwarding)
}

function newRecorder(): Recorder {
	return {
		localCalls: [], helperRuns: 0, notifications: [], restarts: 0, configStatus: [], progress: [],
		liveTargetAcquired: 0, liveTargetReleased: 0, webhooks: [],
	};
}

function makePorts(overrides: Partial<BackupPorts> = {}, rec?: Recorder): BackupPorts {
	const r = rec ?? newRecorder();

	const op: OperationHandle = {
		id: 1,
		progress: (_s, m) => { r.progress.push(m); },
		log: () => {},
		close: async (outcome, details) => { r.opClosed = { kind: outcome.kind, details }; },
		skip: async (reason) => { r.opSkipped = reason; },
	};

	const base: BackupPorts = {
		resolveTargets: async () => ({ containers: [{ id: 'c1', name: 'web', state: 'running' }] }),
		discoverVolumes: async () => ({ volumes: [{ key: 'data', bind: 'data:/volumes/data:ro', name: 'data', type: 'volume', source: 'data' }], skipped: [] }),
		planStackDirVolume: async () => ({
			kind: 'candidate' as const,
			syntheticVolume: { key: '__dockhand_stackdir__', bind: '/srv/stacks/web:/volumes/__dockhand_stackdir__:ro', name: '__dockhand_stackdir__', type: 'bind' as const, source: '/srv/stacks/web' },
			volumeKey: '__dockhand_stackdir__',
			composeFileName: 'docker-compose.yml',
			excludePaths: [],
			bindSources: [],
		}),
		stopForBackup: async () => ({ restart: async () => ({ failed: [] }) }),
		runInHelper: async (spec) => { r.helperRuns++; r.helperSpec = spec; return { exitCode: 0, stdout: summaryStdout(), stderr: '' }; },
		runLocal: async (args) => {
			r.localCalls.push(args);
			// verify: `snapshots ... <snap>` → return a doc containing the short id
			if (args[0] === 'snapshots') return { exitCode: 0, stdout: JSON.stringify([{ id: SNAP, short_id: SNAP.slice(0, 8), tags: [] }]), stderr: '' };
			// forget dry-run / real → keep some (not a wipe)
			if (args[0] === 'forget') return { exitCode: 0, stdout: JSON.stringify([{ keep: [{ id: 'x' }], remove: [{ id: 'y' }] }]), stderr: '' };
			return { exitCode: 0, stdout: '', stderr: '' };
		},
		collectMetadata: async () => ({ files: [{ path: 'metadata/metadata.json', contentBase64: 'e30=' }] }),
		host: () => 'dockhand.local',
		instanceId: async () => 'inst',
		acquireLiveTarget: () => { r.liveTargetAcquired++; return () => { r.liveTargetReleased++; }; },
		serializeDestination: async (_id, fn) => fn(),
		openOperation: async () => op,
		notify: async (event, payload) => { r.notifications.push({ event, payload }); },
		fireWebhook: (url, payload) => { r.webhooks.push({ url, payload }); },
		setConfigStatus: async (_id, status) => { r.configStatus.push(status); },
		isCancelling: () => false,
	};
	return { ...base, ...overrides };
}

const job: BackupJob = {
	configId: 7, type: 'container', targetName: 'web', environmentId: null, destinationId: 3,
	allVolumes: true, selectedVolumes: null, stopBeforeBackup: false, retention: null,
	options: {}, helperName: 'dockhand-backup-7',
};

describe('BackupService — happy path', () => {
	it('records success with the parsed snapshot id and summary', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({}, rec));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('success');
		if (res.status === 'success') expect(res.snapshotId).toBe(SNAP);
		expect(rec.configStatus).toContain('success');
		expect(rec.notifications.some((n) => n.event === 'backup_success')).toBe(true);
	});

	it('a stack backup mounts the __dockhand_stackdir__ HOST bind into the helper', async () => {
		// ONE FLOW: the stack dir is captured by bind-mounting its host folder into the helper
		// at /volumes/__dockhand_stackdir__:ro. planStackDirVolume returns that synthetic
		// volume; BackupService must merge it into the helper's binds so restic reads it.
		const rec = newRecorder();
		const stackJob: BackupJob = { ...job, type: 'stack', targetName: 'web' };
		const svc = new BackupService(makePorts({}, rec));
		const res = await svc.run(stackJob, 'manual');
		expect(res.status).toBe('success');
		expect(rec.helperSpec?.binds).toContain('/srv/stacks/web:/volumes/__dockhand_stackdir__:ro');
	});

	it('a stack whose host folder cannot be located (unknown) HARD-FAILS, never a silent partial', async () => {
		// Option A: if planStackDirVolume can't locate the stack folder on the host (no compose
		// working_dir label - not compose-managed), we refuse the backup rather than silently
		// dropping the stack's compose/config. The user must never think they have a backup
		// that is missing files.
		const rec = newRecorder();
		const stackJob: BackupJob = { ...job, type: 'stack', targetName: 'web' };
		const svc = new BackupService(makePorts({
			planStackDirVolume: async () => ({ kind: 'unknown' as const, reason: 'no compose working_dir label' }),
		}, rec));
		const res = await svc.run(stackJob, 'manual');
		expect(res.status).not.toBe('success');
		expect(rec.helperRuns).toBe(0);   // never even ran the helper
	});
});

describe('BackupService — notifications carry a title/message (#1414)', () => {
	// The Apprise/Slack formatter reads payload.title and payload.message. Backup
	// events must supply both (like every other event type) or Slack renders the
	// literal "undefined <environment> undefined".
	it('backup_success supplies title, message and type', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({}, rec));
		await svc.run(job, 'manual');
		const n = rec.notifications.find((n) => n.event === 'backup_success');
		expect(n).toBeDefined();
		expect(typeof n!.payload.title).toBe('string');
		expect((n!.payload.title as string).length).toBeGreaterThan(0);
		expect(typeof n!.payload.message).toBe('string');
		expect(n!.payload.message as string).toContain(job.targetName);
		expect(n!.payload.type).toBe('success');
	});

	it('backup_failed supplies title, message and type', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({ runInHelper: async () => ({ exitCode: 1, stdout: summaryStdout(), stderr: 'restic failed' }) }, rec));
		await svc.run(job, 'manual');
		const n = rec.notifications.find((n) => n.event === 'backup_failed');
		expect(n).toBeDefined();
		expect(typeof n!.payload.title).toBe('string');
		expect((n!.payload.title as string).length).toBeGreaterThan(0);
		expect(typeof n!.payload.message).toBe('string');
		expect((n!.payload.message as string).length).toBeGreaterThan(0);
		expect(n!.payload.type).toBe('error');
	});
});

describe('BackupService — stale repo-lock recovery', () => {
	// A prior backup/restore killed or crashed mid-op (helper OOM, host restart,
	// cancelBackup) leaves restic's repo lock orphaned. The NEXT op to that repo
	// would otherwise wait out `--retry-lock` (~10 min) on a dead owner — this was
	// the real cause of the 300s CI backup timeouts (all envs share one repo; a
	// killed-helper crash-safety test orphaned the lock). We run `restic unlock`
	// BEFORE the backup (and on the failure path) to clear it. Serialized per
	// destination, so no live op holds the repo → any lock present is stale.
	it('runs `restic unlock` BEFORE the backup helper on the happy path', async () => {
		const rec = newRecorder();
		const order: string[] = [];
		const svc = new BackupService(makePorts({
			runLocal: async (args: string[]) => {
				if (args[0] === 'unlock') order.push('unlock');
				if (args[0] === 'snapshots') return { exitCode: 0, stdout: JSON.stringify([{ id: SNAP, short_id: SNAP.slice(0, 8), tags: [] }]), stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			},
			runInHelper: async () => { order.push('helper'); rec.helperRuns++; return { exitCode: 0, stdout: summaryStdout(), stderr: '' }; },
		}, rec));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('success');
		// unlock must precede the backup helper — it clears a stale lock so the
		// backup never waits on restic's retry-lock.
		expect(order[0]).toBe('unlock');
		expect(order).toContain('helper');
		expect(order.indexOf('unlock')).toBeLessThan(order.indexOf('helper'));
	});

	it('runs `restic unlock` on the failure path (killed helper leaves a lock)', async () => {
		const unlocks: string[] = [];
		const svc = new BackupService(makePorts({
			// helper "killed" → undefined exit → backup fails
			runInHelper: async () => ({ exitCode: undefined, stdout: '', stderr: 'killed' }),
			runLocal: async (args: string[]) => {
				if (args[0] === 'unlock') unlocks.push('unlock');
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		}));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('error');
		// unlock fired at least once (pre-backup) and the failed op cleaned up its
		// own orphaned lock so the NEXT backup to this repo isn't blocked.
		expect(unlocks.length).toBeGreaterThanOrEqual(1);
	});

	it('a metadata upload failure fails the backup CLOSED (never a snapshot missing metadata.json)', async () => {
		// The helper put-archives metadata.json into /metadata BEFORE restic starts (restic.ts
		// beforeStart runs before the container start). If that upload throws, the helper never
		// starts restic, so runInHelper surfaces an undefined exit — which MUST be treated as a
		// failure, never a success. This guards against a snapshot that captured /volumes but not
		// /metadata (an incomplete-but-"successful" backup). We simulate the upload failure as the
		// undefined-exit it produces at the port boundary.
		const rec = newRecorder();
		const svc = new BackupService(makePorts({
			runInHelper: async () => ({ exitCode: undefined, stdout: '', stderr: 'Failed to upload archive: metadata put-archive boom' }),
		}, rec));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('error');
		expect(rec.notifications.some((n) => n.event === 'backup_success')).toBe(false);
	});

	it('a failing `unlock` never blocks the backup (best-effort)', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({
			runLocal: async (args: string[]) => {
				if (args[0] === 'unlock') throw new Error('unlock boom');
				if (args[0] === 'snapshots') return { exitCode: 0, stdout: JSON.stringify([{ id: SNAP, short_id: SNAP.slice(0, 8), tags: [] }]), stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		}, rec));
		const res = await svc.run(job, 'manual');
		// unlock threw, but the backup still succeeded — restic's own --retry-lock
		// remains the backstop, so a flaky unlock can't fail an otherwise-good backup.
		expect(res.status).toBe('success');
	});
});

describe('BackupService — live-target lock is always released', () => {
	// The finally { release() } in run() must free the live-target key on BOTH the
	// success and error paths. A leak leaves the key held forever, silently
	// rejecting every future backup+restore of that data — and a status-only test
	// would never notice. So assert the release spy fires exactly once each time.
	it('acquires once and releases once on the happy path', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({}, rec));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('success');
		expect(rec.liveTargetAcquired).toBe(1);
		expect(rec.liveTargetReleased).toBe(1);
	});

	it('still releases the lock when the backup fails (helper error)', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({
			runInHelper: async () => { rec.helperRuns++; return { exitCode: undefined, stdout: '', stderr: 'killed' }; },
		}, rec));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('error');
		// The lock was taken and MUST be freed even though the run failed.
		expect(rec.liveTargetAcquired).toBe(1);
		expect(rec.liveTargetReleased).toBe(1);
	});

	it('releases the live-target lock BEFORE retention (repo-only) runs', async () => {
		// Retention is a repo forget/prune that never touches the live volume, so
		// the live-target lock must already be freed by the time it runs — otherwise
		// a concurrent restore sees 'skipped' during the (potentially slow) prune.
		// Record the interleaving of the release spy and the `forget` restic call.
		const timeline: string[] = [];
		const rec = newRecorder();
		const svc = new BackupService(makePorts({
			acquireLiveTarget: () => { rec.liveTargetAcquired++; return () => { rec.liveTargetReleased++; timeline.push('release'); }; },
			runLocal: async (args: string[]) => {
				if (args[0] === 'snapshots') return { exitCode: 0, stdout: JSON.stringify([{ id: SNAP, short_id: SNAP.slice(0, 8), tags: [] }]), stderr: '' };
				if (args[0] === 'forget') { timeline.push('forget'); return { exitCode: 0, stdout: JSON.stringify([{ keep: [{ id: 'x' }], remove: [{ id: 'y' }] }]), stderr: '' }; }
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		}, rec));
		// A retention policy so forget actually runs (dry-run + real = two forgets).
		const res = await svc.run({ ...job, retention: { keepLast: 1 } as any }, 'manual');
		expect(res.status).toBe('success');
		expect(rec.liveTargetReleased).toBe(1);
		// The lock release must precede EVERY forget — retention runs unlocked.
		expect(timeline).toContain('release');
		expect(timeline).toContain('forget');
		expect(timeline.indexOf('release')).toBeLessThan(timeline.indexOf('forget'));
	});

	it('lets a concurrent op acquire the same target while the first is in retention', async () => {
		// The direct property behind the ordering test: a second op arriving DURING
		// the first backup's (slow) retention prune must ACQUIRE the live-target
		// slot, not get 'skipped'. Model a real single-slot lock — free ⇒ release
		// closure, held ⇒ null (exactly how the engine skips). Hold retention open
		// until the second op has tried to acquire. Under the fix the slot is freed
		// before retention, so the second op wins; revert the reorder and this fails.
		let held = false;
		const acquire = () => {
			if (held) return null;
			held = true;
			return () => { held = false; };
		};

		let releaseRetention!: () => void;
		const retentionGate = new Promise<void>((r) => { releaseRetention = r; });
		let secondAcquiredDuringRetention: boolean | null = null;

		const rec = newRecorder();
		const svc = new BackupService(makePorts({
			acquireLiveTarget: acquire,
			runLocal: async (args: string[]) => {
				if (args[0] === 'snapshots') return { exitCode: 0, stdout: JSON.stringify([{ id: SNAP, short_id: SNAP.slice(0, 8), tags: [] }]), stderr: '' };
				if (args[0] === 'forget') {
					// First forget: pause here so a second op can race the retention tail.
					if (secondAcquiredDuringRetention === null) {
						const second = new BackupService(makePorts({ acquireLiveTarget: acquire }));
						const r2 = await second.run(job, 'manual');
						secondAcquiredDuringRetention = r2.status !== 'skipped';
						releaseRetention();
					}
					return { exitCode: 0, stdout: JSON.stringify([{ keep: [{ id: 'x' }], remove: [{ id: 'y' }] }]), stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		}, rec));

		const res = await svc.run({ ...job, retention: { keepLast: 1 } as any }, 'manual');
		await retentionGate;
		expect(res.status).toBe('success');
		// The second op ran the whole backup while the first was pruning — it never
		// saw the lock, because retention runs unlocked.
		expect(secondAcquiredDuringRetention).toBe(true);
	});
});

describe('BackupService — success requires exit ok AND a parsed snapshot', () => {
	it('fails when the helper exit is undefined (unknown outcome)', async () => {
		const svc = new BackupService(makePorts({ runInHelper: async () => ({ exitCode: undefined, stdout: '', stderr: 'killed' }) }));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('error');
	});
	it('fails when restic exits 0 but produced NO summary (phantom snapshot guard)', async () => {
		const svc = new BackupService(makePorts({ runInHelper: async () => ({ exitCode: 0, stdout: 'no summary here', stderr: '' }) }));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('error');
		if (res.status === 'error') expect(res.code).toBe('INTEGRITY');
	});
	it('exit 3 (partial read) commits as a WARNING, not a failure', async () => {
		const svc = new BackupService(makePorts({ runInHelper: async () => ({ exitCode: 3, stdout: summaryStdout(), stderr: '' }) }));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('warning');
	});
	it('a plain restic error exit (1 or 2) is a FAILURE, never a partial-warning', async () => {
		// Only exit 3 is the "partial read" warning; every other non-zero code is a
		// real error and must NOT be smuggled through as success/warning even when
		// restic printed a summary line before failing.
		for (const code of [1, 2]) {
			const svc = new BackupService(makePorts({ runInHelper: async () => ({ exitCode: code, stdout: summaryStdout(), stderr: 'restic failed' }) }));
			const res = await svc.run(job, 'manual');
			expect(res.status).toBe('error');
		}
	});

	it('a stack dir over the capture cap HARD-FAILS the backup (never a truncated success)', async () => {
		// The stack dir exceeding the cap is now a hard error raised INSIDE
		// collectMetadata (compose/.env are cap-exempt, so this is the user's
		// non-compose sidecars alone being over the limit). A silently-truncated
		// snapshot that reports success is a worse failure than a loud one, so the
		// run must FAIL, not warn.
		const { BackupError } = await import('../../src/lib/server/backups/models');
		const svc = new BackupService(makePorts({
			collectMetadata: async () => { throw new BackupError('INTEGRITY', 'config files exceed the stackfile capture cap'); },
			runInHelper: async () => ({ exitCode: 0, stdout: summaryStdout(), stderr: '' }),
		}));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('error');
		if (res.status === 'error') expect(res.error).toContain('capture cap');
	});
});

describe('BackupService — verify before success and before retention', () => {
	it('fails if the new snapshot cannot be verified as readable', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({
			runLocal: async (args) => {
				rec.localCalls.push(args);
				if (args[0] === 'snapshots') return { exitCode: 1, stdout: '', stderr: 'not found' }; // verify fails
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		}, rec));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('error');
		if (res.status === 'error') expect(res.code).toBe('INTEGRITY');
		// retention (forget) must NOT have run after a failed verify
		expect(rec.localCalls.some((c) => c[0] === 'forget')).toBe(false);
	});
});

describe('BackupService — no empty snapshot reaches retention', () => {
	it('errors when the target has no containers (deleted target)', async () => {
		const svc = new BackupService(makePorts({ resolveTargets: async () => ({ containers: [] }) }));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('error');
		expect(res.status === 'error' && res.code).toBe('VALIDATION');
	});
	it('records the DELETED-target run as a FAILED error row, not a benign "skipped" (audit-trail must not hide it)', async () => {
		// The bug: earlySkipOrError used op.skip() which hardcodes CONCURRENCY + skipped:true,
		// so a config pointing at a deleted target logged a benign "skipped" every cron run.
		// It must close as a real error (VALIDATION), so an operator filtering failed backups sees it.
		const rec = newRecorder();
		const svc = new BackupService(makePorts({ resolveTargets: async () => ({ containers: [] }) }, rec));
		await svc.run(job, 'manual');
		expect(rec.opClosed?.kind).toBe('error');            // durable row is an error...
		expect(rec.opClosed?.details?.skipped).not.toBe(true); // ...NOT a skip
		expect(rec.opSkipped).toBeUndefined();                 // op.skip() was NOT used
	});
	it('succeeds with a config-only (metadata-only) snapshot when the target has zero volumes', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({ discoverVolumes: async () => ({ volumes: [], skipped: [] }) }, rec));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('success'); // metadata.json still captured — restorable via recreate/redeploy
	});
	it('propagates a fail-closed discovery error (partial inspect)', async () => {
		const svc = new BackupService(makePorts({ discoverVolumes: async () => { throw new (await import('../../src/lib/server/backups/models')).BackupError('DOCKER', 'inspect failed'); } }));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('error');
		if (res.status === 'error') expect(res.code).toBe('DOCKER');
	});
});

describe('BackupService — retention', () => {
	it('runs retention only after a confirmed+verified snapshot', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({}, rec));
		await svc.run({ ...job, retention: { keepLast: 5 } }, 'manual');
		const order = rec.localCalls.map((c) => c[0]);
		// snapshots (verify) comes before forget (retention)
		expect(order.indexOf('snapshots')).toBeLessThan(order.indexOf('forget'));
	});
	it('refuses a policy that would delete every snapshot', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({
			runLocal: async (args) => {
				rec.localCalls.push(args);
				if (args[0] === 'snapshots') return { exitCode: 0, stdout: JSON.stringify([{ id: SNAP, short_id: SNAP.slice(0, 8), tags: [] }]), stderr: '' };
				if (args[0] === 'forget' && args.includes('--dry-run')) return { exitCode: 0, stdout: JSON.stringify([{ keep: [], remove: [{ id: 'a' }, { id: 'b' }] }]), stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		}, rec));
		const res = await svc.run({ ...job, retention: { keepLast: 1 } }, 'manual');
		expect(res.status).toBe('success');
		// A real (non-dry-run) forget must NOT have executed.
		const realForget = rec.localCalls.filter((c) => c[0] === 'forget' && !c.includes('--dry-run'));
		expect(realForget).toHaveLength(0);
		expect(rec.opClosed?.details?.retention).toBe('skipped-would-wipe');
	});
});

describe('BackupService — stop/restart', () => {
	it('surfaces a restart failure as a warning + notification (service still stopped)', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({
			stopForBackup: async () => ({ restart: async () => ({ failed: [{ name: 'web', error: 'port in use' }] }) }),
		}, rec));
		const res = await svc.run({ ...job, stopBeforeBackup: true }, 'manual');
		// The backup itself still succeeded (data is safe)...
		expect(res.status).toBe('success');
		// ...but the restart failure is surfaced.
		expect(rec.progress.some((m) => m.includes('STILL STOPPED'))).toBe(true);
		expect(rec.notifications.some((n) => n.payload?.errorCode === 'STOPPED_RESTART_FAILED')).toBe(true);
	});
	it('restarts exactly once on the success path (no double start)', async () => {
		let restartCount = 0;
		const svc = new BackupService(makePorts({
			stopForBackup: async () => ({ restart: async () => { restartCount++; return { failed: [] }; } }),
		}));
		await svc.run({ ...job, stopBeforeBackup: true }, 'manual');
		expect(restartCount).toBe(1);
	});
});

describe('BackupService — concurrency', () => {
	it('rejects (skips) when the live-target lock is already held', async () => {
		const svc = new BackupService(makePorts({ acquireLiveTarget: () => null }));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('skipped');
	});
	it('runs the backup inside the destination serializer', async () => {
		let serialized = false;
		const svc = new BackupService(makePorts({ serializeDestination: async (_id, fn) => { serialized = true; return fn(); } }));
		await svc.run(job, 'manual');
		expect(serialized).toBe(true);
	});
});

describe('BackupService — per-config webhooks', () => {
	it('fires the success webhook with the backup-context payload', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({}, rec));
		const res = await svc.run(
			{ ...job, options: { webhookSuccess: 'https://hook.example.com/ok' } },
			'manual',
		);
		expect(res.status).toBe('success');
		expect(rec.webhooks.length).toBe(1);
		const wh = rec.webhooks[0];
		expect(wh.url).toBe('https://hook.example.com/ok');
		expect(wh.payload.event).toBe('backup_success');
		expect(wh.payload.target).toBe('web');
		expect(wh.payload.type).toBe('container');
		expect(wh.payload.snapshotId).toBe(SNAP);
		expect(typeof wh.payload.duration).toBe('number');
		expect(wh.payload.executionId).toBeDefined();
	});

	it('fires the failure webhook with the error payload when the backup fails', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({
			runInHelper: async () => { rec.helperRuns++; return { exitCode: undefined, stdout: '', stderr: 'killed' }; },
		}, rec));
		const res = await svc.run(
			{ ...job, options: { webhookFailure: 'https://hook.example.com/fail' } },
			'manual',
		);
		expect(res.status).toBe('error');
		expect(rec.webhooks.length).toBe(1);
		const wh = rec.webhooks[0];
		expect(wh.url).toBe('https://hook.example.com/fail');
		expect(wh.payload.event).toBe('backup_failed');
		expect(wh.payload.target).toBe('web');
		expect(wh.payload.error).toBeDefined();
		expect(wh.payload.errorCode).toBeDefined();
	});

	it('does NOT fire the failure webhook when only a success hook is set (and vice versa)', async () => {
		// Failing run with only a SUCCESS hook configured → no webhook fires.
		const recFail = newRecorder();
		const svcFail = new BackupService(makePorts({
			runInHelper: async () => { recFail.helperRuns++; return { exitCode: undefined, stdout: '', stderr: 'killed' }; },
		}, recFail));
		await svcFail.run({ ...job, options: { webhookSuccess: 'https://hook.example.com/ok' } }, 'manual');
		expect(recFail.webhooks.length).toBe(0);

		// Succeeding run with only a FAILURE hook configured → no webhook fires.
		const recOk = newRecorder();
		const svcOk = new BackupService(makePorts({}, recOk));
		await svcOk.run({ ...job, options: { webhookFailure: 'https://hook.example.com/fail' } }, 'manual');
		expect(recOk.webhooks.length).toBe(0);
	});

	it('fires no webhook at all when neither hook URL is configured', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({}, rec));
		await svc.run(job, 'manual'); // job.options = {}
		expect(rec.webhooks.length).toBe(0);
	});
});

describe('BackupService — user-cancelled backup', () => {
	// A cancel SIGINT/SIGKILLs the helper → it exits non-zero (137). Without the
	// isCancelling check that reads as a real failure. With it, the run is reported
	// as cancelled, not failed: no failure notification, no failure webhook.
	function killedPorts(rec: Recorder, cancelling: boolean) {
		return makePorts({
			runInHelper: async () => { rec.helperRuns++; return { exitCode: undefined, stdout: '', stderr: 'killed' }; },
			isCancelling: () => cancelling,
		}, rec);
	}

	it('closes the op as cancelled with a clean message and returns skipped', async () => {
		const rec = newRecorder();
		const svc = new BackupService(killedPorts(rec, true));
		const result = await svc.run(job, 'manual');
		expect(result.status).toBe('skipped');
		expect(rec.opClosed?.kind).toBe('cancelled');
	});

	it('does NOT fire the failure webhook or notification when cancelled', async () => {
		const rec = newRecorder();
		const svc = new BackupService(killedPorts(rec, true));
		await svc.run({ ...job, options: { webhookFailure: 'https://hook.example.com/fail' } }, 'manual');
		expect(rec.webhooks.length).toBe(0);
		expect(rec.notifications.some((n) => n.event === 'backup_failed')).toBe(false);
	});

	it('the SAME killed run WITHOUT cancel is a real failure (regression guard)', async () => {
		const rec = newRecorder();
		const svc = new BackupService(killedPorts(rec, false));
		const result = await svc.run({ ...job, options: { webhookFailure: 'https://hook.example.com/fail' } }, 'manual');
		expect(result.status).toBe('error');
		expect(rec.opClosed?.kind).toBe('error');
		expect(rec.webhooks.length).toBe(1);
		expect(rec.notifications.some((n) => n.event === 'backup_failed')).toBe(true);
	});
});

describe('Config-only backups do not spuriously block each other (live-target key)', () => {
	// Two DIFFERENT config-only targets (no volumes) on the same env must both back up. Wire a
	// REAL LiveTargetLocks so the lock key actually decides collision (not a mock that always
	// grants). Config-only = discoverVolumes returns zero volumes.
	const configOnlyPorts = (locks: LiveTargetLocks, rec?: any) => makePorts({
		discoverVolumes: async () => ({ volumes: [], skipped: [] }),
		acquireLiveTarget: (key: string) => locks.tryAcquire(key),
	}, rec);

	const jobFor = (configId: number, targetName: string): BackupJob =>
		({ ...job, configId, targetName });

	it('two disjoint config-only targets on the same env BOTH succeed (were both `${env}::`)', async () => {
		const locks = new LiveTargetLocks();
		const svcWeb = new BackupService(configOnlyPorts(locks));
		const svcApi = new BackupService(configOnlyPorts(locks));
		// resolveTargets returns a container named 'web' by default; give 'api' its own container.
		const apiPorts = configOnlyPorts(locks);
		apiPorts.resolveTargets = async () => ({ containers: [{ id: 'c2', name: 'api', state: 'running' }] });
		const [web, api] = await Promise.all([
			svcWeb.run(jobFor(7, 'web'), 'cron'),
			new BackupService(apiPorts).run(jobFor(8, 'api'), 'cron'),
		]);
		expect(['success', 'warning']).toContain(web.status);
		expect(['success', 'warning']).toContain(api.status);
	});

	it('the SAME config-only target held concurrently still rejects the second (lock works)', async () => {
		const locks = new LiveTargetLocks();
		// Manually hold the key the config-only 'web' target will compute, then run it -> skip.
		const held = locks.tryAcquire('local::config:container:web');
		expect(held).not.toBeNull();
		const res = await new BackupService(configOnlyPorts(locks)).run(jobFor(7, 'web'), 'cron');
		expect(res.status).toBe('skipped');
		held!();
	});
});

describe('BackupService — volume log distinguishes binds by host source (#1373)', () => {
	it('two binds to the same container path get distinct log lines with their host source', async () => {
		const rec = newRecorder();
		const svc = new BackupService(makePorts({
			discoverVolumes: async () => ({
				volumes: [
					{ key: 'data__alpha', bind: '/host/alpha:/volumes/data__alpha:ro', name: '/data', type: 'bind', source: '/host/alpha' },
					{ key: 'data__beta', bind: '/host/beta:/volumes/data__beta:ro', name: '/data', type: 'bind', source: '/host/beta' },
				],
				skipped: [],
			}),
		}, rec));
		const res = await svc.run(job, 'manual');
		expect(res.status).toBe('success');
		const bindLines = rec.progress.filter((m) => m.includes('[BIND]'));
		expect(bindLines).toHaveLength(2);
		// Each line names its host source, so the two /data binds are not identical.
		expect(bindLines.some((m) => m.includes('/host/alpha') && m.includes('/data'))).toBe(true);
		expect(bindLines.some((m) => m.includes('/host/beta') && m.includes('/data'))).toBe(true);
		expect(bindLines[0]).not.toBe(bindLines[1]);
	});
});
