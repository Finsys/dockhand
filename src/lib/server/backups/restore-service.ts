/**
 * backups/restore-service.ts — orchestrates ONE restore, with stronger safety
 * guards than backup because a restore can destroy live data.
 *
 * Two modes:
 *   new-location  (default, non-destructive): restic restores the requested
 *                 volumes into a fresh target directory. Nothing live is touched.
 *   in-place      (destructive, explicit intent required): restic restores each
 *                 volume into a staging dir on the live volume's own filesystem,
 *                 then a phase-marked swap commits it — never deleting the
 *                 original until the replacement is in place.
 *
 * Safety properties enforced here:
 *   - the caller must OWN the snapshot (instance + environment) before any read;
 *   - an in-place restore requires explicit confirmation (validator + service, defence in depth);
 *   - the requested volumes must exist in the snapshot before anything live is
 *     touched (so a typo can't wipe a volume for a restore that then fails);
 *   - a failed/interrupted swap leaves live data intact;
 *   - two operations on the same live target are rejected; ops on one repo serialize;
 *   - the restore never records success on an unknown outcome (undefined exit).
 */
import {
	BackupError,
	resticOk,
	type RestoreResult,
	type PostRestoreOutcome,
	type ResticRun,
} from './models';
import { buildInPlaceRestore, buildNewLocationRestore, buildCloneRestore } from './restore-script';
import { assertSafeVolumeInclude, assertSafeRestoreTarget } from './security';
import { liveTargetKey } from './locks';
import { cleanErrorMsg } from './helpers';
import type { SnapshotLayout } from './snapshot-layout';
import type { OperationHandle } from './backup-service';
import { formatResticLines } from './backup-service';
import { EXIT_MARKER } from './restic-script';

/** What the restore service needs from the outside. All injected for testability. */
export interface RestorePorts {
	/** Verify instance + env ownership of the snapshot; throws if not allowed. */
	guardSnapshotAccess(destinationId: number, snapshotId: string): Promise<void>;
	/** List the volume names present in a snapshot (for existence checks). */
	listSnapshotVolumes(destinationId: number, snapshotId: string): Promise<string[]>;
	/** Resolve the target container(s) for an in-place restore. `type` selects a
	 * single container (name match) or a whole compose stack (project-label match);
	 * defaults to 'container'. */
	resolveTargets(targetName: string, envId: number | null | undefined, type?: 'container' | 'stack'):
		Promise<{ containers: Array<{ id: string; name: string; state: string }> }>;
	/** Stop the target container(s) before an in-place restore. Throws on failure
	 * so the restore aborts before touching live volumes. Returns a restart fn. */
	stopBeforeRestore(containers: Array<{ id: string; name: string; state: string }>, envId: number | null | undefined):
		Promise<{ restart: () => Promise<void> }>;
	/** Stop a whole stack (native `docker compose stop`) before an in-place restore.
	 * Throws on failure so the restore aborts before touching live volumes. Returns
	 * a restart fn (native `docker compose start`) for the error path. */
	stopStackBeforeRestore(stackName: string, envId: number | null | undefined):
		Promise<{ restart: () => Promise<void> }>;
	/** Run the restore session container. */
	runInHelper(spec: { script?: string; args?: string[]; binds: string[]; envId: number | null | undefined; name: string; onStderr?: (line: string) => void }):
		Promise<ResticRun>;
	/** Resolve the live bind for a volume from ALREADY-READ metadata (name → `<src>:/volumes/<key>:rw`).
	 * Takes the metadata the caller already loaded so the swap resolves from one read - no second
	 * dump that could transiently fail and slug-bind a bind into an orphan volume. */
	resolveVolumeBind(metadata: SnapshotLayout | null, envId: number | null | undefined, volumeName: string):
		Promise<{ bind: string; include: string }>;
	/** Resolve clone destinations through the shared resolver (the SAME one the dialog preview
	 * uses), so the previewed path and the populated path are one computation. Returns per-volume
	 * bind material; the caller still does the side effects (volumeExists / createTargetVolume). */
	resolveCloneTargets(job: RestoreJob, volumes: string[]):
		Promise<Array<{ key: string; type: 'bind' | 'volume'; target: string; include: string; bind: string }>>;
	acquireLiveTarget(key: string): (() => void) | null;
	serializeDestination<T>(destinationId: number, fn: () => Promise<T>): Promise<T>;
	openOperation(entityName: string, environmentId: number | null, triggeredBy: 'manual' | 'cron', onProgress?: (s: string, m: string) => void):
		Promise<OperationHandle>;
	notify(event: 'restore_success' | 'restore_failed', payload: Record<string, unknown>, envId: number | null | undefined): Promise<void>;
	helperName(snapshotId: string): string;

