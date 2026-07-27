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
import { stopIntentKey as stopIntentKeyFor } from './stop-recovery-core';
import type { DiscoveredVolume } from './discovery-core';

/** What a fresh process needs to restart a target stopped for a consistent
 * backup (or an in-place restore) after a crash between stop and restart. */
export interface StopIntent {
	type: BackupTargetType;
	targetName: string;
	envId: number | null;
	/** For a container target: the ids/names that were running and got stopped. */
	containers: Array<{ id: string; name: string }>;
}

/** What the service needs from the outside world. All injected for testability. */
export interface BackupPorts {
	/** Resolve target containers for a config. */
	resolveTargets(type: BackupTargetType, targetName: string, envId: number | null | undefined):
		Promise<{ containers: Array<{ id: string; name: string; state: string }> }>;
	/** Discover volumes; MUST throw (fail closed) on any inspect failure. */
	discoverVolumes(containers: Array<{ id: string; name: string }>, envId: number | null | undefined, selected: string[] | null):
		Promise<{ volumes: DiscoveredVolume[]; skipped: Array<{ type: string; destination: string; reason: string }> }>;
	/** Stop the target for a consistent backup; returns a restart closure. */
	stopForBackup(type: BackupTargetType, targetName: string, containers: Array<{ id: string; name: string; state: string }>, envId: number | null | undefined):
		Promise<{ restart: () => Promise<{ failed: Array<{ name: string; error: string }> }> }>;
	/** Persist a durable "this target was stopped for backup" intent BEFORE the
	 * stop, so a process death between stop and restart is recoverable on startup.
	 * Keyed on a stable per-target id (see stopIntentKey). */
	recordStopIntent(key: string, intent: StopIntent): Promise<void>;
	/** Clear the durable stop intent once the in-process restart has succeeded. */
	clearStopIntent(key: string): Promise<void>;
	/** Run the backup session container; returns the restic run. metadataFiles are
	 * streamed into /metadata via put-archive (not the Cmd) so large stack files
	 * don't blow ARG_MAX. */
	runInHelper(spec: { args?: string[]; script: string; binds: string[]; envId: number | null | undefined; name: string; metadataFiles?: MetadataFile[]; onStderr?: (line: string) => void; onStdout?: (line: string) => void }):
		Promise<ResticRun>;
	/** Run a repo-only restic command on the host (verify / retention). */
	runLocal(args: string[], tier?: 'interactive' | 'data'): Promise<ResticRun>;
	/** Collect the restore metadata files (metadata.json + stack files).
	 * `stackFilesTruncated` is true when a stack dir exceeded the capture cap, so
	 * the snapshot is an incomplete stack-file capture — the run is downgraded to
	 * a warning. */
	collectMetadata(type: BackupTargetType, targetName: string, envId: number | null | undefined, volumes: DiscoveredVolume[]):
		Promise<{ files: MetadataFile[]; stackFilesTruncated: boolean }>;
	/** The Dockhand host name for restic --host. */
	host(): string;
	/** This installation's stable instance id. */
	instanceId(): Promise<string>;
	/** The live-target mutex: returns a release fn, or null if already held. */
	acquireLiveTarget(key: string): (() => void) | null;
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
	options: { excludePatterns?: string[]; excludeCaches?: boolean; compression?: string; limitUpload?: number; limitDownload?: number; webhookSuccess?: string; webhookFailure?: string };
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
		} catch (err) {
			return this.errorResult(err);
		}

		// --- claim the live-target mutex (reject a concurrent op on this data) ---
		const key = liveTargetKey(envId, volumes.map((v) => v.bind));
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
				this.runLocked(job, triggeredBy, containers, volumes, startTime, releaseOnce));
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
		startTime: number,
		releaseLiveTarget: () => void,
	): Promise<BackupResult> {
		const envId = job.environmentId;
		const op = await this.ports.openOperation(job.targetName, job.configId, envId, triggeredBy);
		let restart: (() => Promise<{ failed: Array<{ name: string; error: string }> }>) | null = null;
		let restarted = false;
		let stopIntentKey: string | null = null;

		// ========================= @BACKUP-DIAG-TEMP =========================
		// TEMPORARY CI backup-flake diagnostics. Remove this whole block (and the other
		// `@BACKUP-DIAG-TEMP` markers below) once the flake is fixed:
		//   grep -rn '@BACKUP-DIAG-TEMP' src/lib/server/backups/backup-service.ts
		// Every log line is prefixed `[BACKUP-DIAG-TEMP]` for a one-shot log filter.
		// Gated behind BACKUP_DIAG=1 so it's silent unless CI turns it on.
		// Emits per-phase timing (backup/verify/restart/retention/close) + a repo
		// pre-probe (does the repo exist? is it locked?) to settle the "destination
		// points at a wiped/uninit repo" and "stale lock" hypotheses.
		const diagOn = process.env.BACKUP_DIAG === '1';
		const t0 = Date.now();
		const diag = (phase: string, extra?: string) => {
			if (!diagOn) return;
			const ms = Date.now() - t0;
			console.log(`[BACKUP-DIAG-TEMP] ${job.targetName} cfg=${job.configId} op=${op.id} env=${envId} | ${phase} @${ms}ms${extra ? ' | ' + extra : ''}`);
		};
		diag('START', `triggeredBy=${triggeredBy} stopBeforeBackup=${job.stopBeforeBackup} retention=${JSON.stringify(job.retention)}`);
		if (diagOn) {
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
		// ======================= end @BACKUP-DIAG-TEMP =======================

		try {
			// --- optionally stop the target for a consistent snapshot ---
			if (job.stopBeforeBackup) {
				op.progress('stopping', `Stopping ${job.targetName} for a consistent backup...`);
				// Record a durable stop intent BEFORE the stop, so a process death
				// between the stop and the restart leaves a row a fresh startup can
				// replay to bring the target back up (see reconcileOnStartup).
				const running = containers.filter((c) => c.state === 'running');
				if (running.length > 0) {
					stopIntentKey = stopIntentKeyFor(envId, job.type, job.targetName);
					await this.ports.recordStopIntent(stopIntentKey, {
						type: job.type, targetName: job.targetName, envId,
						containers: running.map((c) => ({ id: c.id, name: c.name })),
					});
				}
				const stopped = await this.ports.stopForBackup(job.type, job.targetName, containers, envId);
				restart = stopped.restart;
			}

			// --- metadata + backup args + session script ---
			op.progress('metadata', 'Collecting metadata...');
			const { files: metadata, stackFilesTruncated } = await this.ports.collectMetadata(job.type, job.targetName, envId, volumes);
			const instanceId = await this.ports.instanceId();
			const tags = buildSnapshotTags({ instanceId, configId: job.configId, environmentId: envId, targetName: job.targetName, type: job.type });
			// @BACKUP-DIAG-TEMP: cross-shard identity. If two shards log the SAME
			// instanceId + configId (they share a cloned DB) AND the same repo, their
			// snapshots/retention collide. host() + destinationId show which repo this
			// run targets, so a CI log across shards reveals any overlap.
			diag('IDENTITY', `instanceId=${instanceId} host=${this.ports.host()} destId=${job.destinationId} tags=[${tags.join(',')}]`);
			const args = buildBackupArgs({
				host: this.ports.host(),
				tags,
				hasVolumes: volumes.length > 0,
				excludePatterns: job.options.excludePatterns,
				excludeCaches: job.options.excludeCaches,
				compression: job.options.compression,
				limitUpload: job.options.limitUpload,
				limitDownload: job.options.limitDownload,
				swapArtifacts: SWAP_ARTIFACTS,
			});
			const script = buildBackupScript(args);
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
			// regression in the selectedVolumes filter is visible in the execution
			// log rather than silent (matches the legacy engine's log line).
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
					op.progress('backing-up', `  • [${v.type === 'bind' ? 'BIND' : 'VOL'}] ${v.name}`);
				}
			}
			// Did the LIVE stdout stream deliver anything? restic writes its --json
			// progress to STDOUT, which we forward via onStdout. But live stdout only
			// works on transports that stream it (local socket/http); if nothing arrives
			// live, we MUST still emit restic's output post-exit from run.stdout — else
			// the log shows only our own stage markers and no restic lines at all (a
			// regression). This flag drives that fallback.
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
			// restic actually did — the pre-live-streaming behaviour, kept as a safety net.
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
			// A partial is either restic's own "couldn't read all files" (exit 3) OR
			// a stack dir that exceeded the capture cap (snapshot is redeploy-incomplete).
			const partial = resticPartial(run) || stackFilesTruncated;

			// --- VERIFY the snapshot is actually readable before declaring success ---
			op.progress('verifying', 'Verifying the snapshot is readable...');
			diag("BEFORE_VERIFY", "snapshot=" + summary.snapshotId); // @BACKUP-DIAG-TEMP
			await this.verifySnapshot(summary.snapshotId, instanceId);

			// --- commit: record success + config status ---
			await this.ports.setConfigStatus(job.configId, 'success');

			// --- restart (bound to the same scope as the stop) ---
			// Restart is the LAST step that touches the live target. Do it before
			// retention, then release the live-target lock: retention is a repo-only
			// forget/prune (already serialized per-destination) and a concurrent
			// restore neither reads nor writes the live volume during it.
			diag("BEFORE_RESTART"); // @BACKUP-DIAG-TEMP
			await this.restartAndSurface(restart, job, op, stopIntentKey);
			restarted = true;
			releaseLiveTarget();

			// --- retention: ONLY now, after a confirmed + verified snapshot AND
			// after the live target is back up + its lock freed ---
			diag("BEFORE_RETENTION"); // @BACKUP-DIAG-TEMP
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
				const warnMsg = stackFilesTruncated
					? 'Backup completed with warnings: the stack directory exceeded the capture cap, so the snapshot is an incomplete stack-file capture (redeploy may be incomplete).'
					: 'Backup completed with warnings (some files could not be read).';
				await op.close({ kind: 'warning', message: warnMsg }, details);
				await this.notifySuccess(job, summary, envId, true, op.id, startTime);
				return { status: 'warning', executionId: op.id, snapshotId: summary.snapshotId, summary, warning: stackFilesTruncated ? 'stack files truncated' : 'partial read', retention: retentionOutcome };
			}
			diag("BEFORE_CLOSE"); // @BACKUP-DIAG-TEMP
			await op.close({ kind: 'ok' }, details);
			await this.notifySuccess(job, summary, envId, false, op.id, startTime);
			return { status: 'success', executionId: op.id, snapshotId: summary.snapshotId, summary, retention: retentionOutcome };
		} catch (err) {
			// Always try to restart what we stopped, even on failure — unless the
			// success path already restarted it (avoid a double start).
			if (!restarted) await this.restartAndSurface(restart, job, op, stopIntentKey);
			// Clean up the repo lock this failed/killed backup may have orphaned, so
			// the NEXT op to this repo doesn't wait out `--retry-lock` on a dead
			// owner. Still behind the per-destination serializer here. Best-effort.
			try { await this.ports.runLocal(['unlock']); } catch { /* best-effort */ }
			const { code, message } = errorInfo(err);
			try { await this.ports.setConfigStatus(job.configId, 'failed'); } catch { /* non-fatal */ }
			await op.close({ kind: 'error', code, message }, { errorCode: code });
			try { await this.ports.notify('backup_failed', { target: job.targetName, kind: 'backup', errorCode: code, message }, envId); } catch { /* non-fatal */ }
			// Per-config failure webhook — same payload shape as the legacy engine.
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
			op.progress('warning', `Retention dry-run failed (exit ${dryRun.exitCode}): ${dryRun.stderr.trim() || 'restic failed'} — skipping prune, backup is still safe.`);
			return 'failed';
		}
		if (checkWouldWipe(dryRun.stdout).wouldWipe) {
			op.progress('warning', 'Retention would delete every snapshot for this config — skipping prune.');
			return 'skipped-would-wipe';
		}
		op.progress('pruning', 'Applying retention...');
		const forget = buildForgetArgs(policy, filter)!;
		const t1 = Date.now();
		const run = await this.ports.runLocal(forget, 'data');
		const forgetMs = Date.now() - t1;
		if (run.exitCode !== 0) {
			// A prune failure is non-fatal (the backup itself succeeded) but surfaced.
			// The common non-fatal case: --retry-lock elapsed because another op (an
			// orphaned lock, or a second Dockhand instance sharing this repo) held the
			// lock — retention just runs next schedule; no snapshot is lost.
			op.progress('warning', `Retention prune failed after ${(forgetMs / 1000).toFixed(1)}s (exit ${run.exitCode}): ${run.stderr.trim() || 'restic failed'} — backup is safe, retention will retry next run.`);
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
		stopIntentKey: string | null,
	): Promise<void> {
		if (!restart) return;
		let failed: Array<{ name: string; error: string }> = [];
		try {
			({ failed } = await restart());
		} catch (err) {
			failed = [{ name: job.targetName, error: err instanceof Error ? err.message : String(err) }];
		}
		if (failed.length > 0) {
			// Restart failed — leave the durable intent for startup retry.
			const names = failed.map((f) => f.name).join(', ');
			const msg = `Backup finished but ${names} could not be restarted and is STILL STOPPED — start it manually.`;
			op.progress('warning', msg);
			try { await this.ports.notify('backup_failed', { target: job.targetName, kind: 'backup', errorCode: 'STOPPED_RESTART_FAILED', message: msg }, job.environmentId); } catch { /* non-fatal */ }
		} else {
			// Restart succeeded — drop the durable intent so no stale row remains.
			if (stopIntentKey) { try { await this.ports.clearStopIntent(stopIntentKey); } catch { /* non-fatal */ } }
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
				target: job.targetName, kind: 'backup', snapshotId: summary.snapshotId,
				dataAdded: summary.dataAdded, partial,
			}, envId);
		} catch { /* notification failure never changes the outcome */ }
		// Per-config success webhook — same payload shape as the legacy engine.
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
	 * with a validation error (there is genuinely nothing to back up). */
	private async earlySkipOrError(job: BackupJob, triggeredBy: 'cron' | 'manual' | 'webhook', reason: string): Promise<BackupResult> {
		try {
			const op = await this.ports.openOperation(job.targetName, job.configId, job.environmentId, triggeredBy);
			await op.skip(reason);
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
