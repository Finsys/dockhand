/**
 * backups/backup-service.ts — orchestrates ONE backup, and nothing else.
 *
 * The pipeline is a fail-fast sequence; each phase gates the next:
 *
 *   validate → claim locks → discover volumes → (stop for consistency) →
 *   run the session container → VERIFY the snapshot is readable → commit →
 *   apply retention → (restart)
 *
 * Safety properties enforced here (each has a behavioural test):
 *   - a backup is recorded success ONLY IF the helper exited 0 (an undefined
 *     exit is failure) AND a snapshot id was parsed from restic's output;
 *   - after the snapshot is recorded it is VERIFIED readable before success is
 *     declared and before retention runs (so a green-but-unusable snapshot can't
 *     slip through, and retention never prunes good snapshots for a bad one);
 *   - any target container that fails to inspect aborts the backup (no partial
 *     snapshot reaches retention);
 *   - retention refuses a policy that would delete every snapshot in the group;
 *   - the target is stopped only if configured, and the restart is bound to the
 *     same scope as the stop so no path can skip it; a restart failure is
 *     SURFACED (warning + notification), never silently swallowed;
 *   - two operations on the same live target are rejected; operations on one repo
 *     are serialized.
 *
 * All external effects come through the injected `BackupPorts`, so the whole
 * pipeline is testable against fakes.
 */
import {
	BackupError,
	buildSnapshotTags,
	retentionTagFilter,
	parseResticBackupSummary,
	resticOk,
	resticPartial,
	type BackupResult,
	type BackupTargetType,
	type ResticRun,
} from './models';
import { SWAP_ARTIFACTS } from './swap';
import { cleanErrorMsg } from './helpers';
import { buildBackupScript, buildBackupArgs, type MetadataFile } from './backup-script';
import { EXIT_MARKER } from './restic-script';
import { parseRetention, buildForgetArgs, checkWouldWipe, retentionActive } from './retention';
import { liveTargetKey } from './locks';
import type { DiscoveredVolume } from './discovery-core';
import { formatBytes } from '../../utils/format';
import { STACKDIR_VOLUME_KEY, type StackDirProbeHint } from './stackdir-plan';

/** What the service needs from the outside world. All injected for testability. */
export interface BackupPorts {
	/** Resolve target containers for a config. */
	resolveTargets(type: BackupTargetType, targetName: string, envId: number | null | undefined):
		Promise<{ containers: Array<{ id: string; name: string; state: string }> }>;
	/** Discover volumes; MUST throw (fail closed) on any inspect failure. */
	discoverVolumes(containers: Array<{ id: string; name: string }>, envId: number | null | undefined, selected: string[] | null):
		Promise<{ volumes: DiscoveredVolume[]; skipped: Array<{ type: string; destination: string; reason: string }> }>;
	/** Decide how a STACK's directory is captured: locate the HOST folder and build the synthetic
	 * __dockhand_stackdir__ volume the helper bind-mounts (`kind: 'candidate'`). The stack files
	 * are ALWAYS read from the host where the stack runs - never from Dockhand's own copy.
	 * `composeFileName` feeds the in-helper probe (assert the compose is visible under the mount).
	 * `kind: 'unknown'` means the host folder can't be located (not compose-managed, or a remote
	 * env with no Remote stacks directory) -> the caller HARD-FAILS the backup. Logged inside this port. */
	planStackDirVolume(targetName: string, envId: number | null | undefined, excludedStackFiles?: string[]):
		Promise<
			| { kind: 'unknown'; reason: string }
			| { kind: 'candidate'; syntheticVolume: DiscoveredVolume; volumeKey: string; composeFileName: string; excludePaths: string[]; bindSources: string[]; probeHint?: StackDirProbeHint }
		>;
	/** Stop the target for a consistent backup; returns a restart closure. */
	stopForBackup(type: BackupTargetType, targetName: string, containers: Array<{ id: string; name: string; state: string }>, envId: number | null | undefined):
		Promise<{ restart: () => Promise<{ failed: Array<{ name: string; error: string }> }> }>;
	/** Run the backup session container; returns the restic run. metadataFiles (metadata.json
	 * + the light stack-dir listing) are put-archived into /metadata (not the Cmd) so they
	 * can't blow ARG_MAX. The stack dir's bytes ride a host bind mount, not these files. */
	runInHelper(spec: { args?: string[]; script: string; binds: string[]; envId: number | null | undefined; name: string; metadataFiles?: MetadataFile[]; onStderr?: (line: string) => void; onStdout?: (line: string) => void }):
		Promise<ResticRun>;
	/** Run a repo-only restic command on the host (verify / retention). */
	runLocal(args: string[], tier?: 'interactive' | 'data'): Promise<ResticRun>;
	/** Collect the restore metadata files: metadata.json plus, for a stack, a light file
	 * listing. The stack dir's bytes ride the helper's host bind mount, not these files. */
	collectMetadata(type: BackupTargetType, targetName: string, envId: number | null | undefined, volumes: DiscoveredVolume[]):
		Promise<{ files: MetadataFile[] }>;
	/** The Dockhand host name for restic --host. */
	host(): string;
	/** This installation's stable instance id. */
	instanceId(): Promise<string>;
	/** The live-target mutex: returns a release fn, or null if already held. */
	acquireLiveTarget(key: string): (() => void) | null;
	/** True if the user asked to cancel this config's in-flight backup — used to
	 *  report a killed helper's non-zero exit as "cancelled", not a restic failure. */
	isCancelling(configId: number): boolean;
	/** Serialize on a destination; runs fn behind the per-destination queue. */
	serializeDestination<T>(destinationId: number, fn: () => Promise<T>): Promise<T>;
	/** Open the operation record; returns handles to update + close it. */
	openOperation(entityName: string, scheduleId: number, environmentId: number | null, triggeredBy: 'cron' | 'manual' | 'webhook', onProgress?: (s: string, m: string) => void):
		Promise<OperationHandle>;
	/** Fire a notification (non-fatal — never changes the backup outcome). */
	notify(event: 'backup_success' | 'backup_failed', payload: Record<string, unknown>, envId: number | null | undefined): Promise<void>;
	/** Fire a per-config webhook to a user-supplied URL (non-fatal, fire-and-forget). */
	fireWebhook(url: string, payload: Record<string, unknown>): void;
	/** Persist the config's last-backup status. */
	setConfigStatus(configId: number, status: 'success' | 'failed'): Promise<void>;
}