	// --- post-restore actions (in-place only) ------------------------------------
	/** Does the target container still exist (running or stopped)? */
	containerExists(name: string, envId: number | null | undefined): Promise<boolean>;
	/** Does a compose stack with this name already exist on the target env (any of
	 * its containers present)? Used by the clone path to fail-closed on a name
	 * collision before redeploying over someone else's stack. */
	stackExists(name: string, envId: number | null | undefined): Promise<boolean>;
	/** Start an existing container; throws on failure. */
	startContainer(name: string, envId: number | null | undefined): Promise<void>;
	/** Recreate a container AS-IS from the snapshot's stored inspect config; throws
	 * with a clear message if that metadata is missing/insufficient. */
	recreateContainerFromMetadata(name: string, envId: number | null | undefined, snapshotMetaContainer: unknown): Promise<void>;
	/** Redeploy a stack from the snapshot's stored compose files; throws if absent.
	 *  restoreSecrets (opt-in, default on): write the stack's secrets carried in the
	 *  snapshot into the target env's DB before redeploy so the stack comes up complete. */
	redeployStack(name: string, envId: number | null | undefined, destinationId: number, snapshotId: string, restoreSecrets?: boolean): Promise<void>;
	/** Read the snapshot's stored restore metadata (typed SnapshotLayout), or null. */
	readSnapshotMetadata(destinationId: number, snapshotId: string): Promise<SnapshotLayout | null>;
	/** Write the snapshot's captured stack files (/volumes/__dockhand_stackdir__) into
	 * Dockhand's LOCAL data dir at stacks/<envName>/<stackName>/ so Dockhand can
	 * manage/redeploy the restored stack, even when the volume data restored to a
	 * remote env. No-op (returns false) if the snapshot has no stack files. */
	writeLocalStackFiles(destinationId: number, snapshotId: string, stackName: string, targetPath: string, overwrite: boolean, envId?: number | null): Promise<boolean>;
	/** Resolve the canonical LOCAL managed stack dir (stacks/<envName>/<stackName>/) for a
	 * target - where a clone's compose/.env is materialised so the restored stack is a normal
	 * managed (internal) stack the UI can edit + redeploy. */
	stackDirFor(stackName: string, envId: number | null | undefined): Promise<string>;

	// --- clone (cross-env restore) -----------------------------------------------
	/** Does a NAMED VOLUME with this name already exist on the target env? Used by
	 * the clone path to fail-closed on a collision (never overwrite an existing
	 * volume the user didn't create for this restore). */
	volumeExists(name: string, envId: number | null | undefined): Promise<boolean>;
	/** Create a fresh named volume on the target env (the caller has already checked
	 * it does not exist). Throws on failure. */
	createTargetVolume(name: string, envId: number | null | undefined): Promise<void>;
}

export interface RestoreJob {
	destinationId: number;
	snapshotId: string;
	mode: 'in-place' | 'new-location';
	/** Whether the in-place target is a single container or a compose stack.
	 * Selects which in-place path runs (stop+restart one container, vs `docker
	 * compose stop` + redeploy the whole stack). Defaults to 'container'. Ignored
	 * for new-location restores. */
	targetType?: 'container' | 'stack';
	/** Volume names to restore; empty = all in the snapshot. */
	volumes: string[];
	environmentId: number | null;
	confirmOverwrite?: boolean;
	targetPath?: string | null;
	/** Stack restores replace the managed compose/.env dir (clearing stale files)
	 * by default; set true to MERGE onto the existing dir instead. Independent of
	 * confirmOverwrite (which guards live VOLUME overwrites). */
	mergeStackFiles?: boolean;
	/** For in-place: the container/stack whose volumes are being restored. */
	targetName?: string | null;
	restoreFlags?: string[];
	/** What to do AFTER the restore. For in-place, defaults to `'start'`. For a
	 * new-location CLONE (see volumeDestinations), defaults to `'none'` and only
	 * `recreate`/`redeploy`/`none` are meaningful (`start` needs a live container).
	 *  - start:    start the target container if it still exists (in-place).
	 *  - recreate: rebuild the container from the snapshot's stored config if it's gone.
	 *  - redeploy: `docker compose up -d` from the snapshot's stored compose files.
	 *  - none:     do nothing (leave a stopped target stopped). */
	postRestore?: 'start' | 'recreate' | 'redeploy' | 'none';
	/** New-location only: per-volume destination on the TARGET env (environmentId).
	 * A volume WITH an entry is populated at that destination (named volume created
	 * on the target env, or an absolute host path bound as-is) so a subsequent
	 * recreate/redeploy mounts it with data — a cross-env CLONE. A volume WITHOUT an
	 * entry falls back to loose-files extraction under targetPath (today's default).
	 * Presence of ANY entry (or a recreate/redeploy postRestore) selects the clone
	 * path. */
	volumeDestinations?: Array<{ volume: string; kind: 'volume' | 'path'; target: string }>;
	/** Whether to restore the stack's secrets carried in the snapshot (default true).
	 * false = bring the stack up without secrets (the operator re-enters them). Only
	 * meaningful for a stack redeploy. */
	restoreSecrets?: boolean;
	/** New-location STACK restore only. When true, the snapshot's captured stack dir
	 * (/volumes/__dockhand_stackdir__: compose/.env/config) is NOT restored - only the
	 * volume data lands at targetPath. A data-only restore for when the operator already
	 * has the compose and just wants the data back. Default false (stack files included and
	 * materialised into Dockhand's managed stack dir). */
	skipStackFiles?: boolean;
}

export class RestoreService {
	constructor(private ports: RestorePorts) {}

	// volume key → kind, read once from the snapshot metadata at the top of run().
	// A fresh RestoreService is built per restore (index.ts), so this never races.
	private volumeTypes = new Map<string, 'volume' | 'bind'>();

	/** Emit the per-volume list `  • [BIND|VOL] <name>` — same format the backup log
	 *  uses, so LogConsole renders the same typed chips in both. No-op for an empty
	 *  set (a config-only snapshot). */
	private emitVolumeList(op: { progress: (s: string, m: string) => void }, volumes: string[]): void {
		for (const v of volumes) {
			const kind = this.volumeTypes.get(v) === 'bind' ? 'BIND' : 'VOL';
			op.progress('restoring', `  • [${kind}] ${v}`);
		}
	}

