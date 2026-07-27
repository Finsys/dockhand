/**
 * backups/index.ts — the composition root. Wires the pure BackupService /
 * RestoreService to the real world (db, docker, restic, stacks, notifications)
 * by implementing their injected port interfaces, and exposes the single startup
 * reconciler. This is the only place in the domain that touches everything, so
 * the seams stay visible.
 *
 * Public surface:
 *   runBackup(configId, trigger)         → run a backup for a config
 *   runRestore(request)                  → run a restore
 *   reconcileOnStartup()                 → recover interrupted operations
 *   the read/repo helpers re-exported for the API routes
 */
import { Restic } from './restic';
import { BackupService, type BackupPorts, type BackupJob, type OperationHandle, type StopIntent } from './backup-service';
import { planStopRecovery, isTargetGoneError, type RestartAction } from './stop-recovery-core';
import { RestoreService, type RestorePorts, type RestoreJob } from './restore-service';
import { openOperation, scrubInterruptedOperations } from './operations';
import { LiveTargetLocks, DestinationSerializer } from './locks';
import { resolveTargets, discoverVolumes, stopForBackup } from './docker';
import { guardSnapshotAccess, listSnapshots as listSnapshotsCore, resolveSnapshotEnvId as resolveSnapshotEnvIdCore, filterSnapshotsByAccessibleEnv } from './snapshots';
import { initRepository as initRepoCore, testRepository as testRepoCore, checkRepository, pruneRepository, unlockRepository, repoStats, rotateDestinationPassword as rotateCore } from './repo';
import { parseRetention, buildForgetArgs, checkWouldWipe } from './retention';
import { instanceTagFilter, parseSnapshots, retentionTagFilter } from './models';
import { buildSwapRecoveryScript } from './swap';
import { parseOptionsJson, fireWebhook, parseResticDiff, type SnapshotDiff } from './helpers';
import { getHostname } from '../license';
import { getBackupConfig, getBackupConfigs, getBackupDestination, updateBackupConfig, updateBackupDestination, decryptBackupDestination, getEnvironment } from '../db';
import { getInstanceId } from './identity';
import { inspectContainer } from '../docker';
import { sendEventNotification } from '../notifications';
import { recordOperation, clearOperation, listOperations } from './journal';
import type { BackupResult, RestoreResult, ResticRun, BackupTargetType } from './models';
import type { MetadataFile } from './backup-script';
import type { DiscoveredVolume } from './discovery-core';
import { resolveBindFromMetadata } from './restore-core';
import { parseSnapshotLsEntries } from './browse-core';

// --- shared singletons (in-memory locks live for the process lifetime) -------
const restic = new Restic();
const liveLocks = new LiveTargetLocks();
const destSerializer = new DestinationSerializer();
/** Config ids with a backup currently in flight — so a config edit/delete can
 * be blocked mid-run. Maintained by runBackup. */
const runningBackupConfigs = new Set<number>();

// =============================================================================
// Operation-handle adapter — bridges the service's OperationHandle to our record
// =============================================================================
async function makeOperationHandle(
	kind: 'backup' | 'restore',
	entityName: string,
	scheduleId: number,
	environmentId: number | null,
	triggeredBy: 'cron' | 'manual' | 'webhook',
	onProgress?: (s: string, m: string) => void,
): Promise<OperationHandle> {
	const op = await openOperation({ kind, scheduleId, environmentId, entityName, triggeredBy }, onProgress);
	return {
		id: op.id,
		progress: (status, message) => op.progress(status, message),
		log: (message) => op.log(message),
		close: (outcome, details) => op.close(outcome, details),
		skip: async (reason) => op.close({ kind: 'error', code: 'CONCURRENCY', message: reason }, { skipped: true, reason }),
	};
}

// =============================================================================
// Metadata collector — reads restore context into base64 files for the snapshot
// =============================================================================
async function collectMetadata(
	type: BackupTargetType,
	targetName: string,
	envId: number | null | undefined,
	volumes: DiscoveredVolume[],
): Promise<{ files: MetadataFile[]; stackFilesTruncated: boolean }> {
	const files: MetadataFile[] = [];
	// True when a stack directory exceeded the capture cap → the snapshot is an
	// incomplete stack-file capture. The caller downgrades the result to a warning.
	let stackFilesTruncated = false;
	const metadata: Record<string, unknown> = {
		type, targetName, environmentId: envId ?? null,
		backupTime: new Date().toISOString(),
		// Store the full identity restore needs to bind each volume back to its
		// ORIGINAL location: for a bind, `source` is the absolute host path (NOT
		// the slugged key). Without this an in-place bind restore can't recover
		// the host path and would write to an orphan named volume.
		volumes: volumes.map((v) => ({ key: v.key, name: v.name, source: v.source, type: v.type })),
	};

	// Capture each target container's config for reference (recreate-as-is).
	if (type === 'container') {
		try {
			const [c] = (await resolveTargets(type, targetName, envId)).containers;
			if (c) metadata.container = await inspectContainer(c.id, envId ?? undefined);
		} catch { /* metadata best-effort; the volume data is what matters */ }
	}

	files.push({ path: 'metadata.json', contentBase64: Buffer.from(JSON.stringify(metadata, null, 2)).toString('base64') });

	// For a stack, capture its files so it can be redeployed as-is. compose.yaml
	// and .env live at stacks/<name>/ (restore/redeploy read them from there); the
	// ENTIRE stack directory is also captured under stacks/<name>/stackfiles/ so
	// sibling config a stack depends on (nginx.conf, html/, certs, …) survives —
	// not just the compose file.
	if (type === 'stack') {
		const { getStackComposeFile } = await import('../stacks');
		const { readFileSync, readdirSync, lstatSync } = await import('fs');
		const { dirname, join, relative, basename } = await import('path');
		const compose = await getStackComposeFile(targetName, envId ?? undefined);
		if (compose.success && compose.composePath) {
			metadata.hasStackFiles = true;
			// Record the ORIGINAL compose filename (e.g. immich.yaml / docker-compose.yml)
			// so restore redeploys from the real file inside stackfiles/ — reproducing the
			// stack dir 1:1. The whole dir (compose + include:d files + sidecars + .env) is
			// captured under stackfiles/ below; we do NOT also store a normalized
			// compose.yaml/.env copy — that was a duplicate the redeploy never reads.
			metadata.composeFileName = basename(compose.composePath);
			// Copy the whole stack source directory under stackfiles/. A bounded
			// recursive walk (skips symlinks; total capped) so a huge or looping
			// tree can't blow up the metadata payload. The payload is base64'd and
			// held in heap (~2.4x the bytes) before being tar'd into the helper, so
			// the cap is a memory guard, not an arbitrary limit. When it IS hit the
			// backup is INCOMPLETE — record that in metadata.json and surface a
			// warning so a truncated stack dir never silently looks fully captured.
			try {
				const stackDir = dirname(compose.composePath);
				const MAX_FILES = 5000;
				const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
				// Cap the file LISTING recorded in metadata.json (relPath + size) so the
				// Metadata tab can show the captured files without a browse roundtrip.
				// Independent of the capture cap: a stack can be fully captured yet have
				// more entries than we want to inline in metadata.
				const MAX_LIST = 500;
				const fileList: Array<{ path: string; bytes: number }> = [];
				let listTruncated = false;
				let count = 0;
				let bytes = 0;
				let truncated = false;
				const walk = (dir: string): void => {
					for (const entry of readdirSync(dir)) {
						if (count >= MAX_FILES || bytes >= MAX_TOTAL_BYTES) { truncated = true; return; }
						const abs = join(dir, entry);
						let st;
						try { st = lstatSync(abs); } catch { continue; }
						if (st.isSymbolicLink()) continue;
						if (st.isDirectory()) { walk(abs); continue; }
						if (!st.isFile()) continue;
						try {
							const content = readFileSync(abs);
							const relPath = relative(stackDir, abs);
							files.push({ path: `stacks/${targetName}/stackfiles/${relPath}`, contentBase64: content.toString('base64') });
							count++;
							bytes += content.length;
							if (fileList.length < MAX_LIST) fileList.push({ path: relPath, bytes: content.length });
							else listTruncated = true;
						} catch { /* skip an unreadable file; the rest still back up */ }
					}
				};
				walk(stackDir);
				// Record the captured file listing (sorted for a stable UI order) so the
				// Metadata tab can enumerate exactly what's in the snapshot's stack dir.
				if (fileList.length > 0) {
					fileList.sort((a, b) => a.path.localeCompare(b.path));
					metadata.stackFilesList = fileList;
					if (listTruncated) metadata.stackFilesListTruncated = true;
				}
				if (truncated) {
					stackFilesTruncated = true;
					// Record it durably IN the snapshot (metadata.json) so a truncated
					// capture is visible on browse/restore, and log it loudly. An
					// over-cap stack dir therefore never silently looks fully captured.
					metadata.stackFilesTruncated = true;
					metadata.stackFilesCaptured = { files: count, bytes, maxFiles: MAX_FILES, maxBytes: MAX_TOTAL_BYTES };
					console.warn(`[Backup] Stack directory for "${targetName}" exceeded the backup cap (${MAX_FILES} files / ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB) — only ${count} file(s) / ${bytes} byte(s) captured. The snapshot is INCOMPLETE for redeploy; reduce the stack dir or exclude large sibling files.`);
				}
			} catch { /* directory walk best-effort — compose/.env already captured */ }
			// Rewrite metadata.json with hasStackFiles set.
			files[0] = { path: 'metadata.json', contentBase64: Buffer.from(JSON.stringify(metadata, null, 2)).toString('base64') };
		}
	}

	return { files, stackFilesTruncated };
}