export interface OperationHandle {
	id: number;
	progress(status: string, message: string): void;
	log(message: string): void;
	close(outcome:
		| { kind: 'ok' }
		| { kind: 'warning'; message: string }
		| { kind: 'error'; code: BackupError['code']; message: string }
		| { kind: 'cancelled'; message?: string },
		details?: Record<string, unknown>): Promise<void>;
	skip(reason: string): Promise<void>;
}

/** The config fields the service needs (already loaded + validated by the caller). */
export interface BackupJob {
	configId: number;
	type: BackupTargetType;
	targetName: string;
	environmentId: number | null;
	destinationId: number;
	allVolumes: boolean;
	selectedVolumes: string[] | null;
	stopBeforeBackup: boolean;
	retention: string | null | Record<string, unknown>;
	options: { excludePatterns?: string[]; excludeCaches?: boolean; compression?: string; limitUpload?: number; limitDownload?: number; webhookSuccess?: string; webhookFailure?: string; excludedStackFiles?: string[] };
	helperName: string;
}

export class BackupService {
	constructor(private ports: BackupPorts) {}

	/**
	 * Run a backup for one job. Returns an explicit BackupResult — never throws to
	 * the caller (all errors become an `error` result with a machine code).
	 */
	async run(job: BackupJob, triggeredBy: 'cron' | 'manual' | 'webhook'): Promise<BackupResult> {
		const envId = job.environmentId;
		const startTime = Date.now();

		// --- discover targets first (need the volume identity for the lock key) ---
		let containers: Array<{ id: string; name: string; state: string }>;
		let volumes: DiscoveredVolume[];
		// The stack dir is captured by the helper's HOST bind mount (a synthetic
		// __dockhand_stackdir__ volume). `stackDirProbe` carries what the helper needs to
		// assert that mount is real (test -f the compose) before restic runs. Null for
		// containers (no stack dir).
		let stackDirProbe: { volumeKey: string; composeFileName: string; hostPath?: string; hint?: StackDirProbeHint } | null = null;
		// restic --exclude paths for compose bind dirs inside the stackdir volume (they are
		// captured separately as their own /volumes/<key>, honoring volume selection).
		let stackDirExcludes: string[] = [];
		try {
			const t = await this.ports.resolveTargets(job.type, job.targetName, envId);
			containers = t.containers;
			if (containers.length === 0) {
				// "No containers", not "no RUNNING containers": a stopped-but-existing
				// target backs up fine (resolveTargets lists all states). This only
				// fires when nothing matches the name at all (target deleted).
				return this.earlySkipOrError(job, triggeredBy,
					`No ${job.type === 'stack' ? 'containers for stack' : 'container'} "${job.targetName}" found — refusing to back up nothing.`);
			}
			const d = await this.ports.discoverVolumes(containers, envId, job.allVolumes ? null : job.selectedVolumes);
			volumes = d.volumes;
			// A target with no volumes/binds is fine: metadata.json (the container/stack
			// config, and for stacks the compose files) is always captured, so the
			// snapshot is a config-only backup — restorable via recreate/redeploy.

			// For a STACK, always capture the whole stack dir by bind-mounting it from the
			// TARGET daemon's HOST (__dockhand_stackdir__). The plan locates the host folder
			// from the compose working_dir label; a stack with no such label is not
			// compose-managed, so we HARD-FAIL rather than silently skip its files (option A).
			// The synthetic volume rides the same helper-bind + lock machinery as any volume.
			if (job.type === 'stack') {
				const p = await this.ports.planStackDirVolume(job.targetName, envId, job.options.excludedStackFiles);
				if (p.kind === 'unknown') {
					return this.earlySkipOrError(job, triggeredBy,
						`Cannot locate the stack folder on the host for "${job.targetName}" (${p.reason}). ` +
						`For remote environments, set a Remote stack path (for backup) in Settings > Environments so the stack files exist on the Docker host. ` +
						`Refusing to write a backup missing the stack's compose and config.`);
				} else {
					volumes = [...volumes, p.syntheticVolume];
					stackDirProbe = { volumeKey: p.volumeKey, composeFileName: p.composeFileName, hostPath: p.syntheticVolume.source ?? undefined, hint: p.probeHint };
					stackDirExcludes = p.excludePaths;
				}
			}
			} catch (err) {
				return this.errorResult(err);
			}

		// --- claim the live-target mutex (reject a concurrent op on this data) ---
		// fallback identity keeps config-only targets (no volumes) from colliding on ${env}::
		const key = liveTargetKey(envId, volumes.map((v) => v.bind), `${job.type}:${job.targetName}`);
		const release = this.ports.acquireLiveTarget(key);
		if (!release) {
			return { status: 'skipped', reason: `Another backup or restore is already running for "${job.targetName}".` };
		}

		// Release exactly once. runLocked releases the live-target lock as soon as
		// the last live-volume/container step (the restart) is done — verify and
		// retention are repo-only ops that don't touch the live target, so holding
		// the lock across them would needlessly make a follow-up restore see
		// 'skipped' while the backup is only doing repo maintenance. The finally is
		// the backstop: it still fires on any early return/throw (double-release is
		// a no-op via releaseOnce).
		let released = false;
		const releaseOnce = () => { if (!released) { released = true; release(); } };
		try {
			// --- serialize on the destination (share the repo, one at a time) ---
			return await this.ports.serializeDestination(job.destinationId, () =>
				this.runLocked(job, triggeredBy, containers, volumes, stackDirProbe, stackDirExcludes, startTime, releaseOnce));
		} finally {
			releaseOnce();
		}
	}