	async run(job: RestoreJob, triggeredBy: 'manual' | 'cron' = 'manual'): Promise<RestoreResult> {
		const envId = job.environmentId;
		// Two tiers, both stamped with wall-clock + {env,target,snapshot} so a line lines up
		// with the shard test log by time and target. log() is always on (started/failed);
		// diag() carries the internal mode/type micro-trace behind BACKUP_DIAG=1 (CI-only).
		const key = `${job.targetName ?? job.targetPath ?? '?'} snap=${job.snapshotId.slice(0, 8)} env=${envId}`;
		const t0 = Date.now();
		const log = (msg: string) => console.log(`[restore] ${new Date().toISOString()} ${key} | ${msg}`);
		const diagOn = process.env.BACKUP_DIAG === '1';
		const diag = (phase: string, extra?: string) => {
			if (!diagOn) return;
			console.log(`[restore] ${new Date().toISOString()} ${key} | ${phase} @${Date.now() - t0}ms${extra ? ' | ' + extra : ''}`);
		};
		log(`started (${job.mode}, ${job.targetType})`);
		diag('START', `post=${job.postRestore ?? 'none'}`);
		try {
			// --- ownership: caller must own the snapshot (instance + env) ---
			await this.ports.guardSnapshotAccess(job.destinationId, job.snapshotId);

			// The snapshot is authoritative about what it is: if it was taken of a
			// stack, restore it as a stack (and recover the stack name from metadata
			// if the caller didn't supply one) rather than trusting the client to
			// remember targetType — otherwise a stack restore silently degrades to a
			// container restore and its stack files never land.
			try {
				const meta = await this.ports.readSnapshotMetadata(job.destinationId, job.snapshotId);
				if (meta?.type === 'stack') {
					job.targetType = 'stack';
					if (!job.targetName && typeof meta.targetName === 'string') job.targetName = meta.targetName;
				}
				// Per-volume kind for the restore log's typed chips (keyed by the same
				// `key` that listSnapshotVolumes / the includes use).
				for (const v of meta?.volumes ?? []) {
					const k = v?.key ?? v?.name;
					if (k && (v.type === 'volume' || v.type === 'bind')) this.volumeTypes.set(k, v.type);
				}
			} catch { /* metadata best-effort; fall back to the caller-supplied targetType */ }

			// --- the requested volumes must EXIST in the snapshot ---
			// A metadata-only snapshot (config-only backup) has no volumes; that's valid.
			// An in-place restore of it just recreates/redeploys from the stored config;
			// a new-location restore extracts the stored config/compose files.
			const available = await this.ports.listSnapshotVolumes(job.destinationId, job.snapshotId);
			const requested = job.volumes.length > 0 ? job.volumes : available;
			const missing = requested.filter((v) => !available.includes(v));
			if (missing.length > 0) throw new BackupError('VALIDATION', `${missing.join(', ')} not found in snapshot. Available: ${available.join(', ') || 'none'}`);

			// Four paths on (mode, targetType). A stack carries its compose files in
			// the snapshot, so its paths also restore/redeploy that definition.
			if (job.mode === 'new-location') {
				// CLONE: new-location that populates real destinations on the target env
				// and (optionally) brings the target up there. Selected when the caller
				// supplied per-volume destinations OR a recreate/redeploy action.
				const isClone = (job.volumeDestinations?.length ?? 0) > 0
					|| job.postRestore === 'recreate' || job.postRestore === 'redeploy';
				if (isClone) {
					// Fail-closed on a TARGET-NAME collision when the clone would bring the
					// target up (recreate/redeploy). Never start someone else's existing
					// container or `compose up` over an existing stack — the user must
					// remove it or choose another name first. (Skip when postRestore is
					// 'none': no container/stack is created, so a name clash is harmless.)
					const willBringUp = job.postRestore === 'recreate' || job.postRestore === 'redeploy';
					const name = job.targetName ?? '';
					if (willBringUp && name) {
						if (job.targetType === 'stack') {
							if (await this.ports.stackExists(name, job.environmentId)) {
								throw new BackupError('VALIDATION',
									`a stack "${name}" already exists on the target environment; remove it or choose another name before cloning`);
							}
						} else if (await this.ports.containerExists(name, job.environmentId)) {
							throw new BackupError('VALIDATION',
								`a container "${name}" already exists on the target environment; remove it or choose another name before cloning`);
						}
					}
					return job.targetType === 'stack'
						? await this.runCloneStack(job, triggeredBy, requested)
						: await this.runCloneContainer(job, triggeredBy, requested);
				}
				return job.targetType === 'stack'
					? await this.runNewLocationStack(job, triggeredBy, requested)
					: await this.runNewLocationContainer(job, triggeredBy, requested);
			}
			return job.targetType === 'stack'
				? await this.runInPlaceStack(job, triggeredBy, requested)
				: await this.runInPlaceContainer(job, triggeredBy, requested);
		} catch (err) {
			const { code, message } = errorInfo(err);
			log(`failed after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${code} ${message}`);
			return { status: 'error', code, error: message };
		}
	}