// A restic helper runner bound to one destination (so no shared mutable state —
// each run closes over its own destination). Used by both port factories.
function boundRunner(destination: any) {
	return {
		runInHelper: (spec: { script?: string; args?: string[]; binds: string[]; envId: number | null | undefined; name: string; metadataFiles?: MetadataFile[]; onStderr?: (line: string) => void; onStdout?: (line: string) => void }): Promise<ResticRun> =>
			restic.runInHelper(destination, { script: spec.script, args: spec.args ?? [], binds: spec.binds, envId: spec.envId, name: spec.name, metadataFiles: spec.metadataFiles, onStderr: spec.onStderr, onStdout: spec.onStdout, timeout: 'data' }),
		runLocal: (args: string[], tier?: 'interactive' | 'data'): Promise<ResticRun> => restic.runLocal(destination, args, tier),
	};
}

// =============================================================================
// BackupPorts — the real implementation, bound to one destination per run
// =============================================================================
function backupPorts(destination: any, onProgress?: (status: string, message: string) => void): BackupPorts {
	const run = boundRunner(destination);
	return {
		resolveTargets: (type, targetName, envId) => resolveTargets(type, targetName, envId),
		discoverVolumes: (containers, envId, selected) => discoverVolumes(containers, envId, selected),
		stopForBackup: (type, targetName, containers, envId) => stopForBackup(type, targetName, containers, envId),
		recordStopIntent: async (key, intent) => { await recordStopIntent(key, intent); },
		clearStopIntent: (key) => clearOperation(key),
		runInHelper: (spec) => run.runInHelper(spec),
		runLocal: (args, tier) => run.runLocal(args, tier),
		collectMetadata,
		host: () => getHostname(),
		instanceId: () => getInstanceId(),
		acquireLiveTarget: (key) => liveLocks.tryAcquire(key),
		serializeDestination: (id, fn) => serializeByRepo(id, fn),
		// Forward the run's live-progress callback into the operation record so the
		// SSE route streams it (the record also throttles the durable log writes).
		openOperation: (entityName, scheduleId, environmentId, triggeredBy, cb) =>
			makeOperationHandle('backup', entityName, scheduleId, environmentId, triggeredBy, cb ?? onProgress),
		notify: (event, payload, envId) => notify(event, payload, envId),
		fireWebhook: (url, payload) => { void fireWebhook(url, payload, { log: (m) => onProgress?.('webhook', m) }); },
		setConfigStatus: async (configId, status) => { await updateBackupConfig(configId, { lastBackupStatus: status, lastBackupAt: new Date().toISOString() }); },
	};
}