	/** The core pipeline, run while holding both locks. `releaseLiveTarget` frees
	 * the live-target mutex early — as soon as the restart (the last live-target
	 * step) completes — so a follow-up restore doesn't see 'skipped' while this
	 * backup is only doing repo-side verify/retention. The caller's finally still
	 * guarantees release on any error path (releaseOnce is idempotent). */
	private async runLocked(
		job: BackupJob,
		triggeredBy: 'cron' | 'manual' | 'webhook',
		containers: Array<{ id: string; name: string; state: string }>,
		volumes: DiscoveredVolume[],
		stackDirProbe: { volumeKey: string; composeFileName: string; hostPath?: string; hint?: StackDirProbeHint } | null,
		stackDirExcludes: string[],
		startTime: number,
		releaseLiveTarget: () => void,
	): Promise<BackupResult> {
		const envId = job.environmentId;
		const op = await this.ports.openOperation(job.targetName, job.configId, envId, triggeredBy);
		let restart: (() => Promise<{ failed: Array<{ name: string; error: string }> }>) | null = null;
		let restarted = false;

		// Two log tiers, both stamped with a wall-clock ISO time and the {env,target}
		// key so any line can be lined up with the shard test log by time and target:
		//   log()  - always on. The lines an operator wants: started / snapshot created /
		//            completed / failed. Plain and self-explanatory, no scary internals.
		//   diag() - behind BACKUP_DIAG=1 (CI turns it on). Deep internals: repo/lock
		//            pre-probes, instance identity, micro-phase timings. Noise for a user,
		//            gold for a CI flake.
		const key = `${job.targetName} env=${envId}`;
		const t0 = Date.now();
		const log = (msg: string) => console.log(`[backup] ${new Date().toISOString()} ${key} | ${msg}`);
		const diagOn = process.env.BACKUP_DIAG === '1';
		const diag = (phase: string, extra?: string) => {
			if (!diagOn) return;
			console.log(`[backup] ${new Date().toISOString()} ${key} cfg=${job.configId} op=${op.id} | ${phase} @${Date.now() - t0}ms${extra ? ' | ' + extra : ''}`);
		};
		log(`started (${triggeredBy})`);
		if (diagOn) {
			diag('START', `stopBeforeBackup=${job.stopBeforeBackup} retention=${JSON.stringify(job.retention)}`);
			try {
				const cfg = await this.ports.runLocal(['cat', 'config', '--no-lock'], 'interactive');
				diag('REPO_PROBE', `cat-config exit=${cfg.exitCode} (${cfg.exitCode === 10 ? 'NOT-INITIALISED' : cfg.exitCode === 0 ? 'exists' : 'error'})`);
			} catch (e) { diag('REPO_PROBE', `cat-config THREW ${e instanceof Error ? e.message : String(e)}`); }
			try {
				const locks = await this.ports.runLocal(['list', 'locks', '--no-lock'], 'interactive');
				const lockLines = (locks.stdout || '').trim().split('\n').filter(Boolean);
				diag('LOCK_PROBE', `list-locks exit=${locks.exitCode} heldLocks=${lockLines.length}${lockLines.length ? ' [' + lockLines.join(',').slice(0, 120) + ']' : ''}`);
			} catch (e) { diag('LOCK_PROBE', `list-locks THREW ${e instanceof Error ? e.message : String(e)}`); }
		}

		try {
			// --- optionally stop the target for a consistent snapshot ---
			if (job.stopBeforeBackup) {
				op.progress('stopping', `Stopping ${job.targetName} for a consistent backup...`);
				const stopped = await this.ports.stopForBackup(job.type, job.targetName, containers, envId);
				restart = stopped.restart;
			}

			// --- metadata + backup args + session script ---
			op.progress('metadata', 'Collecting metadata...');
			const { files: metadata } = await this.ports.collectMetadata(job.type, job.targetName, envId, volumes);
			const instanceId = await this.ports.instanceId();
			const tags = buildSnapshotTags({ instanceId, configId: job.configId, environmentId: envId, targetName: job.targetName, type: job.type });
			// Cross-shard identity. If two shards log the SAME instanceId + configId
			// (they share a cloned DB) AND the same repo, their snapshots/retention
			// collide. host() + destinationId show which repo this run targets, so a
			// CI log across shards reveals any overlap.
			diag('IDENTITY', `instanceId=${instanceId} host=${this.ports.host()} destId=${job.destinationId} tags=[${tags.join(',')}]`);
			// restic backs up /volumes/ when there's anything to capture there: real bind/named
			// volumes OR the synthetic __dockhand_stackdir__ volume (both are in `volumes`).
			const args = buildBackupArgs({
				host: this.ports.host(),
				tags,
				hasVolumes: volumes.length > 0,
				// User excludes PLUS the compose bind dirs inside the stackdir volume (those
				// ride their own /volumes/<key>, so excluding them here avoids a duplicate and
				// keeps volume DESELECTION meaningful for in-folder binds).
				excludePatterns: [...(job.options.excludePatterns ?? []), ...stackDirExcludes],
				excludeCaches: job.options.excludeCaches,
				compression: job.options.compression,
				limitUpload: job.options.limitUpload,
				limitDownload: job.options.limitDownload,
				swapArtifacts: SWAP_ARTIFACTS,
			});
			const script = buildBackupScript(
				args,
				stackDirProbe ? { ...stackDirProbe, label: `env=${envId} target=${job.targetName}` } : undefined
			);
			const binds = volumes.map((v) => v.bind);

			// Echo the options actually applied to the restic run, so the execution
			// log records what took effect (not just what was saved on the config).
			const o = job.options;
			if (o.compression) op.log(`Compression: ${o.compression}`);
			if (o.limitUpload) op.log(`Upload limit: ${o.limitUpload}`);
			if (o.limitDownload) op.log(`Download limit: ${o.limitDownload}`);
			if (o.excludeCaches !== false) op.log('Exclude caches: yes');
			if (o.excludePatterns && o.excludePatterns.length) op.log(`Exclude patterns: ${o.excludePatterns.join(', ')}`);
			// Record WHICH volumes were actually selected (not just the count), so a
			// regression in the selectedVolumes filter is visible in the execution log.
			op.log(`Volumes to backup: ${volumes.map((v) => v.name).join(', ') || 'none'}`);

			// --- clear any STALE repo lock before backing up ---
			// A prior backup/restore that was killed or crashed (helper OOM, host
			// restart, cancelBackup) leaves restic's repo lock orphaned. The next op
			// to that repo would otherwise wait out `--retry-lock` for a lock whose owner
			// is already dead.
			//
			// Deliberately a PLAIN `unlock`, NOT `--remove-all`: this runs AUTOMATICALLY
			// before every backup, and the per-repo serializer is per-INSTANCE — it does
			// NOT see a SEPARATE Dockhand instance's LIVE lock on a shared repo. A blind
			// --remove-all here would silently wipe that other instance's in-flight
			// backup lock. Plain unlock only reaps locks restic can prove stale, so it's
			// safe against a live foreign lock (leaves it), and our shortened
			// forget --retry-lock (retention.ts) already stops retention hanging on any
			// orphan it doesn't clear. To force-clear a stuck orphan whose hostname
			// restic won't age out, the user runs the explicit Unlock action
			// (unlockRepository → --remove-all), where "no other op is running" is their
			// call to make. Best-effort: failing never blocks the backup.
			try {
				await this.ports.runLocal(['unlock']);
			} catch { /* best-effort — restic --retry-lock remains the backstop */ }

			// --- run the session container ---
			// List exactly what's being backed up (name + vol/bind marker) so the log
			// says WHICH volumes, not just how many. A bind's `name` is its host path.
			// These are 'backing-up' (not 'progress') status lines, so they're ALWAYS
			// persisted — the throttle only applies to the restic 'progress' spam.
			if (volumes.length === 0) {
				op.progress('backing-up', 'Backing up (config only — no volumes)...');
			} else {
				op.progress('backing-up', `Backing up ${volumes.length} ${volumes.length === 1 ? 'volume' : 'volumes'}:`);
				for (const v of volumes) {
					// A bind's `name` is only its container destination, so two binds to the same
					// path (e.g. /data) read identically. Show `host-source -> destination` so each
					// is distinguishable in the log (#1373).
					const label = v.name === STACKDIR_VOLUME_KEY
						? 'Stack data'
						: v.type === 'bind'
							? `${v.source} → ${v.name}`
							: v.name;
					op.progress('backing-up', `  • [${v.type === 'bind' ? 'BIND' : 'VOL'}] ${label}`);
				}
			}
			// Did the LIVE stdout stream deliver anything? restic writes its --json
			// progress to STDOUT (forwarded via onStdout); but live stdout only
			// works on transports that stream it (local socket/http); if nothing arrives
			// live, we MUST still emit restic's output post-exit from run.stdout — else
			// the log shows only our own stage markers and no restic lines at all (a
			// This flag drives that fallback.
			let liveStdoutSeen = false;
			const run = await this.ports.runInHelper({
				script, binds, envId, name: job.helperName, metadataFiles: metadata,
				// Stream restic's own output to the UI LIVE: restic writes its --json
				// progress (per-file %) to STDOUT and its status messages to STDERR. Wire
				// BOTH so the log fills in as the backup runs, not all at once at the end.
				// The exit-marker line is internal bookkeeping (readExitMarker) — never
				// show it. `run.stdout` below stays the authoritative copy for parsing.
				onStderr: (line) => { for (const l of formatResticLines(line)) op.progress('progress', `[restic] ${l}`); },
				onStdout: (line) => { for (const l of formatResticLines(line)) if (!l.includes(EXIT_MARKER)) { liveStdoutSeen = true; op.progress('progress', `[restic] ${l}`); } },
			});

			// Fallback: if live stdout streaming produced nothing (transport didn't
			// stream it), emit restic's buffered stdout now so the log always shows what
			// restic actually did.
			if (!liveStdoutSeen) {
				for (const l of formatResticLines(run.stdout)) {
					if (!l.includes(EXIT_MARKER)) op.progress('progress', `[restic] ${l}`);
				}
			}

			// --- verify the OUTCOME: exit 0/3 AND a parsed snapshot id ---
			if (!resticOk(run) && !resticPartial(run)) {
				throw new BackupError('RESTIC', run.stderr.trim() || 'restic backup failed', { exitCode: run.exitCode });
			}
			const summary = parseResticBackupSummary(run.stdout);
			if (!summary) {
				// No summary ⇒ unknown outcome ⇒ NOT a success (never record a phantom).
				throw new BackupError('INTEGRITY', 'backup produced no snapshot summary — treating as failed');
			}
			// A partial is restic's own "couldn't read all files" (exit 3). A stack dir
			// over the capture cap is no longer a partial — it hard-fails in collectMetadata.
			const partial = resticPartial(run);

			// --- VERIFY the snapshot is actually readable before declaring success ---
			log(`snapshot ${summary.snapshotId.slice(0, 8)} created, verifying`);
			op.progress('verifying', 'Verifying the snapshot is readable...');
			diag("BEFORE_VERIFY", "snapshot=" + summary.snapshotId);
			await this.verifySnapshot(summary.snapshotId, instanceId);

			// --- commit: record success + config status ---
			await this.ports.setConfigStatus(job.configId, 'success');

			// --- restart (bound to the same scope as the stop) ---
			// Restart is the LAST step that touches the live target. Do it before
			// retention, then release the live-target lock: retention is a repo-only
			// forget/prune (already serialized per-destination) and a concurrent
			// restore neither reads nor writes the live volume during it.
			diag("BEFORE_RESTART");
			await this.restartAndSurface(restart, job, op);
			restarted = true;
			releaseLiveTarget();

			// --- retention: ONLY now, after a confirmed + verified snapshot AND
			// after the live target is back up + its lock freed ---
			diag("BEFORE_RETENTION");
			const retentionOutcome = await this.applyRetention(job, instanceId, op);

			const details = {
				snapshotId: summary.snapshotId,
				volumes: volumes.map((v) => v.name),
				dataAdded: summary.dataAdded,
				filesNew: summary.filesNew,
				filesChanged: summary.filesChanged,
				retention: retentionOutcome,
			};
			if (partial) {
				log(`completed with warnings (partial read) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
				await op.close({ kind: 'warning', message: 'Backup completed with warnings (some files could not be read).' }, details);
				await this.notifySuccess(job, summary, envId, true, op.id, startTime);
				return { status: 'warning', executionId: op.id, snapshotId: summary.snapshotId, summary, warning: 'partial read', retention: retentionOutcome };
			}
			log(`completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
			diag("BEFORE_CLOSE");
			await op.close({ kind: 'ok' }, details);
			await this.notifySuccess(job, summary, envId, false, op.id, startTime);
			return { status: 'success', executionId: op.id, snapshotId: summary.snapshotId, summary, retention: retentionOutcome };
		} catch (err) {
			// If the user cancelled THIS backup, its helper was SIGINT/SIGKILL'd — the
			// resulting non-zero exit (137) is not a real failure. Report it as cancelled
			// with a clean message instead of the raw restic exit spew.
			if (this.ports.isCancelling(job.configId)) {
				log('cancelled by user');
				if (!restarted) await this.restartAndSurface(restart, job, op);
				try { await this.ports.runLocal(['unlock']); } catch { /* best-effort */ }
				try { await this.ports.setConfigStatus(job.configId, 'failed'); } catch { /* non-fatal */ }
				await op.close({ kind: 'cancelled', message: 'Backup cancelled' });
				return { status: 'skipped', executionId: op.id, reason: 'Backup cancelled' };
			}
			// Log the FULL raw error to the server log (docker logs dockhand) before it's
			// cleaned for the UI — the raw text (restic JSON spew, exit code, stderr) is
			// what we actually need to diagnose a failure, and cleanErrorMsg strips it.
			log(`failed after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
			console.error(`[backup] ${new Date().toISOString()} ${key} | raw error:`, err instanceof Error ? (err.stack ?? err.message) : String(err));
			// Always try to restart what we stopped, even on failure — unless the
			// success path already restarted it (avoid a double start).
			if (!restarted) await this.restartAndSurface(restart, job, op);
			// Clean up the repo lock this failed/killed backup may have orphaned, so
			// the NEXT op to this repo doesn't wait out `--retry-lock` on a dead
			// owner. Still behind the per-destination serializer here. Best-effort.
			try { await this.ports.runLocal(['unlock']); } catch { /* best-effort */ }
			const { code, message } = errorInfo(err);
			try { await this.ports.setConfigStatus(job.configId, 'failed'); } catch { /* non-fatal */ }
			await op.close({ kind: 'error', code, message }, { errorCode: code });
			try { await this.ports.notify('backup_failed', { title: 'Backup failed', message: `Backup of "${job.targetName}" failed: ${message} (${code})`, type: 'error', target: job.targetName, kind: 'backup', errorCode: code, message }, envId); } catch { /* non-fatal */ }
			// Per-config failure webhook.
			if (job.options.webhookFailure) {
				try {
					this.ports.fireWebhook(job.options.webhookFailure, {
						event: 'backup_failed',
						executionId: op.id,
						errorCode: code,
						target: job.targetName,
						type: job.type,
						error: message,
						duration: Date.now() - startTime,
					});
				} catch { /* webhook failure never changes the outcome */ }
			}
			return { status: 'error', executionId: op.id, code, error: message };
		}
	}

	/** Verify the just-written snapshot exists + is readable for our instance. */
	private async verifySnapshot(snapshotId: string, instanceId: string): Promise<void> {
		const run = await this.ports.runLocal(['snapshots', '--json', '--no-lock', '--tag', `dockhand:instance=${instanceId}`, snapshotId]);
		if (run.exitCode !== 0 || !run.stdout.includes(snapshotId.slice(0, 8))) {
			throw new BackupError('INTEGRITY', 'the new snapshot could not be verified as readable — not declaring success');
		}
	}

	/** Apply retention if configured, guarded against a delete-everything policy.
	 * Verbosely logged: retention needs an EXCLUSIVE repo lock, so it's the phase most
	 * likely to stall (on an orphaned or another-instance lock). Timing each restic call
	 * makes a "why did my backup take so long / why is retention not pruning" report
	 * self-diagnosing from the operation log. */
	private async applyRetention(job: BackupJob, instanceId: string, op: OperationHandle): Promise<string> {
		const policy = parseRetention(job.retention);
		if (!retentionActive(policy)) { op.log('Retention: none configured — keeping all snapshots.'); return 'none'; }

		const filter = retentionTagFilter(instanceId, job.configId);
		op.log(`Retention: applying policy for config ${job.configId} (needs an exclusive repo lock).`);

		// Dry-run first: refuse if it would wipe every snapshot.
		const dry = buildForgetArgs(policy, filter, { dryRun: true, json: true })!;
		const t0 = Date.now();
		const dryRun = await this.ports.runLocal(dry, 'data');
		const dryMs = Date.now() - t0;
		// A slow dry-run means the exclusive lock was contended (orphan or another
		// instance) and forget spent time on --retry-lock — surface it so the operator
		// can see the wait, not just the eventual result.
		if (dryMs > 5000) op.log(`Retention: dry-run took ${(dryMs / 1000).toFixed(1)}s (waited on the repo lock).`);
		if (dryRun.exitCode !== 0) {
			op.progress('warning', `Retention dry-run failed (exit ${dryRun.exitCode}): ${dryRun.stderr.trim() || 'restic failed'} — skipping retention, backup is still safe.`);
			return 'failed';
		}
		if (checkWouldWipe(dryRun.stdout).wouldWipe) {
			op.progress('warning', 'Retention would delete every snapshot for this config — skipping retention.');
			return 'skipped-would-wipe';
		}
		// forget only removes snapshot references (fast, metadata) — NO --prune here, so a
		// backup never hangs reclaiming space. The destination's prune schedule reclaims it.
		op.progress('pruning', 'Applying retention...');
		const forget = buildForgetArgs(policy, filter)!;
		const t1 = Date.now();
		const run = await this.ports.runLocal(forget, 'data');
		const forgetMs = Date.now() - t1;
		if (run.exitCode !== 0) {
			// A forget failure is non-fatal (the backup itself succeeded) but surfaced.
			// The common non-fatal case: --retry-lock elapsed because another op (an
			// orphaned lock, or a second Dockhand instance sharing this repo) held the
			// lock — retention just runs next schedule; no snapshot is lost.
			op.progress('warning', `Retention failed after ${(forgetMs / 1000).toFixed(1)}s (exit ${run.exitCode}): ${run.stderr.trim() || 'restic failed'} — backup is safe, retention will retry next run.`);
			return 'failed';
		}
		op.log(`Retention: applied in ${(forgetMs / 1000).toFixed(1)}s.`);
		return 'applied';
	}

	/** Run the restart closure (if any) and SURFACE a restart failure. On a clean
	 * restart, clear the durable stop intent (happy path leaves no stale row); on a
	 * restart FAILURE, KEEP the intent so a later startup retries the restart. */
	private async restartAndSurface(
		restart: (() => Promise<{ failed: Array<{ name: string; error: string }> }>) | null,
		job: BackupJob,
		op: OperationHandle,
	): Promise<void> {
		if (!restart) return;
		let failed: Array<{ name: string; error: string }> = [];
		try {
			({ failed } = await restart());
		} catch (err) {
			failed = [{ name: job.targetName, error: err instanceof Error ? err.message : String(err) }];
		}
		if (failed.length > 0) {
			const names = failed.map((f) => f.name).join(', ');
			const msg = `Backup finished but ${names} could not be restarted and is STILL STOPPED — start it manually.`;
			op.progress('warning', msg);
			try { await this.ports.notify('backup_failed', { title: 'Backup: container not restarted', message: msg, type: 'error', target: job.targetName, kind: 'backup', errorCode: 'STOPPED_RESTART_FAILED' }, job.environmentId); } catch { /* non-fatal */ }
		} else {
			op.progress('restarted', `${job.targetName} restarted.`);
		}
	}

	private async notifySuccess(
		job: BackupJob,
		summary: { snapshotId: string; dataAdded: number; filesNew: number; filesChanged: number },
		envId: number | null,
		partial: boolean,
		executionId: number,
		startTime: number,
	): Promise<void> {
		try {
			await this.ports.notify('backup_success', {
				title: partial ? 'Backup completed (partial)' : 'Backup completed',
				message: `Backup of "${job.targetName}" ${partial ? 'completed with warnings' : 'completed successfully'} (snapshot ${summary.snapshotId}, +${formatBytes(summary.dataAdded)})`,
				type: partial ? 'warning' : 'success',
				target: job.targetName, kind: 'backup', snapshotId: summary.snapshotId,
				dataAdded: summary.dataAdded, partial,
			}, envId);
		} catch { /* notification failure never changes the outcome */ }
		// Per-config success webhook.
		if (job.options.webhookSuccess) {
			try {
				this.ports.fireWebhook(job.options.webhookSuccess, {
					event: 'backup_success',
					executionId,
					target: job.targetName,
					type: job.type,
					snapshotId: summary.snapshotId,
					filesNew: summary.filesNew,
					filesChanged: summary.filesChanged,
					dataAdded: summary.dataAdded,
					duration: Date.now() - startTime,
				});
			} catch { /* webhook failure never changes the outcome */ }
		}
	}

	/** The backup target (container/stack) doesn't exist — record the op and fail
	 * with a validation error (there is genuinely nothing to back up). Close the durable
	 * execution row as a FAILED/VALIDATION error, NOT op.skip() — skip() hardcodes
	 * CONCURRENCY + skipped:true, which would log a benign-looking "skipped" row while the
	 * API returns VALIDATION. An operator filtering for failed backups would then never see
	 * that this config has been backing up nothing (its target is gone). */
	private async earlySkipOrError(job: BackupJob, triggeredBy: 'cron' | 'manual' | 'webhook', reason: string): Promise<BackupResult> {
		try {
			const op = await this.ports.openOperation(job.targetName, job.configId, job.environmentId, triggeredBy);
			await op.close({ kind: 'error', code: 'VALIDATION', message: reason });
			return { status: 'error', executionId: op.id, code: 'VALIDATION', error: reason };
		} catch {
			return { status: 'error', code: 'VALIDATION', error: reason };
		}
	}

	private errorResult(err: unknown): BackupResult {
		const { code, message } = errorInfo(err);
		return { status: 'error', code, error: message };
	}
}

// --- small pure helpers ------------------------------------------------------

function errorInfo(err: unknown): { code: BackupError['code']; message: string } {
	// cleanErrorMsg unwraps embedded daemon JSON (e.g. Docker's pull error
	// `{"message":"failed to resolve reference …: not found"}`) so the UI shows a
	// readable sentence instead of raw JSON — consistently, for every failure path.
	const raw = err instanceof BackupError ? err.message : (err instanceof Error ? err.message : String(err));
	const code = err instanceof BackupError ? err.code : 'UNKNOWN';
	return { code, message: cleanErrorMsg(raw) };
}

/** Turn a chunk of restic output (may hold several newline-separated lines) into
 * human-readable log lines for the UI. restic --json emits one JSON object per line
 * (status/summary/verbose_status/error); anything else (plain restic/-shell text) is
 * passed through verbatim so nothing is hidden. Returns [] for blank/noise-only input. */
export function formatResticLines(chunk: string): string[] {
	const out: string[] = [];
	for (const raw of chunk.split('\n')) {
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		let o: any;
		try { o = JSON.parse(line.trim()); } catch { out.push(line); continue; }
		if (!o || typeof o !== 'object' || !o.message_type) { out.push(line); continue; }
		switch (o.message_type) {
			case 'status':
				if (typeof o.percent_done === 'number') {
					const pct = `${Math.round(o.percent_done * 100)}% done`;
					const cur = Array.isArray(o.current_files) && o.current_files.length ? ` — ${o.current_files[0]}` : '';
					out.push(pct + cur);
				}
				break;
			case 'summary': {
				const n = o.files_new ?? 0, c = o.files_changed ?? 0, u = o.files_unmodified ?? 0;
				const mb = typeof o.data_added === 'number' ? ` · ${(o.data_added / 1e6).toFixed(1)} MB added` : '';
				out.push(`Done: ${n} new, ${c} changed, ${u} unchanged${mb}`);
				break;
			}
			case 'error':
				out.push(`error: ${o.error?.message ?? o.item ?? JSON.stringify(o)}`);
				break;
			default:
				// verbose_status / anything else — show the raw line so nothing is lost.
				out.push(line);
		}
	}
	return out;
}