	/** Non-destructive CONTAINER restore into a fresh directory. No locks on live
	 * data — restores just the volume data to targetPath. */
	private runNewLocationContainer(job: RestoreJob, triggeredBy: 'manual' | 'cron', volumes: string[]): Promise<RestoreResult> {
		// Metadata-only snapshot: extract the stored config (/metadata) so the operator
		// gets the container definition at the target path. Otherwise extract the volumes.
		const includes = volumes.length > 0 ? volumes.map((v) => `/volumes/${v}`) : ['/metadata'];
		return this.runNewLocationTo(job, triggeredBy, volumes, includes);
	}

	/** Non-destructive STACK restore into a fresh directory. Restores the volume data and,
	 * unless skipStackFiles is set, the snapshot's stored compose/.env (under
	 * /volumes/__dockhand_stackdir__). Dockhand ALWAYS materialises the stack files into its own
	 * managed stack dir and registers the stack, so it can manage/redeploy it - this is
	 * load-bearing: for a REMOTE env the compose exists only on the remote host otherwise, so
	 * Dockhand would have nothing to manage. `skipStackFiles` opts out entirely (data-only). */
	private async runNewLocationStack(job: RestoreJob, triggeredBy: 'manual' | 'cron', volumes: string[]): Promise<RestoreResult> {
		const includes = volumes.map((v) => `/volumes/${v}`);
		const includeStackFiles = job.targetName && !job.skipStackFiles;
		if (includeStackFiles) {
			// The captured stack dir is always at /volumes/__dockhand_stackdir__
			// (listSnapshotVolumes filters it out of `volumes`, so add it explicitly here so
			// the new-location restore also lands the compose/.env for a redeployable dir).
			const { STACKDIR_VOLUME_KEY } = await import('./stackdir-plan');
			includes.push(`/volumes/${STACKDIR_VOLUME_KEY}`);
		}
		const result = await this.runNewLocationTo(job, triggeredBy, volumes, includes);
		// Materialise the stack files into the CANONICAL managed stack dir on Dockhand
		// (stackDirFor -> $DATA_DIR/stacks/<env>/<name>, NOT job.targetPath which is the host path
		// where the volume DATA landed), and register the stack as managed. Always (unless
		// skipStackFiles): Dockhand needs the compose locally to edit/redeploy, especially for a
		// remote env. Best-effort - the volume restore already succeeded.
		if (result.status !== 'error' && includeStackFiles && job.targetName) {
			try {
				const overwrite = job.mergeStackFiles !== true;
				const stackTargetPath = await this.ports.stackDirFor(job.targetName, job.environmentId);
				await this.ports.writeLocalStackFiles(job.destinationId, job.snapshotId, job.targetName, stackTargetPath, overwrite, job.environmentId);
			} catch (e) {
				console.log(`[restore] ${new Date().toISOString()} materialise stack files threw for "${job.targetName}": ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		return result;
	}

	/** Shared non-destructive restore: extract the given includes to targetPath. */
	private async runNewLocationTo(job: RestoreJob, triggeredBy: 'manual' | 'cron', volumes: string[], includes: string[]): Promise<RestoreResult> {
		const op = await this.ports.openOperation(`Restore ${job.snapshotId.slice(0, 8)} → ${job.targetPath}`, job.environmentId, triggeredBy);
		try {
			// Defense-in-depth: the helper bind-mounts targetPath rw as root. Refuse a protected
			// system dir here even if the request bypassed API validation. (validate.ts blocks it
			// at the edge; this guarantees the contract at the last point before the mount.)
			assertSafeRestoreTarget(job.targetPath!);
			includes.forEach(assertSafeVolumeInclude);
			const args = buildNewLocationRestore(job.snapshotId, job.targetPath!, includes, job.restoreFlags ?? []);
			op.progress('restoring', `Restoring ${volumes.length} volume(s) to ${job.targetPath}...`);
			this.emitVolumeList(op, volumes);
			// Bind the target path OUT to the host at the same path, so restic's
			// `--target ${targetPath}` writes to a durable host location instead of
			// into the ephemeral helper container (where the extracted data would
			// vanish when the helper exits — a silent no-op restore).
			const run = await this.ports.runInHelper({ args, binds: [`${job.targetPath}:${job.targetPath}`], envId: job.environmentId, name: this.ports.helperName(job.snapshotId),
				onStderr: (line) => { for (const l of formatResticLines(line)) op.progress('progress', l.startsWith('[dockhand]') ? l : `[restic] ${l}`); } });
				this.emitResticStdout(op, run.stdout);
			if (!resticOk(run)) throw new BackupError('RESTIC', run.stderr.trim() || 'restore failed', { exitCode: run.exitCode });
			await op.close({ kind: 'ok' }, { snapshotId: job.snapshotId, volumes, targetPath: job.targetPath });
			await this.notifyOk(job, volumes);
			return { status: 'success', executionId: op.id, restoredVolumes: volumes, targetPath: job.targetPath! };
		} catch (err) {
			return await this.failOp(op, job, err);
		}
	}

	/** CLONE a CONTAINER to the target env: populate the mapped destinations, then
	 * recreate the container there from the snapshot's stored config (default). */
	private runCloneContainer(job: RestoreJob, triggeredBy: 'manual' | 'cron', volumes: string[]): Promise<RestoreResult> {
		return this.runClonePopulate(job, triggeredBy, volumes,
			(op) => this.applyPostRestore(job.postRestore ?? 'recreate', job, op));
	}

	/** CLONE a STACK to the target env: populate the mapped destinations, then either
	 * redeploy from the snapshot's stored compose files, or (postRestore 'none') just
	 * materialise the compose/.env dir locally so the user has a stack to edit + redeploy
	 * by hand. Redeploy materialises the dir itself (redeployStack); 'none' would otherwise
	 * leave NO compose dir at all - the UI says "update the compose file... then redeploy",
	 * so the dir must exist. */
	private runCloneStack(job: RestoreJob, triggeredBy: 'manual' | 'cron', volumes: string[]): Promise<RestoreResult> {
		return this.runClonePopulate(job, triggeredBy, volumes, async (op) => {
			if (job.postRestore === 'none') {
				// Bring nothing up, but materialise the managed stack dir so it's editable +
				// redeployable. Best-effort (matches runNewLocationStack): the volume clone
				// already succeeded, so a stackfile write failure must not fail the restore.
				if (job.targetName) {
					try {
						const overwrite = job.mergeStackFiles !== true;
						const stackTargetPath = await this.ports.stackDirFor(job.targetName, job.environmentId);
						await this.ports.writeLocalStackFiles(job.destinationId, job.snapshotId, job.targetName, stackTargetPath, overwrite, job.environmentId);
					} catch (e) {
						console.log(`[restore] ${new Date().toISOString()} clone 'none' writeLocalStackFiles threw for "${job.targetName}": ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				return this.applyPostRestore('none', job, op);
			}
			return this.applyPostRestore('redeploy', job, op);
		});
	}