// =============================================================================
// RestorePorts — the real implementation, bound to one destination + access ctx
// =============================================================================
function restorePorts(destination: any, access: { isEnterprise: boolean; canAccessEnvironment: (id: number) => Promise<boolean> }, onProgress?: (status: string, message: string) => void): RestorePorts {
	const run = boundRunner(destination);
	return {
		guardSnapshotAccess: async (_destinationId, snapshotId) => {
			const instanceId = await getInstanceId();
			await guardSnapshotAccess(reader(), destination, instanceId, snapshotId, access);
		},
		listSnapshotVolumes: async (_destinationId, snapshotId) => listSnapshotVolumes(destination, snapshotId),
		resolveTargets: async (targetName, envId, type) => resolveTargets(type ?? 'container', targetName, envId),
		stopBeforeRestore: async (containers, envId) => {
			const running = containers.filter((c) => c.state === 'running');
			const { stopContainer, startContainer } = await import('../docker');
			for (const c of running) await stopContainer(c.id, envId ?? undefined);
			return { restart: async () => { for (const c of running) await startContainer(c.id, envId ?? undefined).catch(() => {}); } };
		},
		stopStackBeforeRestore: async (stackName, envId) => {
			// Native compose stop; a stop failure throws so the restore aborts before
			// any volume is touched. The restart closure (error path only) brings the
			// stack back via native compose start.
			const { stopStack, startStack } = await import('../stacks');
			const r = await stopStack(stackName, envId ?? undefined);
			if (r && (r as any).success === false) throw new Error((r as any).error || `failed to stop stack ${stackName}`);
			return { restart: async () => { await startStack(stackName, envId ?? undefined).catch(() => {}); } };
		},
		runInHelper: (spec) => run.runInHelper(spec),
		resolveVolumeBind: async (destinationId, snapshotId, _envId, volumeName) => {
			// Read the snapshot metadata and resolve the volume's ORIGINAL live
			// location. For a bind this recovers the absolute host path; if it
			// can't, resolveBindFromMetadata throws rather than slug-binding into
			// an orphan named volume (silent data loss).
			const metadata = await getSnapshotMetadata(destinationId, snapshotId);
			return resolveBindFromMetadata(metadata, volumeName);
		},
		acquireLiveTarget: (key) => liveLocks.tryAcquire(key),
		serializeDestination: (id, fn) => serializeByRepo(id, fn),
		openOperation: (entityName, environmentId, triggeredBy, cb) =>
			makeOperationHandle('restore', entityName, 0, environmentId, triggeredBy === 'cron' ? 'cron' : 'manual', cb ?? onProgress),
		notify: (event, payload, envId) => notify(event, payload, envId),
		recordSwapIntent: async (key, data) => { await recordOperation({ id: key, kind: 'swap', instanceId: await getInstanceId(), envId: data.envId, startedAt: new Date().toISOString(), snapshotId: data.snapshotId, includes: data.includes, volumeBinds: data.binds }); },
		clearSwapIntent: (key) => clearOperation(key),
		recordStopIntent: async (key, intent) => { await recordStopIntent(key, intent); },
		clearStopIntent: (key) => clearOperation(key),
		helperName: (snapshotId) => `dockhand-restore-${snapshotId.slice(0, 12)}`,

		// --- post-restore actions -------------------------------------------------
		containerExists: async (name, envId) => {
			const { containers } = await resolveTargets('container', name, envId);
			return containers.length > 0;
		},
		stackExists: async (name, envId) => {
			// A stack "exists" on the env if any of its containers are present (running
			// or stopped) — resolveTargets('stack', …) matches by the compose project.
			const { containers } = await resolveTargets('stack', name, envId);
			return containers.length > 0;
		},
		startContainer: async (name, envId) => {
			const { containers } = await resolveTargets('container', name, envId);
			if (containers.length === 0) throw new Error(`container "${name}" not found`);
			const { startContainer } = await import('../docker');
			for (const c of containers) await startContainer(c.id, envId ?? undefined);
		},
		// Rebuild the container AS-IS from the stored Docker inspect result. The
		// backup stored `metadata.container = inspectContainer(...)`, so map its
		// Config/HostConfig/Mounts/NetworkSettings straight into the create helper.
		recreateContainerFromMetadata: async (name, envId, snapshotMetaContainer) => {
			const inspect = snapshotMetaContainer as any;
			const image = inspect?.Config?.Image;
			if (!inspect?.Config || !inspect?.HostConfig || typeof image !== 'string' || !image) {
				throw new Error('stored container metadata is missing Config/HostConfig/Image; cannot recreate');
			}
			const { createContainerFromMetadata } = await import('../docker');
			await createContainerFromMetadata(
				name,
				image,
				{
					config: inspect.Config,
					hostConfig: inspect.HostConfig,
					mounts: inspect.Mounts ?? [],
					networkSettings: inspect.NetworkSettings ?? { Networks: {} },
				},
				envId ?? undefined,
			);
		},
		// Redeploy from the files captured in the snapshot (restore-as-is), reproducing
		// the stack dir 1:1: extract the WHOLE stackfiles/ tree and run `docker compose
		// up -d` against the ORIGINAL compose filename — so include:, override files, and
		// sibling configs referenced by relative paths resolve, and the file keeps its
		// real name (e.g. immich.yaml). The backup always captures the full dir plus the
		// recorded compose filename, so there is no normalized-compose.yaml fallback.
		redeployStack: async (name, envId, destId, snapId) => {
			const { redeployStackFromDir } = await import('../stacks');
			const { mkdtempSync, rmSync, existsSync, readdirSync } = await import('fs');
			const { tmpdir } = await import('os');
			const { join } = await import('path');

			const meta = await getSnapshotMetadata(destId, snapId);
			const composeFileName = meta && typeof meta.composeFileName === 'string' ? meta.composeFileName : '';
			if (!composeFileName) {
				throw new Error('snapshot has no recorded compose filename; cannot redeploy this stack');
			}

			const destination = await loadDest(destId);
			const tmp = mkdtempSync(join(tmpdir(), 'dh-redeploy-'));
			try {
				const include = `/metadata/stacks/${name}/stackfiles`;
				const run = await restic.runLocal(destination, ['restore', snapId, '--target', tmp, '--include', include], 'data');
				const extractedDir = join(tmp, 'metadata', 'stacks', name, 'stackfiles');
				const extractedNames = run.exitCode === 0 && existsSync(extractedDir) ? readdirSync(extractedDir) : [];
				if (!extractedNames.includes(composeFileName)) {
					throw new Error(`snapshot stackfiles/ is missing the compose file "${composeFileName}"; cannot redeploy`);
				}
				const r = await redeployStackFromDir(name, extractedDir, composeFileName, envId ?? undefined);
				if (!r.success) throw new Error(r.error || 'docker compose up failed');
			} finally {
				try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
			}
		},
		readSnapshotMetadata: (destId, snapId) => getSnapshotMetadata(destId, snapId),
		// Materialise the snapshot's captured stack files into Dockhand's LOCAL data
		// dir (targetPath) so Dockhand can manage/redeploy the restored stack. The
		// files were backed up under /metadata/stacks/<name>/stackfiles/; dump that
		// subtree as a tar and extract it flat into targetPath.
		writeLocalStackFiles: async (destId, snapId, stackName, targetPath, overwrite) => {
			const { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync, readdirSync, renameSync } = await import('fs');
			const { tmpdir } = await import('os');
			const { join, dirname, resolve, sep } = await import('path');
			const { randomUUID } = await import('crypto');
			const { getStacksDir } = await import('../stacks');
			// Use `restic restore --include` (not dump→tar): restore writes a
			// DETERMINISTIC path under the target — <tmp>/metadata/stacks/<name>/
			// stackfiles/ — so there's no tar-prefix guessing. Mirrors the proven
			// approach the previous engine used (commit 5edcfa07 et al.).
			const destination = await loadDest(destId);
			const tmp = mkdtempSync(join(tmpdir(), 'dh-stackfiles-'));
			try {
				const include = `/metadata/stacks/${stackName}/stackfiles`;
				const run = await restic.runLocal(destination, ['restore', snapId, '--target', tmp, '--include', include], 'data');
				if (run.exitCode !== 0) {
					console.log(`[Backup] writeLocalStackFiles: restic restore failed for "${stackName}": ${run.stderr.trim() || `exit ${run.exitCode}`}`);
					return false;
				}
				const extractedDir = join(tmp, 'metadata', 'stacks', stackName, 'stackfiles');
				// DATA-LOSS guard: only proceed if extraction actually produced files.
				// A snapshot that predates full-dir capture, or a corrupt path, yields
				// nothing — replacing the live dir with an empty one would be data loss.
				const extracted = existsSync(extractedDir) ? readdirSync(extractedDir) : [];
				if (extracted.length === 0) {
					console.log(`[Backup] writeLocalStackFiles: no stackfiles extracted for "${stackName}" (snapshot may predate full-dir capture) — leaving ${targetPath} untouched`);
					return false;
				}

				// Path-traversal guard: the resolved target MUST stay under the stacks
				// root before any mkdir/rename/rm — a "../.." name must never let a
				// restore wipe an arbitrary directory.
				const resolvedTarget = resolve(targetPath);
				const stacksRoot = resolve(getStacksDir());
				if (resolvedTarget !== stacksRoot && !resolvedTarget.startsWith(stacksRoot + sep)) {
					console.log(`[Backup] writeLocalStackFiles: refusing target "${resolvedTarget}" outside the stacks root "${stacksRoot}"`);
					return false;
				}

				mkdirSync(resolvedTarget, { recursive: true });

				// Atomic staging-swap (audit #3 / HIGH #2): build the desired contents
				// in a sibling staging dir FIRST, then swap it into place with a
				// same-parent rename, so a mid-copy failure can never leave the live
				// stack dir half-wiped. On OVERWRITE the staging holds ONLY the restored
				// files (stale files cleared); on merge it starts as a copy of the live
				// dir so existing user files are preserved.
				const parent = dirname(resolvedTarget);
				const staging = mkdtempSync(join(parent, '.dockhand-stack-new-'));
				const oldAside = join(parent, `.dockhand-stack-old-${randomUUID()}`);
				try {
					if (!overwrite) {
						for (const existing of readdirSync(resolvedTarget)) {
							cpSync(join(resolvedTarget, existing), join(staging, existing), { recursive: true, force: true });
						}
					}
					for (const entry of extracted) {
						cpSync(join(extractedDir, entry), join(staging, entry), { recursive: true, force: true });
					}
					// Copy fully succeeded — same-parent swap: live aside, staging in.
					renameSync(resolvedTarget, oldAside);
					try {
						renameSync(staging, resolvedTarget);
					} catch (swapErr) {
						try { renameSync(oldAside, resolvedTarget); } catch { /* best effort */ }
						throw swapErr;
					}
					rmSync(oldAside, { recursive: true, force: true });
					console.log(`[Backup] writeLocalStackFiles: wrote ${extracted.length} entries to ${resolvedTarget} (${overwrite ? 'replaced' : 'merged'})`);
					return true;
				} catch (copyErr) {
					// Fail closed: clean up staging/aside, restore the live dir if the
					// swap left it moved, and rethrow so the restore reports FAILED.
					try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
					if (existsSync(oldAside) && !existsSync(resolvedTarget)) {
						try { renameSync(oldAside, resolvedTarget); } catch { /* best effort */ }
					}
					try { rmSync(oldAside, { recursive: true, force: true }); } catch { /* best effort */ }
					throw copyErr;
				}
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		},
		// --- clone (cross-env restore) -----------------------------------------------
		volumeExists: async (name, envId) => {
			const { inspectVolume } = await import('../docker');
			try { await inspectVolume(name, envId ?? undefined); return true; }
			catch { return false; }
		},
		createTargetVolume: async (name, envId) => {
			const { createVolume } = await import('../docker');
			await createVolume({ name }, envId ?? undefined);
		},
	};
}

/** A ResticReader adapter over the shared Restic instance (for snapshots.ts). */
function reader() {
	return { runLocal: (dest: any, args: string[], tier?: 'interactive' | 'data') => restic.runLocal(dest, args, tier) };
}

/** List the volume names present in a snapshot (from `restic ls /volumes/`). */
async function listSnapshotVolumes(destination: any, snapshotId: string): Promise<string[]> {
	const run = await restic.runLocal(destination, ['ls', '--json', '--no-lock', snapshotId, '/volumes/']);
	if (run.exitCode !== 0) return [];
	const names = new Set<string>();
	for (const line of run.stdout.split('\n')) {
		try {
			const e = JSON.parse(line.trim());
			if (e?.struct_type === 'node' && typeof e.path === 'string' && e.path.startsWith('/volumes/')) {
				const parts = e.path.split('/');
				if (parts.length >= 3 && parts[2]) names.add(parts[2]);
			}
		} catch { /* skip non-JSON */ }
	}
	return [...names];
}

async function notify(event: string, payload: Record<string, unknown>, envId: number | null | undefined): Promise<void> {
	try { await sendEventNotification(event as any, payload as any, envId ?? undefined); } catch { /* never changes the outcome */ }
}

/** Persist a durable 'stop' intent so a fresh process can restart a target that
 * was stopped for a consistent backup / in-place restore but never brought back
 * up (process death between the stop and the in-process restart). */
async function recordStopIntent(key: string, intent: StopIntent): Promise<void> {
	await recordOperation({
		id: key,
		kind: 'stop',
		instanceId: await getInstanceId(),
		envId: intent.envId,
		startedAt: new Date().toISOString(),
		stopType: intent.type === 'stack' ? 'stack' : 'container',
		targetName: intent.targetName,
		containers: intent.containers,
	});
}

// =============================================================================
// Public entry points
// =============================================================================

/**
 * Preview a snapshot for the restore UI: the volume names it contains and
 * whether it carries restore metadata / stack files. Ownership-gated. Returns
 * ONLY the volume list (bounded) — it never materialises the full recursive file
 * listing, so a huge snapshot can't OOM the server.
 */
export async function previewSnapshot(
	destinationId: number,
	snapshotId: string,
	access: { isEnterprise: boolean; canAccessEnvironment: (id: number) => Promise<boolean> } = { isEnterprise: false, canAccessEnvironment: async () => true },
): Promise<{ snapshotId: string; volumes: string[]; volumeTypes: Record<string, 'volume' | 'bind'>; volumeSources: Record<string, string>; backupTime: string | null; sourceEnvironmentId: number | null; hasMetadata: boolean; hasStackFiles: boolean }> {
	const destination = await getBackupDestination(destinationId);
	if (!destination) throw new Error('backup destination not found');
	const instanceId = await getInstanceId();
	await guardSnapshotAccess(reader(), destination, instanceId, snapshotId, access);
	const volumes = await listSnapshotVolumes(destination, snapshotId);
	// Cheap metadata presence check (ls the /metadata dir, depth-1).
	const meta = await restic.runLocal(destination, ['ls', '--json', '--no-lock', snapshotId, '/metadata']);
	const hasMetadata = meta.exitCode === 0 && meta.stdout.includes('/metadata/metadata.json');
	const hasStackFiles = meta.exitCode === 0 && meta.stdout.includes('/metadata/stacks');
	// Pull the per-volume type (volume|bind) and the backup time from metadata.json so
	// the restore UI can show the same volume/bind icons as the backup picker. Best-
	// effort: an older snapshot without typed metadata just yields no types.
	const volumeTypes: Record<string, 'volume' | 'bind'> = {};
	// The ORIGINAL location per volume (named volume → its name; bind → its
	// absolute host path), used by the clone UI to pre-fill a 1:1 destination.
	const volumeSources: Record<string, string> = {};
	let backupTime: string | null = null;
	let sourceEnvironmentId: number | null = null;
	if (hasMetadata) {
		const dump = await restic.runLocal(destination, ['dump', '--no-lock', snapshotId, '/metadata/metadata.json']);
		if (dump.exitCode === 0) {
			try {
				const md = JSON.parse(dump.stdout);
				backupTime = md?.backupTime ?? null;
				sourceEnvironmentId = typeof md?.environmentId === 'number' ? md.environmentId : null;
				for (const v of md?.volumes ?? []) {
					// Key by v.key — that's what listSnapshotVolumes returns (the /volumes/<key>
					// segment) and what the restore UI indexes on. For a bind, key !== name
					// (name is the host source), so keying on name left the UI unable to find
					// the bind's type/source → it fell back to 'volume' and mislabelled binds.
					const k = v?.key ?? v?.name;
					if (k && (v.type === 'volume' || v.type === 'bind')) volumeTypes[k] = v.type;
					if (k && typeof v.source === 'string') volumeSources[k] = v.source;
				}
			} catch { /* leave types empty on malformed metadata */ }
		}
	}
	return { snapshotId, volumes, volumeTypes, volumeSources, backupTime, sourceEnvironmentId, hasMetadata, hasStackFiles };
}

// --- snapshot reads (routes already apply the env guard; we add instance own.) ---

async function loadDest(destinationId: number): Promise<any> {
	const d = await getBackupDestination(destinationId);
	if (!d) throw new Error('backup destination not found');
	return d;
}

// Serialize an op on its REPOSITORY, not its destination id. The restic lock is
// per-repo, so two different destination rows pointing at the same repo must
// serialize together or they collide on the lock (a backup then waits out
// `--retry-lock`, ~5-10 min — the CI "backup 603s" symptom). Resolve the repo
// from the id here so callers keep passing a destination id.
async function serializeByRepo<T>(destinationId: number, fn: () => Promise<T>): Promise<T> {
	let key: string;
	try {
		key = (await getBackupDestination(destinationId))?.repository ?? `dest:${destinationId}`;
	} catch {
		key = `dest:${destinationId}`; // fall back to per-id if the lookup fails
	}
	return destSerializer.run(key, fn);
}

/** List a config's (or a destination's) snapshots, newest first. Instance-owned. */
export async function listSnapshots(destinationId: number, configId?: number): Promise<ReturnType<typeof parseSnapshots>> {
	const destination = await loadDest(destinationId);
	const instanceId = await getInstanceId();
	// No per-env filtering here — the route already gated env access; pass a
	// permissive access ctx (instance scoping still applies).
	return listSnapshotsCore(reader(), destination, instanceId, { isEnterprise: false, canAccessEnvironment: async () => true }, configId);
}

/** Browse a snapshot's file tree at a path (restic ls). */
export async function browseSnapshot(destinationId: number, snapshotId: string, path = '/'): Promise<any[]> {
	const destination = await loadDest(destinationId);
	const instanceId = await getInstanceId();
	await guardSnapshotAccess(reader(), destination, instanceId, snapshotId, { isEnterprise: false, canAccessEnvironment: async () => true });
	const run = await restic.runLocal(destination, ['ls', '--json', '--no-lock', snapshotId, path]);
	if (run.exitCode !== 0) throw new Error(run.stderr.trim() || 'could not browse snapshot');
	return parseSnapshotLsEntries(run.stdout, path);
}

/** Dump a single file from a snapshot as text (restic dump). For UTF-8 content
 * only — stored compose.yaml/.env and the inline file preview. Binary downloads
 * must use dumpSnapshotFileBytes so bytes aren't mangled by UTF-8 decoding. */
export async function dumpSnapshotFile(destinationId: number, snapshotId: string, filePath: string): Promise<string> {
	return (await dumpSnapshotFileBytes(destinationId, snapshotId, filePath)).toString('utf8');
}

/** Dump a single file from a snapshot as raw bytes (restic dump). */
export async function dumpSnapshotFileBytes(destinationId: number, snapshotId: string, filePath: string): Promise<Buffer> {
	const destination = await loadDest(destinationId);
	const instanceId = await getInstanceId();
	await guardSnapshotAccess(reader(), destination, instanceId, snapshotId, { isEnterprise: false, canAccessEnvironment: async () => true });
	const run = await restic.runLocalBinary(destination, ['dump', '--no-lock', snapshotId, filePath]);
	if (run.exitCode !== 0) throw new Error(run.stderr.trim() || 'could not dump file');
	return run.stdout;
}

/** Dump a directory from a snapshot as a tar (restic dump --archive tar). Raw
 * bytes — the tar stream is binary and must not be UTF-8 round-tripped. */
export async function dumpSnapshotArchive(destinationId: number, snapshotId: string, dirPath: string): Promise<Buffer> {
	const destination = await loadDest(destinationId);
	const instanceId = await getInstanceId();
	await guardSnapshotAccess(reader(), destination, instanceId, snapshotId, { isEnterprise: false, canAccessEnvironment: async () => true });
	const run = await restic.runLocalBinary(destination, ['dump', '--no-lock', '--archive', 'tar', snapshotId, dirPath], 'data');
	if (run.exitCode !== 0) throw new Error(run.stderr.trim() || 'could not dump archive');
	return run.stdout;
}

/** Read the restore metadata.json embedded in a snapshot, or null. */
export async function getSnapshotMetadata(destinationId: number, snapshotId: string): Promise<any | null> {
	const destination = await loadDest(destinationId);
	const instanceId = await getInstanceId();
	await guardSnapshotAccess(reader(), destination, instanceId, snapshotId, { isEnterprise: false, canAccessEnvironment: async () => true });
	const run = await restic.runLocal(destination, ['dump', '--no-lock', snapshotId, '/metadata/metadata.json']);
	if (run.exitCode !== 0) return null;
	try { return JSON.parse(run.stdout); } catch { return null; }
}

/** Diff two snapshots (restic diff — text output). */
export async function diffSnapshots(destinationId: number, snapshotA: string, snapshotB: string): Promise<SnapshotDiff> {
	const destination = await loadDest(destinationId);
	const instanceId = await getInstanceId();
	await guardSnapshotAccess(reader(), destination, instanceId, snapshotA, { isEnterprise: false, canAccessEnvironment: async () => true });
	await guardSnapshotAccess(reader(), destination, instanceId, snapshotB, { isEnterprise: false, canAccessEnvironment: async () => true });
	const run = await restic.runLocal(destination, ['diff', '--json', '--no-lock', snapshotA, snapshotB], 'data');
	if (run.exitCode !== 0) throw new Error(run.stderr.trim() || 'could not diff snapshots');
	return { ...parseResticDiff(run.stdout), raw: run.stdout };
}

export type ForgetSnapshotResult = { ok: true } | { ok: false; reason: 'not-owned' | 'error'; error?: string };

/** Forget (delete) a single snapshot — instance-ownership enforced first. */
/**
 * Mirror a manual repo/snapshot operation to the process log (docker logs), with
 * restic's own output, so prune/check/unlock/repair/stats/forget/init/test/verify
 * are debuggable from `docker logs dockhand` — not just recorded in the audit DB.
 * Matches the [Backup:…]/[Restore:…] tags emitted by operations.ts. Best-effort:
 * logging never alters the operation result.
 */
function logRepoOp(destName: string, op: string, ok: boolean, detail?: { output?: string; error?: string }): void {
	const tag = `[BackupRepo:${destName}]`;
	console.log(`${tag} ${op} — ${ok ? 'ok' : 'FAILED'}`);
	const out = (detail?.output ?? '').trim();
	const err = (detail?.error ?? '').trim();
	if (out) for (const line of out.split('\n')) console.log(`${tag} [restic] ${line}`);
	if (err) for (const line of err.split('\n')) console.log(`${tag} [restic:err] ${line}`);
}

export async function forgetSnapshot(destinationId: number, snapshotId: string): Promise<ForgetSnapshotResult> {
	const destination = await loadDest(destinationId);
	const instanceId = await getInstanceId();
	try {
		await guardSnapshotAccess(reader(), destination, instanceId, snapshotId, { isEnterprise: false, canAccessEnvironment: async () => true });
	} catch {
		return { ok: false, reason: 'not-owned' };
	}
	// forget --prune takes the restic repo lock; serialize on the destination so it
	// can't run against a backup writing to the same repo (they'd collide on the lock).
	const run = await serializeByRepo(destinationId, () =>
		restic.runLocal(destination, ['forget', snapshotId, '--prune', '--retry-lock', '5m'], 'data'),
	);
	logRepoOp(destination.name, `forget ${snapshotId.slice(0, 8)}`, run.exitCode === 0, { output: run.stdout, error: run.stderr });
	if (run.exitCode !== 0) return { ok: false, reason: 'error', error: run.stderr.trim() || 'forget failed' };
	return { ok: true };
}

// --- repository maintenance ---

export async function initRepository(destinationId: number): Promise<void> {
	const destination = await loadDest(destinationId);
	const r = await initRepoCore(reader(), destination);
	logRepoOp(destination.name, 'init', r.ok, r.ok ? { output: r.output } : { error: r.error });
	if (!r.ok) throw new Error(r.error);
}

export async function testRepository(destinationId: number): Promise<{ ok: boolean; needsInit?: boolean; error?: string }> {
	const destination = await loadDest(destinationId);
	const r = await testRepoCore(reader(), destination);
	logRepoOp(destination.name, 'test', r.ok, r.ok ? undefined : { error: r.error });
	if (r.ok) return { ok: true };
	return { ok: false, needsInit: r.code === 'REPO_NOT_INITIALIZED', error: r.error };
}

export async function verifyBackup(
	destinationId: number,
	opts?: { dataSubset?: string; onProgress?: (message: string) => void },
): Promise<{ success: boolean; output?: string; error?: string }> {
	const destination = await loadDest(destinationId);
	const r = await checkRepository(reader(), destination, opts?.dataSubset ?? '5%');
	logRepoOp(destination.name, `verify (${opts?.dataSubset ?? '5%'})`, r.ok, r.ok ? { output: r.output } : { error: r.error });
	return r.ok ? { success: true, output: r.output } : { success: false, error: r.error };
}

/** A repo-maintenance task. `repair-index`/`repair-snapshots` map to restic
 * `repair index` / `repair snapshots`. */
export type RepoTask = 'unlock' | 'check' | 'prune' | 'stats' | 'repair-index' | 'repair-snapshots';

/** Run a repo-maintenance task. Returns { success } for the route + activity log. */
export interface RepoStats { totalSize: number; totalFiles: number; snapshots: number }

export async function runRepoTask(destinationId: number, task: RepoTask, opts?: { maxUnused?: string; dataSubset?: string }): Promise<{ success: boolean; output?: string; error?: string; stats?: RepoStats }> {
	const destination = await loadDest(destinationId);
	if (task === 'repair-index' || task === 'repair-snapshots') {
		const sub = task === 'repair-index' ? 'index' : 'snapshots';
		// repair takes the repo lock — serialize against a concurrent backup to the same repo.
		const run = await serializeByRepo(destinationId, () => restic.runLocal(destination, ['repair', sub], 'data'));
		logRepoOp(destination.name, `repair ${sub}`, run.exitCode === 0, { output: run.stdout, error: run.stderr });
		return run.exitCode === 0 ? { success: true, output: run.stdout.trim() } : { success: false, error: run.stderr.trim() || 'repair failed' };
	}
	// prune/check hold the repo lock; run them serialized on the destination so a
	// scheduled maintenance pass can't collide with a backup writing to the same repo.
	// unlock is ALSO serialized: it now uses `--remove-all` (see unlockRepository), so
	// running it unserialized could wipe the LIVE lock of a concurrent backup/restore on
	// the same repo in THIS instance. Serializing means the only locks it clears are
	// orphans (dead owners) — exactly its documented job. stats (--no-lock) is read-safe
	// and stays unserialized.
	const r = task === 'prune' ? await serializeByRepo(destinationId, () => pruneRepository(reader(), destination, opts?.maxUnused))
		: task === 'check' ? await serializeByRepo(destinationId, () => checkRepository(reader(), destination, opts?.dataSubset))
		: task === 'unlock' ? await serializeByRepo(destinationId, () => unlockRepository(reader(), destination))
		: await repoStats(reader(), destination);
	logRepoOp(destination.name, task, r.ok, r.ok ? { output: r.output } : { error: r.error });
	if (!r.ok) return { success: false, error: r.error };
	// The stats task returns restic's `stats --json` output; parse it into the
	// shape the UI reads ({ totalSize, totalFiles, snapshots }).
	if (task === 'stats') {
		let stats: RepoStats = { totalSize: 0, totalFiles: 0, snapshots: 0 };
		try {
			const parsed = JSON.parse(r.output ?? '{}');
			stats = {
				totalSize: parsed.total_size ?? 0,
				totalFiles: parsed.total_file_count ?? 0,
				snapshots: parsed.snapshots_count ?? 0,
			};
		} catch { /* leave zeros if restic output isn't parseable */ }
		return { success: true, output: r.output, stats };
	}
	return { success: true, output: r.output };
}

// --- cancellation + running check ---

/** Signal every running helper container whose name starts with `prefix`, in the
 * given env (default SIGKILL). Returns the ids signalled. */
async function killHelpers(prefix: string, envId: number | null | undefined, signal?: string): Promise<string[]> {
	const { listContainers, dockerFetch } = await import('../docker');
	const ids: string[] = [];
	const q = signal ? `?signal=${encodeURIComponent(signal)}` : '';
	try {
		const containers = await listContainers(true, envId ?? undefined);
		for (const c of containers) {
			if (c.state === 'running' && c.name?.startsWith(prefix)) {
				try { await dockerFetch(`/containers/${c.id}/kill${q}`, { method: 'POST' }, envId ?? undefined); ids.push(c.id); } catch { /* best effort */ }
			}
		}
	} catch { /* daemon unreachable */ }
	return ids;
}

/** Cancel a running backup GRACEFULLY: send SIGINT so restic releases its repo
 * lock before exiting (a SIGKILL orphans the lock and the next backup hangs on
 * --retry-lock). Safety net: if the helper is still alive ~15s later, SIGKILL it
 * so a cancel never itself hangs. */
export async function cancelBackup(configId: number): Promise<boolean> {
	const config = await getBackupConfig(configId);
	const envId = config?.environmentId ?? undefined;
	const prefix = `dockhand-backup-${configId}`;
	const signalled = await killHelpers(prefix, envId, 'SIGINT');
	if (signalled.length === 0) return false;
	// Force-kill any helper that ignored SIGINT (pathological restic hang), so the
	// user's cancel resolves regardless. Best-effort, out of band.
	void (async () => {
		const { listContainers, dockerFetch } = await import('../docker');
		for (let i = 0; i < 15; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			try {
				const alive = (await listContainers(true, envId)).some((c) => c.state === 'running' && signalled.includes(c.id));
				if (!alive) return;
			} catch { return; }
		}
		for (const id of signalled) {
			try { await dockerFetch(`/containers/${id}/kill`, { method: 'POST' }, envId); } catch { /* gone */ }
		}
	})();
	return true;
}

/** Cancel a running restore. A blanket cancel (no snapshotId) never kills a
 * swap-recovery helper (that is a data-safety op, not a user restore). */
export async function cancelRestore(snapshotId?: string, environmentId?: number): Promise<boolean> {
	if (snapshotId) return (await killHelpers(`dockhand-restore-${snapshotId.slice(0, 12)}`, environmentId)).length > 0;
	// Blanket: kill restore helpers but NOT recovery helpers.
	const { listContainers, dockerFetch } = await import('../docker');
	let killed = false;
	try {
		const containers = await listContainers(true, environmentId);
		for (const c of containers) {
			if (c.state !== 'running' || !c.name?.startsWith('dockhand-restore-')) continue;
			if (c.name.startsWith('dockhand-restore-recover-')) continue;
			try { await dockerFetch(`/containers/${c.id}/kill`, { method: 'POST' }, environmentId); killed = true; } catch { /* best effort */ }
		}
	} catch { /* daemon unreachable */ }
	return killed;
}

/** Whether a backup for this specific config is currently running (so a config
 * edit/delete can be blocked mid-run). */
export function isBackupRunning(configId: number): boolean {
	return runningBackupConfigs.has(configId);
}

/** Whether any config writing to this destination has a backup in flight, so a
 * destination edit/delete can be blocked while its repo is being written to
 * (changing the repo/password or deleting the row mid-backup breaks the run). */
export async function destinationHasRunningBackup(destinationId: number): Promise<boolean> {
	if (runningBackupConfigs.size === 0) return false;
	const configs = await getBackupConfigs();
	for (const config of configs) {
		if (config.destinationId === destinationId && runningBackupConfigs.has(config.id)) return true;
	}
	return false;
}

// --- re-exports of self-contained helpers unaffected by the rewrite ---
export { assertStackBackupable } from './validate';

/**
 * Rotate a destination's restic repository password (DB-bound wrapper). Binds the
 * real destination store + per-destination serializer, then defers to the pure
 * rotation in repo.ts.
 */
export function rotateDestinationPassword(
	destinationId: number,
	currentPassword: string,
	newPassword: string,
): ReturnType<typeof rotateCore> {
	return rotateCore(
		{
			restic,
			getDecryptedDestination: async (id) => {
				const dest = await getBackupDestination(id);
				if (!dest) return null;
				const decrypted = decryptBackupDestination(dest);
				return { ...decrypted, id: dest.id, decryptedPassword: decrypted.decryptedPassword };
			},
			updatePassword: (id, password) => updateBackupDestination(id, { password }).then(() => undefined),
			serializeDestination: (id, fn) => serializeByRepo(id, fn),
		},
		destinationId,
		currentPassword,
		newPassword,
	);
}

/**
 * Resolve a snapshot's owning environment id (DB-bound wrapper for the route
 * guard). Binds the destination + this install's instance id, then defers to the
 * pure resolver. Fails closed (unresolved) if the destination is unknown.
 */
export async function resolveSnapshotEnvId(
	destinationId: number,
	snapshotId: string,
): Promise<{ envId: number | null | undefined; resolved: boolean }> {
	const destination = await getBackupDestination(destinationId);
	if (!destination) return { envId: undefined, resolved: false };
	const instanceId = await getInstanceId();
	return resolveSnapshotEnvIdCore(reader(), destination, instanceId, snapshotId);
}

/** Drop snapshots whose owning environment the caller can't access (env-scoped
 * disclosure guard for the destination-wide list). Pure filter re-exported so the
 * route guard has one entry point. */
export { filterSnapshotsByAccessibleEnv };

/** Run a backup for a config id. Loads + validates the config, binds the
 * destination, and runs the service. */
export async function runBackup(configId: number, triggeredBy: 'cron' | 'manual' | 'webhook', onProgress?: (status: string, message: string) => void): Promise<BackupResult> {
	// Register as running BEFORE loading the config, so a concurrent config-delete
	// (which refuses while isBackupRunning) can't slip between the load and the
	// registration and delete a config out from under an in-flight run. If the
	// config is already gone by the time we load it, bail and unregister.
	runningBackupConfigs.add(configId);
	try {
		return await runBackupRegistered(configId, triggeredBy, onProgress);
	} finally {
		runningBackupConfigs.delete(configId);
	}
}

async function runBackupRegistered(configId: number, triggeredBy: 'cron' | 'manual' | 'webhook', onProgress?: (status: string, message: string) => void): Promise<BackupResult> {
	const config = await getBackupConfig(configId);
	if (!config) return { status: 'error', code: 'VALIDATION', error: 'backup config not found' };
	const destination = await getBackupDestination(config.destinationId);
	if (!destination) return { status: 'error', code: 'VALIDATION', error: 'backup destination not found' };

	const opts = parseOptionsJson((config as any).options);
	const job: BackupJob = {
		configId: config.id,
		type: (config.type as BackupTargetType) ?? 'container',
		targetName: config.targetName,
		environmentId: config.environmentId ?? null,
		destinationId: config.destinationId,
		allVolumes: config.allVolumes ?? true,
		selectedVolumes: config.selectedVolumes ? JSON.parse(config.selectedVolumes) : null,
		stopBeforeBackup: config.stopBeforeBackup ?? false,
		retention: config.retention ?? null,
		options: {
			excludePatterns: typeof opts.excludePatterns === 'string' ? opts.excludePatterns.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
			excludeCaches: opts.excludeCaches,
			compression: opts.compression,
			limitUpload: opts.limitUpload,
			limitDownload: opts.limitDownload,
			webhookSuccess: typeof opts.webhookSuccess === 'string' ? opts.webhookSuccess : undefined,
			webhookFailure: typeof opts.webhookFailure === 'string' ? opts.webhookFailure : undefined,
		},
		helperName: `dockhand-backup-${config.id}`,
	};

	return await new BackupService(backupPorts(destination, onProgress)).run(job, triggeredBy);
}

/** Run a restore. The route layer has already validated the request + auth and
 * supplies the caller's access context for the ownership guard. */
/** A filesystem repo (absolute or relative path) rather than a remote backend. */
function isLocalRepo(repository: string): boolean {
	return repository.startsWith('/') || repository.startsWith('./');
}
/** An environment whose Docker daemon is NOT Dockhand's own host. */
function isRemoteEnv(connectionType?: string | null, host?: string | null): boolean {
	if (!connectionType) return false;
	if (connectionType === 'hawser-standard' || connectionType === 'hawser-edge') return true;
	if (connectionType === 'direct' && !!host) return true;
	return false;
}

export async function runRestore(
	job: RestoreJob,
	access: { isEnterprise: boolean; canAccessEnvironment: (id: number) => Promise<boolean> } = { isEnterprise: false, canAccessEnvironment: async () => true },
	onProgress?: (status: string, message: string) => void,
): Promise<RestoreResult> {
	const destination = await getBackupDestination(job.destinationId);
	if (!destination) return { status: 'error', code: 'VALIDATION', error: 'backup destination not found' };

	// A local filesystem repository lives on Dockhand's own host and is bind-mounted
	// into the restore helper. That only works when the helper runs on the same host
	// (socket env); on a remote environment the repo path doesn't exist, so the
	// restore would fail deep in restic. Reject it up front with a clear message —
	// mirrors the same guard on the backup-config path.
	if (job.environmentId != null && isLocalRepo(destination.repository)) {
		const env = await getEnvironment(job.environmentId);
		if (env && isRemoteEnv(env.connectionType, env.host)) {
			return { status: 'error', code: 'VALIDATION', error: `Local repository "${destination.name}" cannot restore to remote environment "${env.name}" — the repository path only exists on Dockhand's host. Use an S3 or REST destination for cross-host restores.` };
		}
	}

	return new RestoreService(restorePorts(destination, access, onProgress)).run(job, 'manual');
}

// =============================================================================
// Startup reconciliation — ONE pass, fixed order
// =============================================================================

/**
 * On startup, recover interrupted operations, in a fixed order so a container is
 * never restarted onto a half-swapped volume:
 *   1. roll back any interrupted volume swap (from the durable journal);
 *   2. restart any target left stopped for a backup / in-place restore whose
 *      in-process restart never ran (process died between stop and restart);
 *   3. mark any operation left `running` by a dead process as terminal (scrub).
 *
 * Step 2 MUST run after step 1 so a container is never restarted onto a
 * half-swapped volume. Returns the counts for each recovery step.
 */
export async function reconcileOnStartup(): Promise<{ swapsRolledBack: number; containersRestarted: number; opsScrubbed: number }> {
	const instanceId = await getInstanceId();
	let swapsRolledBack = 0;

	// 1. interrupted restore swaps (kind 'swap' in the journal). The recovery is a
	// pure shell rollback inside the volume — it does NOT touch the restic repo,
	// so it needs no real destination (empty repo/password; only the volume binds
	// and env matter).
	const swaps = await listOperations('swap', instanceId).catch(() => []);
	const recoveryDest = { repository: '', password: '', envVars: null, flags: null, hostPath: null } as any;
	for (const rec of swaps) {
		try {
			const includes = rec.includes ?? [];
			const binds = rec.volumeBinds ?? [];
			if (includes.length === 0) { await clearOperation(rec.id); continue; }
			await restic.runInHelper(recoveryDest, {
				script: buildSwapRecoveryScript(includes),
				args: [],
				binds,
				envId: rec.envId ?? undefined,
				name: `dockhand-restore-recover-${rec.id.slice(-8)}`,
				timeout: 'data',
			});
			await clearOperation(rec.id);
			swapsRolledBack++;
		} catch {
			// Leave the record for a later startup to retry.
		}
	}

	// 2. restart targets stopped for a backup / in-place restore whose restart
	// never ran. AFTER the swap rollback above (never restart onto a half-swapped
	// volume). Each intent is best-effort: a failure leaves the row for the next
	// startup and never aborts the pass.
	let containersRestarted = 0;
	const stopIntents = await listOperations('stop', instanceId).catch(() => []);
	const { startContainer, inspectContainer } = await import('../docker');
	const { startStack, listComposeStacks } = await import('../stacks');

	// Whether the intent's target still exists. A stop intent for a target that has
	// since been DELETED (user removed the container, or a test tore it down) can
	// never be satisfied by a restart — startContainer/startStack would 404 forever
	// and the row would be retried on every startup, accumulating stale intents
	// indefinitely (observed: a 4-day-old intent for a long-gone container). We only
	// treat a 404 (target genuinely absent) as "gone"; any other error (env offline,
	// daemon down) is transient, so the intent is kept for a later retry.
	async function targetExists(action: RestartAction): Promise<boolean> {
		try {
			if (action.type === 'stack') {
				const stacks = await listComposeStacks(action.envId ?? undefined);
				return stacks.some((s) => s.name === action.targetName);
			}
			// container: exists if ANY recorded container id still inspects.
			for (const c of action.containers) {
				try {
					await inspectContainer(c.id, action.envId ?? undefined);
					return true;
				} catch (err) {
					if (!isTargetGoneError(err)) throw err; // transient — bubble up, keep intent
					// 404 → this id is gone; check the next recorded container
				}
			}
			return false; // all recorded ids 404'd → target gone
		} catch {
			// Couldn't determine existence (env unreachable etc.) — assume it may
			// still exist so we don't drop a live intent; leave it for a later pass.
			return true;
		}
	}

	for (const action of planStopRecovery(stopIntents)) {
		// Drop intents whose target no longer exists — a restart can never succeed.
		if (!(await targetExists(action))) {
			await clearOperation(action.intentId).catch(() => {});
			continue;
		}
		try {
			if (action.type === 'stack') {
				const r = await startStack(action.targetName, action.envId ?? undefined);
				if (!r.success) throw new Error(r.error || 'stack start failed');
			} else {
				for (const c of action.containers) await startContainer(c.id, action.envId ?? undefined);
			}
			await clearOperation(action.intentId);
			containersRestarted++;
		} catch {
			// Leave the record for a later startup to retry.
		}
	}

	// 3. scrub stale running operations.
	const opsScrubbed = await scrubInterruptedOperations().catch(() => 0);

	return { swapsRolledBack, containersRestarted, opsScrubbed };
}