	/**
	 * Shared CLONE machinery: restore each mapped volume into a caller-supplied
	 * destination on the TARGET env (a fresh named volume it creates, or an absolute
	 * host path bound as-is), then run a post-restore action to bring the target up.
	 *
	 * Unlike in-place there is nothing live to stop, no staging→swap (the
	 * destination is fresh), no live-target lock, and no swap/stop intents. Fresh
	 * volumes are populated directly. Named-volume destinations are FAIL-CLOSED: if
	 * one already exists on the target env we abort before touching anything (never
	 * overwrite a volume the user didn't create for this restore). Absolute-path
	 * destinations are bound as-is — the target daemon resolves them on its own host
	 * (the user is responsible for the path existing there).
	 *
	 * Volumes WITHOUT a destination fall back to loose-files extraction under
	 * targetPath, exactly like a plain new-location restore.
	 */
	private async runClonePopulate(
		job: RestoreJob,
		triggeredBy: 'manual' | 'cron',
		volumes: string[],
		postAction: (op: OperationHandle) => Promise<PostRestoreOutcome>,
	): Promise<RestoreResult> {
		const env = job.environmentId;
		const destMap = new Map((job.volumeDestinations ?? []).map((d) => [d.volume, d]));
		const mapped = volumes.filter((v) => destMap.has(v));
		const loose = volumes.filter((v) => !destMap.has(v));

		return this.ports.serializeDestination(job.destinationId, async () => {
			const op = await this.ports.openOperation(
				`Clone ${job.snapshotId.slice(0, 8)} → ${job.targetName ?? 'target'}`, env, triggeredBy);
			try {
				// --- populate the mapped destinations (fail-closed on volume collision) ---
				if (mapped.length > 0) {
					const binds: string[] = [];
					const mountRoots: string[] = [];
					// The target PATHS + bind strings come from the shared resolver (same as the dialog
					// preview), so preview and restore can't diverge. The loop only does the SIDE
					// EFFECTS (collision check / volume creation), not bind construction.
					const resolved = await this.ports.resolveCloneTargets(job, mapped);
					const byKey = new Map(resolved.map((r) => [r.key, r]));
					for (const v of mapped) {
						const r = byKey.get(v)!;
						assertSafeVolumeInclude(r.include);
						// Last line of defense (independent of validate.ts): a host-path clone target
						// is bind-mounted rw as root, so refuse a protected system dir even if a
						// crafted request reached the service directly.
						if (r.type === 'bind') assertSafeRestoreTarget(r.target);
						if (r.type === 'volume') {
							if (await this.ports.volumeExists(r.target, env)) {
								throw new BackupError('VALIDATION',
									`volume "${r.target}" already exists on the target environment; remove it or choose another destination before cloning`);
							}
							await this.ports.createTargetVolume(r.target, env);
						}
						// named volume (now created) or absolute host path — bind rw into the helper.
						binds.push(r.bind);
						mountRoots.push(r.include);
					}
					const script = buildCloneRestore(job.snapshotId, mountRoots, job.restoreFlags ?? []);
					op.progress('restoring', `Populating ${mapped.length} volume(s) on the target environment...`);
						this.emitVolumeList(op, mapped);
					const run = await this.ports.runInHelper({ script, binds, envId: env, name: this.ports.helperName(job.snapshotId),
						onStderr: (line) => { for (const l of formatResticLines(line)) op.progress('progress', l.startsWith('[dockhand]') ? l : `[restic] ${l}`); } });
						this.emitResticStdout(op, run.stdout);
					if (!resticOk(run)) throw new BackupError('RESTIC', run.stderr.trim() || 'clone restore failed', { exitCode: run.exitCode });
				}

				// --- loose-files fallback for any un-mapped volumes (extract to targetPath) ---
				// FAIL-CLOSED: un-mapped volumes need a targetPath to land in. Without one they
				// would be silently dropped while the restore still reports success and the
				// redeploy brings the target up with EMPTY volumes (data loss). Refuse instead.
				if (loose.length > 0 && !job.targetPath) {
					throw new BackupError('VALIDATION',
						`Clone restore has ${loose.length} volume(s) with no destination mapping and no targetPath ` +
						`to extract them to (${loose.join(', ')}). Map every volume or provide a targetPath.`);
				}
				if (loose.length > 0 && job.targetPath) {
					const includes = loose.map((v) => `/volumes/${v}`);
					includes.forEach(assertSafeVolumeInclude);
					const args = buildNewLocationRestore(job.snapshotId, job.targetPath, includes, job.restoreFlags ?? []);
					op.progress('restoring', `Extracting ${loose.length} volume(s) to ${job.targetPath}...`);
						this.emitVolumeList(op, loose);
					const run = await this.ports.runInHelper({ args, binds: [`${job.targetPath}:${job.targetPath}`], envId: env, name: this.ports.helperName(job.snapshotId),
						onStderr: (line) => { for (const l of formatResticLines(line)) op.progress('progress', l.startsWith('[dockhand]') ? l : `[restic] ${l}`); } });
						this.emitResticStdout(op, run.stdout);
					if (!resticOk(run)) throw new BackupError('RESTIC', run.stderr.trim() || 'clone restore failed', { exitCode: run.exitCode });
				}

				// --- bring the target up on the chosen env ---
				const outcome = await postAction(op);
				if (outcome.ok) {
					await op.close({ kind: 'ok' }, { snapshotId: job.snapshotId, volumes, postRestore: outcome });
					await this.notifyOk(job, volumes);
					return { status: 'success', executionId: op.id, restoredVolumes: volumes, postRestore: outcome };
				}
				// For a CLONE the whole point is to bring the target up on the new env,
				// so a post-restore failure is a hard ERROR (not a quiet warning). Surface
				// the RAW Docker / compose error verbatim so the user sees exactly what
				// the daemon said (e.g. a source network/image missing on the target) and
				// fixes it themselves — we don't parse or interpret it. The volume data is
				// already restored; only the container/stack wasn't brought up.
				const rawErr = outcome.error ?? `${outcome.action} failed`;
				op.progress('error', rawErr);
				await op.close({ kind: 'error', code: 'DOCKER', message: rawErr }, { snapshotId: job.snapshotId, volumes, postRestore: outcome });
				return { status: 'error', executionId: op.id, code: 'DOCKER', error: rawErr };
			} catch (err) {
				return await this.failOp(op, job, err);
			}
		});
	}

	/** Destructive in-place restore of a single CONTAINER: stop it, swap its
	 * volumes, then run the chosen post-restore action (default: start). */
	private runInPlaceContainer(job: RestoreJob, triggeredBy: 'manual' | 'cron', volumes: string[]): Promise<RestoreResult> {
		return this.runInPlaceSwap(job, triggeredBy, volumes, {
			// Stop the one container (a stop FAILURE aborts before any volume is touched).
			stop: async (op) => {
				if (!job.targetName) return { restart: null };
				const { containers } = await this.ports.resolveTargets(job.targetName, job.environmentId);
				const running = containers.filter((c) => c.state === 'running');
				if (running.length === 0) return { restart: null };
				op.progress('stopping', `Stopping ${job.targetName}...`);
				const { restart } = await this.ports.stopBeforeRestore(running, job.environmentId);
				return { restart };
			},
			// After the swap, run the caller's post-restore action (start/recreate/none).
			postAction: (op) => this.applyPostRestore(job.postRestore ?? 'start', job, op),
		});
	}

	/** Destructive in-place restore of a STACK: `docker compose stop` the whole
	 * stack, swap its volumes, then redeploy it from the snapshot's stored compose
	 * files (so both the data AND the stack definition are restored as-of backup). */
	private runInPlaceStack(job: RestoreJob, triggeredBy: 'manual' | 'cron', volumes: string[]): Promise<RestoreResult> {
		return this.runInPlaceSwap(job, triggeredBy, volumes, {
			// Stop the whole stack via native compose stop; a stop FAILURE aborts
			// before any volume is touched.
			stop: async (op) => {
				if (!job.targetName) return { restart: null };
				const { containers } = await this.ports.resolveTargets(job.targetName, job.environmentId, 'stack');
				const running = containers.filter((c) => c.state === 'running');
				if (running.length === 0) return { restart: null };
				op.progress('stopping', `Stopping stack ${job.targetName}...`);
				const { restart } = await this.ports.stopStackBeforeRestore(job.targetName, job.environmentId);
				return { restart };
			},
			// A stack is brought back by redeploying from its stored compose files.
			postAction: (op) => this.applyPostRestore('redeploy', job, op),
		});
	}

	/**
	 * The shared in-place restore machinery: resolve live binds, lock + serialize,
	 * record durable swap/stop intents, run the phase-marked staging→commit swap in
	 * a helper, then apply a post-restore action. `opts.stop` and `opts.postAction`
	 * are the only container-vs-stack differences. The swap itself is per-volume and
	 * target-agnostic. A failed/interrupted swap leaves live data intact (the
	 * durable swap intent lets startup roll it back).
	 */
	private async runInPlaceSwap(
		job: RestoreJob,
		triggeredBy: 'manual' | 'cron',
		volumes: string[],
		opts: {
			stop: (op: OperationHandle) => Promise<{ restart: (() => Promise<void>) | null }>;
			postAction: (op: OperationHandle) => Promise<PostRestoreOutcome>;
		},
	): Promise<RestoreResult> {
		if (job.confirmOverwrite !== true) {
			return { status: 'error', code: 'VALIDATION', error: 'an in-place restore overwrites live data and requires explicit confirmation' };
		}
		const env = job.environmentId;

		// DATA-SAFETY: a BIND volume's live bind is the SOURCE env's absolute host path
		// (resolveBindFromMetadata returns entry.source, e.g. /srv/appA/data). An in-place
		// swap writes to that exact path on `env`'s daemon. If `env` is NOT the snapshot's
		// source env, we'd destructively swap into an unrelated /srv/appA/data on the WRONG
		// host. Named volumes are safe (they resolve to a name on the local daemon), so only
		// bind volumes are gated. Cross-env restores must go through the clone path.
		// Detect binds from the metadata directly (fail-closed: if metadata is unreadable we
		// can't prove the swap is safe, so we refuse rather than trust an empty volumeTypes).
		// Read the metadata ONCE here and reuse it to resolve the binds below. A second per-volume
		// read opens a TOCTOU window: a transient dump failure returns null and slug-binds a bind
		// into an orphan named volume (data loss).
		const meta = await this.ports.readSnapshotMetadata(job.destinationId, job.snapshotId).catch(() => null);
		{
			const requested = new Set(volumes);
			const bindVols = (meta?.volumes ?? [])
				.filter((v) => v.type === 'bind' && requested.has(v.key ?? v.name))
				.map((v) => v.key ?? v.name);
			// If we requested volumes but couldn't read metadata to classify them, we cannot
			// prove none are binds -> fail-closed.
			const metaUnreadable = volumes.length > 0 && meta === null;
			if (bindVols.length > 0 || metaUnreadable) {
				const sourceEnv = meta?.environmentId;
				const targetIsSource = meta !== null && (sourceEnv ?? null) === (env ?? null);
				if (!targetIsSource) {
					const which = bindVols.length > 0 ? ` (${bindVols.join(', ')})` : '';
					return {
						status: 'error',
						code: 'VALIDATION',
						error: `in-place restore of a bind-mounted volume${which} is only allowed on the snapshot's source environment; use "restore to new location" to move it across environments`,
					};
				}
			}
		}
		// Past the gate, `meta` is proven non-null whenever we requested volumes (metaUnreadable
		// would have returned above), so the resolver never sees null for a real bind -> no
		// slug-bind. Resolve every volume from this ONE metadata read.

		// Resolve each volume's live bind + include (rw — the swap writes to it).
		const binds: string[] = [];
		const liveRoots: string[] = [];
		for (const v of volumes) {
			const { bind, include } = await this.ports.resolveVolumeBind(meta, env, v);
			assertSafeVolumeInclude(include);
			binds.push(bind);
			liveRoots.push(include);
		}

		// Lock the live targets (reject a concurrent op on this data). The fallback identity
		// matches backup-service's `${type}:${targetName}` so a backup and a restore of the
		// SAME config-only target still collide, while disjoint config-only targets don't.
		const key = liveTargetKey(env, binds, `${job.targetType ?? 'container'}:${job.targetName}`);
		const release = this.ports.acquireLiveTarget(key);
		if (!release) return { status: 'skipped', reason: `Another backup or restore is already running for "${job.targetName ?? key}".` };

		try {
			return await this.ports.serializeDestination(job.destinationId, async () => {
				const op = await this.ports.openOperation(`Restore ${job.snapshotId.slice(0, 8)} → ${job.targetName ?? 'volumes'}`, env, triggeredBy);
				let restart: (() => Promise<void>) | null = null;
				try {
					// Stop the target first; a stop FAILURE aborts before any volume is touched.
					({ restart } = await opts.stop(op));

					// Metadata-only snapshot (no volumes): there's nothing to swap — go
					// straight to the post-restore action (recreate/redeploy from the
					// stored config). Otherwise run the phase-marked volume swap. The swap
					// is atomic per volume (staging + rename) and self-recovers on the next
					// restore via the on-disk phase marker, so a crash mid-swap leaves the
					// live data either fully-old or fully-new, never half-swapped.
					if (liveRoots.length > 0) {
						const script = buildInPlaceRestore(job.snapshotId, liveRoots, job.restoreFlags ?? []);
						op.progress('restoring', `Restoring ${volumes.length} volume(s) in place...`);
						this.emitVolumeList(op, volumes);
						const run = await this.ports.runInHelper({ script, binds, envId: env, name: this.ports.helperName(job.snapshotId),
							onStderr: (line) => { for (const l of formatResticLines(line)) op.progress('progress', l.startsWith('[dockhand]') ? l : `[restic] ${l}`); } });
							this.emitResticStdout(op, run.stdout);
						if (!resticOk(run)) throw new BackupError('RESTIC', run.stderr.trim() || 'restore failed', { exitCode: run.exitCode });
					} else {
						op.progress('restoring', `Config-only snapshot — no volume data to restore for ${job.targetName ?? 'target'}.`);
					}

					// The volume data is now safely restored. Run the post-restore action —
					// best-effort, NEVER rolls the restore back. On failure we downgrade to a
					// warning (data is good, operator must act).
					const outcome = await opts.postAction(op);

					if (outcome.ok) {
						await op.close({ kind: 'ok' }, { snapshotId: job.snapshotId, volumes, postRestore: outcome });
						await this.notifyOk(job, volumes);
						return { status: 'success', executionId: op.id, restoredVolumes: volumes, postRestore: outcome };
					}
					const warnMsg = `Data restored, but the post-restore step (${outcome.action}) failed: ${outcome.error ?? 'unknown error'}`;
					op.progress('warning', warnMsg);
					await op.close({ kind: 'warning', message: warnMsg }, { snapshotId: job.snapshotId, volumes, postRestore: outcome });
					await this.notifyOk(job, volumes);
					return { status: 'warning', executionId: op.id, restoredVolumes: volumes, postRestore: outcome };
				} catch (err) {
					// Restart whatever we stopped for the restore. If the restart itself
					// fails, SURFACE it: there is no boot-time recovery, so the operator
					// must know the target is still stopped and start it themselves.
					if (restart) {
						try {
							await restart();
						} catch {
							const msg = `Restore failed and ${job.targetName ?? 'the target'} could not be restarted — it is STILL STOPPED. Start it manually.`;
							op.progress('warning', msg);
							try { await this.ports.notify('restore_failed', { snapshotId: job.snapshotId, kind: 'restore', errorCode: 'STOPPED_RESTART_FAILED', message: msg }, job.environmentId); } catch { /* non-fatal */ }
						}
					}
					return await this.failOp(op, job, err);
				}
			});
		} finally {
			release();
		}
	}

	/**
	 * Apply the chosen post-restore action after a successful in-place swap.
	 * Best-effort: a throw becomes `{ ok:false, error }` — it NEVER propagates as
	 * a failed restore (the data is already good). The pre-swap stop already ran;
	 * this decides what happens to the target AFTER.
	 */
	private async applyPostRestore(
		action: 'start' | 'recreate' | 'redeploy' | 'none',
		job: RestoreJob,
		op: OperationHandle,
	): Promise<PostRestoreOutcome> {
		const envId = job.environmentId;
		const name = job.targetName ?? '';
		try {
			switch (action) {
				case 'none':
					return { action, ok: true };

				case 'start': {
					if (await this.ports.containerExists(name, envId)) {
						op.progress('starting', `Starting ${name}...`);
						await this.ports.startContainer(name, envId);
						return { action, ok: true };
					}
					return { action, ok: false, error: 'target container no longer exists — choose Recreate to rebuild it' };
				}

				case 'recreate': {
					// Recreate is a superset of start: if the container is still there,
					// prefer starting it (never destroy a live container); only rebuild
					// from the stored config when it's actually gone.
					if (await this.ports.containerExists(name, envId)) {
						op.progress('starting', `Starting ${name}...`);
						await this.ports.startContainer(name, envId);
						return { action, ok: true };
					}
					const meta = await this.ports.readSnapshotMetadata(job.destinationId, job.snapshotId);
					if (!meta || meta.container == null) {
						return { action, ok: false, error: 'no container metadata stored in this snapshot; cannot recreate' };
					}
					op.progress('recreating', `Recreating ${name} from the snapshot's stored config...`);
					await this.ports.recreateContainerFromMetadata(name, envId, meta.container);
					return { action, ok: true };
				}

				case 'redeploy': {
					const meta = await this.ports.readSnapshotMetadata(job.destinationId, job.snapshotId);
					if (!meta || meta.stack === undefined) {
						return { action, ok: false, error: 'no stack files stored in this snapshot; cannot redeploy' };
					}
					op.progress('redeploying', `Redeploying stack ${name}...`);
					await this.ports.redeployStack(name, envId, job.destinationId, job.snapshotId, job.restoreSecrets ?? true);
					return { action, ok: true };
				}
			}
		} catch (err) {
			return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** restic writes its `--json` progress (per-file status + summary) to STDOUT,
	 * which the helper returns buffered (not streamed). Emit those lines so the
	 * restore log shows restic's actual output, not just our [dockhand] echos.
	 * Drops the internal exit-marker line. */
	private emitResticStdout(op: OperationHandle, stdout: string): void {
		for (const l of formatResticLines(stdout)) {
			if (l.includes(EXIT_MARKER)) continue;
			op.progress('progress', l.startsWith('[dockhand]') ? l : `[restic] ${l}`);
		}
	}

	private async notifyOk(job: RestoreJob, volumes: string[]): Promise<void> {
		try { await this.ports.notify('restore_success', { snapshotId: job.snapshotId, kind: 'restore', volumes }, job.environmentId); } catch { /* non-fatal */ }
	}

	private async failOp(op: OperationHandle, job: RestoreJob, err: unknown): Promise<RestoreResult> {
		const { code, message } = errorInfo(err);
		await op.close({ kind: 'error', code, message }, { errorCode: code });
		try { await this.ports.notify('restore_failed', { snapshotId: job.snapshotId, kind: 'restore', errorCode: code, message }, job.environmentId); } catch { /* non-fatal */ }
		return { status: 'error', executionId: op.id, code, error: message };
	}
}

function errorInfo(err: unknown): { code: BackupError['code']; message: string } {
	// See backup-service.errorInfo — unwrap embedded daemon JSON so the UI shows a
	// readable message consistently across every failure path.
	const raw = err instanceof BackupError ? err.message : (err instanceof Error ? err.message : String(err));
	const code = err instanceof BackupError ? err.code : 'UNKNOWN';
	return { code, message: cleanErrorMsg(raw) };
}
