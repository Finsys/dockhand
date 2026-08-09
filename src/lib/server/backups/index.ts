/**
 * backups/index.ts — the composition root. Wires the pure BackupService /
 * RestoreService to the real world (db, docker, restic, stacks, notifications)
 * by implementing their injected port interfaces. This is the only place in the
 * domain that touches everything, so the seams stay visible.
 *
 * Public surface:
 *   runBackup(configId, trigger)         → run a backup for a config
 *   runRestore(request)                  → run a restore
 *   the read/repo helpers re-exported for the API routes
 */
import { Restic, type HelperRunSpec } from './restic';
import { BackupService, formatResticLines, type BackupPorts, type BackupJob, type OperationHandle } from './backup-service';
import { RestoreService, type RestorePorts, type RestoreJob } from './restore-service';
import { openOperation } from './operations';
import { LiveTargetLocks, DestinationSerializer } from './locks';
import { resolveTargets, discoverVolumes, stopForBackup } from './docker';
import { guardSnapshotAccess, listSnapshots as listSnapshotsCore, resolveSnapshotEnvId as resolveSnapshotEnvIdCore, filterSnapshotsByAccessibleEnv } from './snapshots';
import { initRepository as initRepoCore, testRepository as testRepoCore, checkRepository, pruneRepository, unlockRepository, repoStats, rotateDestinationPassword as rotateCore } from './repo';
import { parseRetention, buildForgetArgs, checkWouldWipe } from './retention';
import { buildSnapshotLayout, serializeLayout, parseSnapshotLayout, type SnapshotLayout, type SnapshotStack, type SnapshotSecret } from './snapshot-layout';
import { instanceTagFilter, parseSnapshots, retentionTagFilter, BackupError } from './models';
import { parseOptionsJson, buildJobOptions, parseSelectedVolumes, parseBackupFlags, sanitizeRestoreFlags, fireWebhook, parseResticDiff, type SnapshotDiff } from './helpers';
import { getHostname } from '../license';
import { getBackupConfig, getBackupConfigs, getBackupDestination, updateBackupConfig, updateBackupDestination, decryptBackupDestination } from '../db';
import { getInstanceId } from './identity';
import { inspectContainer } from '../docker';
import { sendEventNotification } from '../notifications';
import type { BackupResult, RestoreResult, ResticRun, BackupTargetType } from './models';
import type { MetadataFile } from './backup-script';
import type { DiscoveredVolume } from './discovery-core';
import { volumeBind } from './discovery-core';
import { resolveBindFromMetadata } from './restore-core';
import { parseSnapshotLsEntries } from './browse-core';

// --- shared singletons (in-memory locks live for the process lifetime) -------
const restic = new Restic();
const liveLocks = new LiveTargetLocks();
const destSerializer = new DestinationSerializer();
/** Config ids with a backup currently in flight — so a config edit/delete can
 * be blocked mid-run. Maintained by runBackup. */
const runningBackupConfigs = new Set<number>();
/** Config ids whose in-flight backup the user asked to cancel. Set by cancelBackup,
 * read by the engine so a helper it SIGKILLs (exit 137) is reported as "cancelled",
 * not as a restic failure. Cleared with runningBackupConfigs when the run ends. */
const cancellingBackupConfigs = new Set<number>();

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
// Stack-dir capture plan — the ONE place that locates a stack's HOST folder
// =============================================================================
/**
 * A stack's directory is ALWAYS captured by bind-mounting it from the TARGET daemon's HOST at
 * /volumes/__dockhand_stackdir__:ro (restic reads it from disk); the helper is a sibling
 * container on that daemon, so a host path on it is always mountable. The host path is resolved
 * by resolveHostStackDir. A stack whose folder can't be located resolves to `unknown` -> the
 * caller HARD-FAILS (never silently skip files the user expects). Compose bind DIRECTORIES
 * inside the stack dir ride their own /volumes/<key>, so they are --exclude'd here (keeps
 * volume deselection meaningful; an in-place whole-dir restore can't clobber a deselected data dir).
 */

/**
 * List a stack's containers (retrying while empty, since a just-deployed stack takes a moment
 * to become listable) and, in ONE inspect pass, harvest the two host-path signals the planner
 * needs: every bind mount `Source`, and the compose `working_dir` label. Both from the SAME
 * container list so they can't disagree on which containers are visible.
 */
async function collectStackContainerHostInfo(
	targetName: string,
	envId: number | null | undefined,
	attempts = 7,
): Promise<{ containers: Array<{ id: string; name: string; state: string }>; bindSources: string[]; workingDirLabel: string | null }> {
	// A just-deployed stack can take a few seconds to become listable (slower under CI load) -
	// missing it leaves a bind-less stack with no working_dir label -> UNKNOWN. Retry over ~15s
	// (attempts=7). The config-time PROBE passes attempts=1: there the stack already exists, so
	// a non-listable container is legitimately stopped/absent and waiting 15s just hangs the picker.
	let containers: Array<{ id: string; name: string; state: string }> = [];
	const ATTEMPTS = Math.max(1, attempts);
	for (let i = 0; i < ATTEMPTS; i++) {
		try { containers = (await resolveTargets('stack', targetName, envId)).containers; } catch { containers = []; }
		if (containers.length > 0) break;
		if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2500));
	}
	if (containers.length === 0 && ATTEMPTS > 1) console.warn(`[Backup] collectStackContainerHostInfo "${targetName}": no containers listed after ${ATTEMPTS} tries (~${(ATTEMPTS - 1) * 2.5}s) - a bind-less stack will resolve to UNKNOWN`);

	const bindSources: string[] = [];
	let workingDirLabel: string | null = null;
	for (const c of containers) {
		try {
			const insp = await inspectContainer(c.id, envId ?? undefined) as { Mounts?: Array<{ Type?: string; Source?: string }>; Config?: { Labels?: Record<string, string> } };
			for (const m of insp.Mounts ?? []) if (m.Type === 'bind' && m.Source) bindSources.push(m.Source);
			if (!workingDirLabel) workingDirLabel = insp.Config?.Labels?.['com.docker.compose.project.working_dir'] || null;
		} catch { /* one container's inspect failing just means fewer bind sources to match */ }
	}
	return { containers, bindSources, workingDirLabel };
}

async function planStackDirVolume(
	targetName: string,
	envId: number | null | undefined,
	excludedStackFiles?: string[],
	attempts = 7,
): Promise<
	| { kind: 'unknown'; reason: string }
	| { kind: 'candidate'; syntheticVolume: DiscoveredVolume; volumeKey: string; composeFileName: string; excludePaths: string[]; bindSources: string[] }
	| { kind: 'tar'; localStackDir: string; composeFileName: string }
> {
	const { getStackComposeFile } = await import('../stacks');
	const { dirname, join, basename } = await import('path');
	const { lstatSync } = await import('fs');
	const { translateToHostPath, translateContainerPathViaMount, getOwnDockerHost, getAutoDetectedDockerHost } = await import('../host-path');
	const { resolveHostStackDir, deriveStackDirFromBinds, trustBindDerivedForEnv, isLocalDaemon, STACKDIR_VOLUME_KEY } = await import('./stackdir-plan');
	const { relativeBindDirsFromCompose, relativeBindsFromCompose } = await import('./stackfile-filter');

	// The stack dir as DOCKHAND sees it (compose file's parent). This is the authoritative
	// source for BOTH the compose filename (not the config_files label, which is `-` for stdin
	// deploys) and the host-path translations below.
	const compose = await getStackComposeFile(targetName, envId ?? undefined);
	const dockhandStackDir = compose.success && compose.composePath ? dirname(compose.composePath) : null;
	const composeFileName0 = compose.success && compose.composePath ? basename(compose.composePath) : null;

	// Inspect the stack's containers ONCE and harvest BOTH host-path candidates (bind mount
	// sources + the working_dir label) from that single pass, so they agree on which containers
	// are visible.
	const { containers: stackContainers, bindSources, workingDirLabel } =
		await collectStackContainerHostInfo(targetName, envId, attempts);

	// PRIMARY, authoritative host-path source: match the compose's relative bind dirs to the host
	// paths the DAEMON reports for them (mount.Source). Needs no DATA_DIR/HOST_DATA_DIR config and
	// works on socket/direct-local/adopted/hawser alike.
	let bindDerivedHostPath: string | null = null;
	try {
		// ALL relative binds (files AND dirs), not just dirs: a single-file bind (./config.yaml)
		// also pins the stack dir via its daemon-reported mount.Source, so it derives the host
		// path without the working_dir label (which needs the container listable - a timing race
		// under load that made bind-less/single-file stacks resolve to UNKNOWN in CI).
		const relBinds = compose.content && dockhandStackDir ? relativeBindsFromCompose(compose.content, dockhandStackDir) : [];
		if (relBinds.length > 0) bindDerivedHostPath = deriveStackDirFromBinds(relBinds, bindSources);
	} catch { /* best-effort: fall through to translation/label candidates below */ }

	// The DATA_DIR / mount translations map a container path to DOCKHAND'S OWN host - valid ONLY
	// when the target daemon IS Dockhand's host. For a REMOTE env (hawser, or a direct env whose
	// tcp host != Dockhand's) the stack lives on a different machine, so those translations would
	// hand the helper a path that only exists on Dockhand's host (the rambo bug). Gate them on
	// isLocalDaemon; bind-derived (from the target daemon's own mount.Source) and the working_dir
	// label stay valid for remote.
	// Default agent STACKS_DIR (compose.go: getEnvString("STACKS_DIR", "/data/stacks")). A hawser
	// stack is deployed by the AGENT into <STACKS_DIR>/<projectName> on the agent's HOST, so this
	// is where the helper finds the compose/config for a host-mount backup. The user can override
	// it per-env via the "Remote stack path (for backup)" setting when the agent uses a custom
	// STACKS_DIR; the in-helper probe validates the guess and errors clearly if it's wrong.
	const HAWSER_DEFAULT_STACKS_DIR = '/data/stacks';
	let envConnType: string | null = null;
	let envTcpHost: string | null = null;
	let remoteStacksDir: string | null = null;
	let isHawser = false;
	if (envId != null) {
		try {
			const { getEnvironment, getEnvSetting } = await import('../db');
			const env = await getEnvironment(envId);
			envConnType = env?.connectionType ?? null;
			envTcpHost = env?.host && env?.port ? `tcp://${env.host}:${env.port}` : null;
			isHawser = envConnType === 'hawser-standard' || envConnType === 'hawser-edge';
			if (envConnType === 'direct') {
				const rsd = await getEnvSetting('remote_stacks_dir', envId);
				remoteStacksDir = typeof rsd === 'string' && rsd.trim() ? rsd.trim().replace(/\/+$/, '') : null;
			} else if (isHawser) {
				// Same `remote_stacks_dir` setting as direct, but for hawser it is a BACKUP-ONLY
				// declaration of where the AGENT keeps stack files on its host - it does NOT steer
				// deploy (the agent hardcodes its STACKS_DIR); it only tells the backup helper where
				// to bind-mount. Falls back to the agent's default STACKS_DIR (/data/stacks) so a
				// standard agent needs no configuration.
				const rsd = await getEnvSetting('remote_stacks_dir', envId);
				remoteStacksDir = typeof rsd === 'string' && rsd.trim()
					? rsd.trim().replace(/\/+$/, '')
					: HAWSER_DEFAULT_STACKS_DIR;
			}
		} catch { /* treat as unknown -> non-local (safe: skips the wrong-host translation) */ }
	}
	const ownHost = getOwnDockerHost() ?? getAutoDetectedDockerHost();
	const localDaemon = isLocalDaemon(envConnType, envTcpHost, ownHost);

	// A direct-REMOTE daemon (not Dockhand's host) shares no filesystem with Dockhand. Its
	// working_dir label is Dockhand's OWN path (the stack was deployed via stdin), NOT a path on
	// the remote host - trusting it mounts a phantom empty dir (the rambo bug). So for a remote
	// direct env the decision is explicit, not guessed:
	//   - remote_stacks_dir SET -> the deploy staged the files at <base>/<stack> on the host, so
	//     that IS the host path (bind-derived can still win below if a bind pins it more exactly).
	//   - remote_stacks_dir UNSET -> nothing was staged; capture the compose/config from
	//     Dockhand's OWN copy via a tar into the snapshot (no host bind, so no :ro mask). The
	//     caller signals this with kind: 'tar'.
	const directRemote = envConnType === 'direct' && !localDaemon;
	// The working_dir label is only trustworthy for hawser (agent ran compose on its host) or a
	// LOCAL daemon. For direct-remote it's Dockhand's path, so drop it from the candidates.
	const trustedWorkingDirLabel = directRemote ? null : workingDirLabel;
	// The user-declared (or defaulted) host path where the stack folder lives, for direct-remote
	// AND hawser. For hawser this is the agent's STACKS_DIR (default /data/stacks) - the DETERMINISTIC
	// host location, so it wins over the flaky working_dir label (which is "/" for a start-from-stdin
	// hawser stack). The in-helper probe confirms the compose is actually there.
	const remoteStacksDirHostPath = (directRemote || isHawser) && remoteStacksDir ? `${remoteStacksDir}/${targetName}` : null;

	// bind-derived is a PHANTOM empty dir for a direct-remote stdin deploy with no remote_stacks_dir
	// (see trustBindDerivedForEnv) - distrust it there so resolution falls through to kind:'tar'.
	const trustedBindDerived = trustBindDerivedForEnv(bindDerivedHostPath, { directRemote, hasRemoteStacksDir: !!remoteStacksDir });

	// Fallback host-path candidates (LOCAL daemon only). dataDirHostPath: DATA_DIR -> HOST_DATA_DIR
	// (returns the input unchanged when NOT under DATA_DIR, so we null it in that case).
	// mountHostPath: via a container bind mount (adopted/external stacks outside DATA_DIR).
	// workingDirLabel: for hawser/matching-paths where the label already IS the host path.
	const viaDataRaw = localDaemon && dockhandStackDir ? translateToHostPath(dockhandStackDir) : null;
	const dataDirHostPath = viaDataRaw && viaDataRaw !== dockhandStackDir ? viaDataRaw : null;
	const mountHostPath = localDaemon && dockhandStackDir ? translateContainerPathViaMount(dockhandStackDir) : null;

	const resolution = resolveHostStackDir({
		composeFileName: composeFileName0,
		// remote_stacks_dir is the explicit, user-declared host location for a direct-remote env;
		// bindDerived can still be more exact when a bind pins the dir, so it's tried first inside
		// the resolver, then this. Null for socket/hawser/local.
		remoteStacksDirHostPath,
		bindDerivedHostPath: trustedBindDerived,
		dataDirHostPath,
		mountHostPath,
		workingDirLabel: trustedWorkingDirLabel,
	});
	if (resolution.kind === 'unknown') {
		// A direct-REMOTE env with NO remote_stacks_dir has nothing staged on the host, but
		// Dockhand HAS the stack's compose/config locally - capture it via a tar into the
		// snapshot instead of hard-failing. (Only compose/config; volume data rides its own
		// /volumes/<key>. Secrets are never on disk - carried as ciphertext in metadata.)
		if (directRemote && !remoteStacksDir && dockhandStackDir) {
			console.log(`[Backup] stackdir plan for "${targetName}": TAR (direct-remote, no remote_stacks_dir) - capturing compose/config from Dockhand's local copy in folder ${dockhandStackDir}`);
			return { kind: 'tar', localStackDir: dockhandStackDir, composeFileName: composeFileName0 ?? 'docker-compose.yml' };
		}
		// Report every candidate we tried so an UNKNOWN is diagnosable without SSH: which
		// inputs were null tells us WHY (e.g. workingDir null = 0 containers listed).
		console.log(`[Backup] stackdir plan for "${targetName}": UNKNOWN reason="${resolution.reason}" dockhandStackDir=${dockhandStackDir ?? 'none'} | connType=${envConnType} localDaemon=${localDaemon} remoteStacksDir=${remoteStacksDir ?? 'null'} containers=${stackContainers.length} bindDerived=${bindDerivedHostPath ?? 'null'} dataDir=${dataDirHostPath ?? 'null'} mount=${mountHostPath ?? 'null'} workingDirLabel=${workingDirLabel ?? 'null'}`);
		return { kind: 'unknown', reason: resolution.reason };
	}
	const hostPath = resolution.hostPath;
	const composeFileName = resolution.composeFile;
	console.log(`[Backup] stackdir plan for "${targetName}": host bind hostPath=${hostPath} composeFile=${composeFileName} source="${resolution.source}"`);

	// Compose bind DIRECTORIES inside the stack dir are captured separately as their own
	// /volumes/<key>, so exclude them from the whole-dir stackdir capture. We derive the dirs
	// by PARSING THE COMPOSE (Dockhand has it locally) - keyed on the compose-relative source,
	// the same namespace as the on-disk stack dir. isDirRel checks against Dockhand's own copy
	// of the stack dir (compose file's parent), which is a faithful mirror of the host layout.
	const isDirRel = (rel: string): boolean => {
		if (!dockhandStackDir) return false;
		try { return lstatSync(join(dockhandStackDir, rel)).isDirectory(); } catch { return false; }
	};
	const bindDirs = compose.content ? relativeBindDirsFromCompose(compose.content, dockhandStackDir ?? '', isDirRel) : [];
	const excludePaths = bindDirs.map((rel) => `/volumes/${STACKDIR_VOLUME_KEY}/${rel}`);
	if (excludePaths.length > 0) {
		console.log(`[Backup] stackdir "${targetName}": excluding ${excludePaths.length} compose bind dir(s) from the stackdir volume (captured separately as their own volumes): [${bindDirs.join(', ')}]`);
	}

	// User deselections from the "Stack files on the host" picker: exclude each named top-level
	// entry from the stackdir capture. LOAD-BEARING files (compose/.env) are re-guarded here on
	// the SERVER - a stale/tampered config can never drop them, regardless of the client.
	if (excludedStackFiles && excludedStackFiles.length > 0) {
		const { isLoadBearingStackFile } = await import('./stackfile-filter');
		const dropped: string[] = [];
		for (const name of excludedStackFiles) {
			// Only a plain top-level entry name (no path separators / traversal) is honored.
			if (!name || name.includes('/') || name === '.' || name === '..') continue;
			if (isLoadBearingStackFile(name)) continue; // never exclude compose/.env
			const p = `/volumes/${STACKDIR_VOLUME_KEY}/${name}`;
			if (!excludePaths.includes(p)) { excludePaths.push(p); dropped.push(name); }
		}
		if (dropped.length > 0) {
			console.log(`[Backup] stackdir "${targetName}": user deselected ${dropped.length} stack file(s) from the capture: [${dropped.join(', ')}]`);
		}
	}

	return {
		kind: 'candidate',
		syntheticVolume: {
			key: STACKDIR_VOLUME_KEY,
			bind: volumeBind(hostPath, STACKDIR_VOLUME_KEY, 'ro'),
			name: STACKDIR_VOLUME_KEY,
			type: 'bind',
			source: hostPath,
		},
		volumeKey: STACKDIR_VOLUME_KEY,
		composeFileName,
		excludePaths,
		bindSources,
	};
}

/**
 * UI preview of WHERE a stack's directory will be captured from on the host, WITHOUT running
 * a backup. Lets the create-schedule dialog show the resolved host path up front (and warn if
 * it's `unknown` before the user schedules a backup that would hard-fail). Thin wrapper over
 * planStackDirVolume - returns only the display-relevant fields (never the synthetic volume).
 */
export async function previewStackBackupPath(
	targetName: string,
	envId: number | null | undefined,
): Promise<{ kind: 'candidate'; hostPath: string; composeFile: string } | { kind: 'tar'; composeFile: string } | { kind: 'unknown'; reason: string }> {
	const plan = await planStackDirVolume(targetName, envId);
	if (plan.kind === 'unknown') return { kind: 'unknown', reason: plan.reason };
	// TAR mode (direct-remote, no remote_stacks_dir): the stack folder is captured from
	// Dockhand's own copy into the snapshot, not from a host path. Surface that to the UI so the
	// preview says "captured from Dockhand" rather than showing a misleading host path.
	if (plan.kind === 'tar') return { kind: 'tar', composeFile: plan.composeFileName };
	return { kind: 'candidate', hostPath: plan.syntheticVolume.source ?? '', composeFile: plan.composeFileName };
}

/**
 * Probe the TARGET host at backup-config creation time and list the ACTUAL contents of the stack
 * directory, so the UI can show the resolved HOST path and let the user pick what to back up.
 * The host path comes from the SAME resolver the backup uses (`planStackDirVolume` ->
 * `resolveHostStackDir`), so a helper container on the target daemon mounts read-only exactly
 * what a backup would capture - validating the path empirically (an unmountable/empty path
 * resolves to `unknown`, and the UI tells the user to set the env's stack path).
 * Never throws for an operational failure - every miss returns { kind:'unknown', reason }.
 */
export async function probeStackDir(
	targetName: string,
	envId: number | null | undefined,
): Promise<
	| { kind: 'listed'; hostPath: string; entries: import('./stackdir-plan').StackDirEntry[] }
	| { kind: 'tar'; localStackDir: string; entries: import('./stackdir-plan').StackDirEntry[] }
	| { kind: 'helper-failed'; reason: string }
	| { kind: 'unknown'; reason: string }
> {
	const { parseProbeListing, tagCapturedEntries, STACKDIR_VOLUME_KEY } = await import('./stackdir-plan');
	const { runContainerWithStreaming } = await import('../docker');
	const { ensureHelperImage } = await import('./restic');
	const { INSTANCE_LABEL } = await import('./reap-core');

	// Ask the real capture planner how this stack resolves. TAR mode (direct-remote, no
	// remote_stacks_dir) has no host folder to mount - the backup streams Dockhand's OWN local
	// copy (compose/config only; bind data lives on the remote host, out of reach). Surface THAT
	// to the picker so the user knows exactly what a backup would contain, instead of a bare
	// "unknown". A `candidate`/`unknown` plan falls through to the host-mount probe below.
	// attempts=1: config-time probe. The stack already exists (the user is editing its backup),
	// so a not-listable container is legitimately stopped/absent - the 15s just-deployed retry
	// would only hang the picker. (planStackDirVolume calls collectStackContainerHostInfo ONCE and
	// returns its bindSources, so the probe does NOT inspect the containers a second time.)
	const plan = await planStackDirVolume(targetName, envId, undefined, 1);
	if (plan.kind === 'tar') {
		const { readdirSync, statSync } = await import('fs');
		const { join } = await import('path');
		let entries: import('./stackdir-plan').StackDirEntry[] = [];
		try {
			entries = readdirSync(plan.localStackDir).map((name) => {
				let type: 'dir' | 'file' = 'file'; let size = 0;
				try { const st = statSync(join(plan.localStackDir, name)); type = st.isDirectory() ? 'dir' : 'file'; size = st.isFile() ? st.size : 0; } catch { /* keep defaults */ }
				return { name, type, size };
			}).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
		} catch { /* empty local copy -> empty list, still tar kind */ }
		return { kind: 'tar', localStackDir: plan.localStackDir, entries };
	}

	if (plan.kind === 'unknown') {
		return { kind: 'unknown', reason: plan.reason };
	}
	// plan.kind === 'candidate': the resolver already produced the TRUE host path (via bind-derive
	// / DATA_DIR->HOST_DATA_DIR translation / remote_stacks_dir / working_dir label, in priority).
	// Mount THAT - never the raw working_dir label, which for a socket env is Dockhand's CONTAINER
	// path (/app/data/...) and does not exist on the host (the resolver translates it).
	const hostPath = plan.syntheticVolume.source;
	if (!hostPath) {
		return { kind: 'unknown', reason: 'No stack folder could be located on the host. Set the environment\'s stack path and re-configure.' };
	}
	const bindSources = plan.bindSources;

	// Ensure the helper image is present on the target daemon (inspect-or-pull). If it CAN'T run
	// (image pull/run error) neither a backup nor a restore can happen on this env, so surface that
	// as a distinct `helper-failed` (the caller hard-fails) instead of folding it into `unknown`.
	let image: string;
	try {
		image = await ensureHelperImage(envId);
	} catch (e) {
		return { kind: 'helper-failed', reason: e instanceof Error ? e.message : String(e) };
	}
	try {
		// Portable listing: the helper is busybox, whose `find` has NO `-printf` (GNU-only). Loop
		// the top-level entries (incl. dotfiles) and emit `<type>\t<size>\t<name>` per line - the
		// same tab-delimited form parseProbeListing reads.
		const listScript =
			`cd /probe 2>/dev/null || exit 1; for f in * .*; do ` +
			`[ "$f" = "." ] || [ "$f" = ".." ] && continue; [ -e "$f" ] || continue; ` +
			`if [ -d "$f" ]; then t=d; else t=f; fi; s=$(stat -c %s "$f" 2>/dev/null || echo 0); ` +
			`printf '%s\\t%s\\t%s\\n' "$t" "$s" "$f"; done`;
		const stdout = await runContainerWithStreaming({
			image,
			cmd: ['sh', '-c', listScript],
			binds: [`${hostPath}:/probe:ro`],
			name: `dockhand-probe-${Date.now()}`,
			labels: { [INSTANCE_LABEL]: await getInstanceId() },
			envId,
			timeout: 60_000,
		});
		const entries = parseProbeListing(stdout);
		if (entries.length === 0) {
			return { kind: 'unknown', reason: `The stack folder at ${hostPath} is empty or does not exist on the Docker host. Set the environment's stack path and re-configure.` };
		}
		// Tag entries that are ALSO a bind mount so the picker shows them as non-deselectable
		// (captured via the Volumes section, not here). Two sources: daemon bind sources (runtime,
		// only for a RUNNING stack) AND the compose bind-dir names (always available) — the latter
		// so a stopped stack's `./memos` bind still shows as captured-by-bind, not a plain file.
		const bindDirNames = plan.excludePaths
			.map((p) => p.replace(`/volumes/${STACKDIR_VOLUME_KEY}/`, '').split('/')[0])
			.filter(Boolean);
		return { kind: 'listed', hostPath, entries: tagCapturedEntries(entries, hostPath, bindSources, bindDirNames) };
	} catch (e) {
		return { kind: 'unknown', reason: `Could not read the stack folder at ${hostPath} on the host: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/** The busybox list-script for a data-presence probe: print the missing sentinel if the mount
 * point does not exist, otherwise emit one `<type>\t<size>\t<name>` line per top-level entry. */
function probeListScript(missingSentinel: string): string {
	return (
		`if [ ! -e /probe ]; then printf '%s' '${missingSentinel}'; exit 0; fi; ` +
		`cd /probe 2>/dev/null || { printf '%s' '${missingSentinel}'; exit 0; }; ` +
		`for f in * .*; do ` +
		`[ "$f" = "." ] || [ "$f" = ".." ] && continue; [ -e "$f" ] || continue; ` +
		`if [ -d "$f" ]; then t=d; else t=f; fi; s=$(stat -c %s "$f" 2>/dev/null || echo 0); ` +
		`printf '%s\\t%s\\t%s\\n' "$t" "$s" "$f"; done`
	);
}

/**
 * Does an arbitrary host path have data on the TARGET daemon? Runs the same helper-container
 * mechanism as probeStackDir but for a caller-supplied path, and - unlike probeStackDir which
 * folds every failure into `unknown` - DISTINGUISHES a helper that could not run (`helper-failed`,
 * so callers can hard-fail up front) from a helper that ran and found the dir empty / missing /
 * populated. Used by the restore preview to warn before overwriting existing data.
 */
export async function probeHostPath(
	hostPath: string,
	envId: number | null | undefined,
): Promise<{ kind: import('./stackdir-plan').ProbeDataKind; reason?: string }> {
	const { classifyProbeListing, PROBE_MISSING_SENTINEL } = await import('./stackdir-plan');
	const { runContainerWithStreaming } = await import('../docker');
	const { ensureHelperImage } = await import('./restic');
	const { INSTANCE_LABEL } = await import('./reap-core');
	let image: string;
	try {
		image = await ensureHelperImage(envId);
	} catch (e) {
		return { kind: 'helper-failed', reason: e instanceof Error ? e.message : String(e) };
	}
	try {
		const stdout = await runContainerWithStreaming({
			image,
			cmd: ['sh', '-c', probeListScript(PROBE_MISSING_SENTINEL)],
			binds: [`${hostPath}:/probe:ro`],
			name: `dockhand-probe-${Date.now()}`,
			labels: { [INSTANCE_LABEL]: await getInstanceId() },
			envId,
			timeout: 60_000,
		});
		return { kind: classifyProbeListing(stdout) };
	} catch (e) {
		return { kind: 'helper-failed', reason: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Does a NAMED volume exist and hold data on the TARGET daemon? A named volume has no host path to
 * bind, so this inspects it (missing -> `missing`) then mounts it by name into the helper and lists
 * it. Same helper-failed distinction as probeHostPath.
 */
export async function probeVolumeData(
	volumeName: string,
	envId: number | null | undefined,
): Promise<{ kind: import('./stackdir-plan').ProbeDataKind; reason?: string }> {
	const { classifyProbeListing, PROBE_MISSING_SENTINEL } = await import('./stackdir-plan');
	const { runContainerWithStreaming, inspectVolume } = await import('../docker');
	const { ensureHelperImage } = await import('./restic');
	const { INSTANCE_LABEL } = await import('./reap-core');
	try {
		await inspectVolume(volumeName, envId);
	} catch {
		return { kind: 'missing' };
	}
	let image: string;
	try {
		image = await ensureHelperImage(envId);
	} catch (e) {
		return { kind: 'helper-failed', reason: e instanceof Error ? e.message : String(e) };
	}
	try {
		const stdout = await runContainerWithStreaming({
			image,
			cmd: ['sh', '-c', probeListScript(PROBE_MISSING_SENTINEL)],
			binds: [`${volumeName}:/probe:ro`],
			name: `dockhand-probe-${Date.now()}`,
			labels: { [INSTANCE_LABEL]: await getInstanceId() },
			envId,
			timeout: 60_000,
		});
		// A just-inspected volume exists, so an empty listing means empty, never missing.
		const k = classifyProbeListing(stdout);
		return { kind: k === 'missing' ? 'empty' : k };
	} catch (e) {
		return { kind: 'helper-failed', reason: e instanceof Error ? e.message : String(e) };
	}
}

// =============================================================================
// Metadata collector — reads restore context into base64 files for the snapshot
// =============================================================================
async function collectMetadata(
	type: BackupTargetType,
	targetName: string,
	envId: number | null | undefined,
	volumes: DiscoveredVolume[],
	stackDirTar?: { localStackDir: string; composeFileName: string } | null,
): Promise<{ files: MetadataFile[]; stackDirStreamSources?: Array<{ diskPath: string; archivePath: string }> }> {
	const files: MetadataFile[] = [];
	// tar-mode ONLY: disk paths of the stack dir files to stream into the helper (no base64, no
	// cap). Filled in the stack block below when stackDirTar is set; empty otherwise.
	const stackDirStreamSources: Array<{ diskPath: string; archivePath: string }> = [];
	// Writes metadata.json plus, for a stack, a light file listing (path + size, no content)
	// of the stack dir. The stack dir's bytes are captured by the helper's HOST bind mount
	// (the synthetic __dockhand_stackdir__ volume from planStackDirVolume), not here.
	//
	// metadata.json is the typed SnapshotLayout (snapshot-layout.ts): capture builds it,
	// restore parses it, drift = compile error. Accumulate the stack half + secrets +
	// container inspect into locals, then buildSnapshotLayout via writeLayout(). `source`
	// carries each volume's ORIGINAL location (bind -> absolute host path, not the slug) so
	// an in-place bind restore can rebind it.
	const layoutVolumes = volumes.map((v) => ({ key: v.key, name: v.name, source: v.source, type: v.type }));
	const backupTime = new Date().toISOString();

	// Capture each target container's config for reference (recreate-as-is).
	let containerInspect: unknown;
	if (type === 'container') {
		try {
			const [c] = (await resolveTargets(type, targetName, envId)).containers;
			if (c) containerInspect = await inspectContainer(c.id, envId ?? undefined);
		} catch { /* metadata best-effort; the volume data is what matters */ }
	}

	// The single metadata.json writer. Called now (so the file is files[0], present even if
	// the stack walk below fails) and again at the end once the stack half is filled in.
	let stackInfo: SnapshotStack | undefined;
	let stackSecrets: SnapshotSecret[] = [];
	const writeLayout = () => {
		const layout = buildSnapshotLayout({
			type, targetName, environmentId: envId ?? null, backupTime,
			volumes: layoutVolumes,
			container: containerInspect,
			stack: stackInfo ? { ...stackInfo, secrets: stackSecrets } : undefined,
		});
		const entry = { path: 'metadata/metadata.json', contentBase64: Buffer.from(serializeLayout(layout)).toString('base64') };
		if (files.length === 0) files.push(entry); else files[0] = entry;
	};
	writeLayout();

	// For a stack, record its stack half in metadata (composeFileName, file listing,
	// secrets). The whole stack directory's bytes - compose, .env, and sibling config
	// (nginx.conf, html/, certs, ...) - are captured by the helper's host bind mount at
	// /volumes/__dockhand_stackdir__, not here; this block only writes the metadata.
	if (type === 'stack') {
		const { getStackComposeFile } = await import('../stacks');
		const { readFileSync, readdirSync, lstatSync, statSync } = await import('fs');
		const { dirname, join, relative, basename, sep } = await import('path');
		const compose = await getStackComposeFile(targetName, envId ?? undefined);
		if (compose.success && compose.composePath) {
			// Presence of `stackInfo` IS hasStackFiles (derived, not a stored flag that could
			// disagree with reality). composeFileName is the ORIGINAL name (immich.yaml /
			// docker-compose.yml) so restore redeploys from the real file, reproducing the dir
			// 1:1. fileList/excludedBindDirs are filled by the LIGHT listing walk below.
			stackInfo = {
				composeFileName: basename(compose.composePath),
				fileList: [],
				excludedBindDirs: [],
				secrets: [],
			};

			// List the stack dir's files (path + size) for the browse/restore UI. The bytes
			// themselves ride the helper's host bind mount at /volumes/__dockhand_stackdir__;
			// this walk over Dockhand's local mirror only records the listing (lstat, no content
			// read), skipping compose bind dirs that are captured as their own /volumes/<key>.
			const { STACKDIR_VOLUME_KEY } = await import('./stackdir-plan');
			{
				try {
					const { relativeBindDirsFromCompose, isUnderRelDir, isLoadBearingStackFile } = await import('./stackfile-filter');
					const stackDir = dirname(compose.composePath);
					const isDirRel = (rel: string): boolean => { try { return lstatSync(join(stackDir, rel)).isDirectory(); } catch { return false; } };
					const excludeRelDirs = compose.content ? relativeBindDirsFromCompose(compose.content, stackDir, isDirRel) : [];
					const listed: Array<{ path: string; bytes: number }> = [];
					const walkList = (dir: string) => {
						let names: string[];
						try { names = readdirSync(dir); } catch { return; }
						for (const entry of names) {
							if (listed.length >= 5000) return;   // runaway guard
							const abs = join(dir, entry);
							const relPath = relative(stackDir, abs);
							if (excludeRelDirs.length > 0 && !isLoadBearingStackFile(relPath) && isUnderRelDir(relPath, excludeRelDirs)) continue;
							let st;
							try { st = lstatSync(abs); } catch { continue; }
							if (st.isSymbolicLink()) { if (isLoadBearingStackFile(relPath)) { try { const r = statSync(abs); if (r.isFile()) listed.push({ path: relPath, bytes: r.size }); } catch { /* skip */ } } continue; }
							if (st.isDirectory()) { walkList(abs); continue; }
							if (st.isFile()) listed.push({ path: relPath, bytes: st.size });
						}
					};
					walkList(stackDir);
					listed.sort((a, b) => a.path.localeCompare(b.path));
					if (stackInfo) { stackInfo.fileList = listed; stackInfo.excludedBindDirs = excludeRelDirs; }

					if (stackDirTar) {
						// TAR mode (direct-remote, no remote_stacks_dir): no host bind exists, so the
						// listed files are STREAMED from disk into the helper at
						// /volumes/__dockhand_stackdir__/<rel> (O(1) RAM, no cap; restore reads the same
						// path via stackDirSource). Bind data dirs are excluded (same as listed) - their
						// runtime bytes live on the target host, out of reach; compose/config only.
						for (const { path: rel } of listed) {
							stackDirStreamSources.push({
								diskPath: join(stackDir, rel),
								archivePath: `volumes/${STACKDIR_VOLUME_KEY}/${rel.split(sep).join('/')}`,
							});
						}
						console.log(`[Backup] stackfiles "${targetName}": TAR mode - streaming ${stackDirStreamSources.length} file(s) into /volumes/${STACKDIR_VOLUME_KEY} from folder ${stackDir}`);
					} else {
						console.log(`[Backup] stackfiles "${targetName}": captured via HOST bind mount at /volumes/${STACKDIR_VOLUME_KEY} - listed ${listed.length} file(s), ${excludeRelDirs.length} bind dir(s) excluded`);
					}
				} catch (e) {
					console.warn(`[Backup] stackfiles "${targetName}": listing failed (files still captured via bind):`, e instanceof Error ? e.message : e);
				}
			}
			// Carry the stack's secret env vars IN the snapshot so a restore reproduces a
			// WORKING stack — secrets and all — even after the source stack (and its DB
			// rows) are gone. Stored as their at-rest ciphertext (enc:v1:...), encrypted
			// under THIS instance's key: a restore on the same instance decrypts them
			// transparently; on a fresh instance the operator must carry over the same
			// encryption key (.encryption_key / ENCRYPTION_KEY) or they stay unreadable.
			// Values are NEVER stored plaintext (getStackSecretCiphertexts guarantees it).
			try {
				const { getStackSecretCiphertexts } = await import('../db');
				stackSecrets = await getStackSecretCiphertexts(targetName, envId ?? null);
			} catch { /* best-effort — a lookup failure just omits secrets from the snapshot */ }
			// Rewrite metadata.json now the stack half (files, excludes, secrets) is filled in.
			writeLayout();
		}
	}

	return { files, stackDirStreamSources: stackDirStreamSources.length > 0 ? stackDirStreamSources : undefined };
}

// A restic helper runner bound to one destination (so no shared mutable state —
// each run closes over its own destination). Used by both port factories.
function boundRunner(destination: any) {
	return {
		// Spread the spec through unchanged (adding only the timeout tier) - do NOT re-list
		// fields by hand, or a spec field silently gets dropped here while the caller still
		// passes it.
		runInHelper: (spec: HelperRunSpec): Promise<ResticRun> =>
			restic.runInHelper(destination, { ...spec, timeout: 'data' }),
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
		planStackDirVolume: (targetName, envId, excludedStackFiles) => planStackDirVolume(targetName, envId, excludedStackFiles),
		stopForBackup: (type, targetName, containers, envId) => stopForBackup(type, targetName, containers, envId),
		runInHelper: (spec) => run.runInHelper(spec),
		runLocal: (args, tier) => run.runLocal(args, tier),
		collectMetadata,
		host: () => getHostname(),
		instanceId: () => getInstanceId(),
		acquireLiveTarget: (key) => liveLocks.tryAcquire(key),
		isCancelling: (configId) => cancellingBackupConfigs.has(configId),
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
/**
 * Extract a snapshot's captured stack files (/volumes/__dockhand_stackdir__) into
 * `targetPath` under the stacks root, with a path-traversal guard, a data-loss guard
 * (an empty extraction never wipes the live dir), and an atomic staging-swap so a
 * mid-copy failure can't leave the dir half-written. Returns false (no-op) when the
 * snapshot has no stackfiles. Shared by the writeLocalStackFiles port and the restore
 * redeploy path (which materialises into the CANONICAL stack dir). `destination` is
 * already resolved by the caller.
 */
async function materialiseStackFiles(destination: any, snapId: string, stackName: string, targetPath: string, overwrite: boolean): Promise<boolean> {
	const { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync, readdirSync, renameSync } = await import('fs');
	const { tmpdir } = await import('os');
	const { join, dirname, resolve, sep } = await import('path');
	const { randomUUID } = await import('crypto');
	const { getStacksDir } = await import('../stacks');
	const { stackDirSource } = await import('./stackdir-plan');
	// The stack dir is ALWAYS at /volumes/__dockhand_stackdir__ in the snapshot (local bind
	// and remote tar both write there), so restore reads ONE deterministic path via
	// `restic restore --include` regardless of how the backup captured it.
	const { include, extractSub } = stackDirSource();
	// The AUTHORITATIVE compose filename recorded at capture (immich.yaml, etc.). Restore
	// must locate the extracted compose by THIS name, not re-guess it by regex - a wrong
	// guess yields wrong bind dirs and the overwrite swap then deletes just-restored volume
	// data. Best-effort read; older snapshots without it fall back
	// to the regex heuristic below.
	let recordedComposeName: string | null = null;
	try { recordedComposeName = (await getSnapshotMetadata(destination.id, snapId))?.stack?.composeFileName ?? null; }
	catch { /* fall back to regex if metadata is unreadable */ }
	const tmp = mkdtempSync(join(tmpdir(), 'dh-stackfiles-'));
	console.log(`[Backup] materialiseStackFiles: "${stackName}" snapshot=${snapId} include=${include} compose=${recordedComposeName ?? '(regex fallback)'} -> extract to ${tmp}, then swap into ${targetPath} (overwrite=${overwrite})`);
	try {
		const run = await restic.runLocal(destination, ['restore', snapId, '--target', tmp, '--include', include], 'data');
		if (run.exitCode !== 0) {
			console.log(`[Backup] materialiseStackFiles: restic restore failed for "${stackName}": ${run.stderr.trim() || `exit ${run.exitCode}`}`);
			return false;
		}
		const extractedDir = join(tmp, ...extractSub.split('/'));
		// DATA-LOSS guard: only proceed if extraction actually produced files.
		const extracted = existsSync(extractedDir) ? readdirSync(extractedDir) : [];
		if (extracted.length === 0) {
			console.log(`[Backup] materialiseStackFiles: no stackfiles extracted for "${stackName}" (snapshot may predate full-dir capture) — leaving ${targetPath} untouched`);
			return false;
		}

		// Path-traversal guard: the resolved target MUST stay under the stacks root.
		const resolvedTarget = resolve(targetPath);
		const stacksRoot = resolve(getStacksDir());
		if (resolvedTarget !== stacksRoot && !resolvedTarget.startsWith(stacksRoot + sep)) {
			console.log(`[Backup] materialiseStackFiles: refusing target "${resolvedTarget}" outside the stacks root "${stacksRoot}"`);
			return false;
		}

		mkdirSync(resolvedTarget, { recursive: true });

		// Atomic staging-swap: build the desired contents in a sibling staging dir
		// FIRST, then swap it into place with a same-parent rename. On OVERWRITE the
		// staging holds ONLY the restored files; on merge it starts as a copy of live.
		const parent = dirname(resolvedTarget);
		const staging = mkdtempSync(join(parent, '.dockhand-stack-new-'));
		const oldAside = join(parent, `.dockhand-stack-old-${randomUUID()}`);
		try {
			if (!overwrite) {
				for (const existing of readdirSync(resolvedTarget)) {
					cpSync(join(resolvedTarget, existing), join(staging, existing), { recursive: true, force: true });
				}
			} else {
				// OVERWRITE (in-place restore): the stackdir capture EXCLUDES compose bind dirs
				// (./data, ./config) — they ride their own /volumes/<key> and the volume swap
				// (which ran BEFORE this) already restored them into the live stack dir. So the
				// whole-dir replace must PRESERVE those live bind dirs, or it would delete the
				// data the volume swap just restored. Parse the EXTRACTED compose for bind dirs
				// and carry the matching live subdirs into staging.
				try {
					const { relativeBindDirsFromCompose } = await import('./stackfile-filter');
					const { readFileSync, lstatSync } = await import('fs');
					// Locate the compose by its RECORDED name (authoritative); only fall back to
					// the regex heuristic for older snapshots that didn't store composeFileName.
					const composeFile = (recordedComposeName && extracted.includes(recordedComposeName))
						? recordedComposeName
						: (extracted.find((e) => /^(docker-)?compose\.ya?ml$/i.test(e)) ?? extracted.find((e) => /\.ya?ml$/i.test(e)));
					const composeText = composeFile ? readFileSync(join(extractedDir, composeFile), 'utf8') : '';
					const isDirRelLive = (rel: string): boolean => { try { return lstatSync(join(resolvedTarget, rel)).isDirectory(); } catch { return false; } };
					const bindDirs = composeText ? relativeBindDirsFromCompose(composeText, resolvedTarget, isDirRelLive) : [];
					for (const rel of bindDirs) {
						const liveBind = join(resolvedTarget, rel);
						if (existsSync(liveBind)) {
							mkdirSync(dirname(join(staging, rel)), { recursive: true });
							cpSync(liveBind, join(staging, rel), { recursive: true, force: true });
						}
					}
					if (bindDirs.length > 0) console.log(`[Backup] materialiseStackFiles: preserved ${bindDirs.length} bind dir(s) across the stackdir swap: [${bindDirs.join(', ')}]`);
				} catch (e) { console.warn(`[Backup] materialiseStackFiles: bind-dir preservation skipped:`, e instanceof Error ? e.message : e); }
			}
			for (const entry of extracted) {
				cpSync(join(extractedDir, entry), join(staging, entry), { recursive: true, force: true });
			}
			renameSync(resolvedTarget, oldAside);
			try {
				renameSync(staging, resolvedTarget);
			} catch (swapErr) {
				try { renameSync(oldAside, resolvedTarget); } catch { /* best effort */ }
				throw swapErr;
			}
			rmSync(oldAside, { recursive: true, force: true });
			console.log(`[Backup] materialiseStackFiles: wrote ${extracted.length} entries to ${resolvedTarget} (${overwrite ? 'replaced' : 'merged'})`);
			return true;
		} catch (copyErr) {
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
}

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
		resolveVolumeBind: async (metadata, _envId, volumeName) => {
			// Resolve the volume's ORIGINAL live location through the SAME resolver the restore
			// dialog uses, from the metadata the caller ALREADY read (no second dump). For a bind
			// this recovers the absolute host path; an unrecoverable bind is surfaced as
			// `unresolved` -> we re-throw rather than slug-bind into an orphan named volume (data loss).
			const { resolveRestoreTargets } = await import('./restore-targets');
			const resolved = resolveRestoreTargets({ job: { mode: 'in-place' }, volumes: [volumeName], metadata: metadata as any, stackDir: null });
			const t = resolved.volumes[0];
			// Unresolved (bind source unrecoverable): resolveRestoreTargets caught the throw into
			// `unresolved`; re-run the leaf directly to surface the SAME BackupError to the swap.
			if (!t) return resolveBindFromMetadata(metadata as any, volumeName);
			return { bind: t.bind, include: t.include, source: t.target, type: t.type };
		},
		resolveCloneTargets: async (job, volumes) => {
			// Same resolver as the dialog preview - clone destinations resolve to the exact bind
			// strings shown to the user. The caller does the volume-creation side effects.
			const { resolveRestoreTargets } = await import('./restore-targets');
			const resolved = resolveRestoreTargets({ job, volumes, metadata: null, stackDir: null });
			return resolved.volumes.map((t) => ({ key: t.key, type: t.type, target: t.target, include: t.include, bind: t.bind }));
		},
		acquireLiveTarget: (key) => liveLocks.tryAcquire(key),
		serializeDestination: (id, fn) => serializeByRepo(id, fn),
		openOperation: (entityName, environmentId, triggeredBy, cb) =>
			makeOperationHandle('restore', entityName, 0, environmentId, triggeredBy === 'cron' ? 'cron' : 'manual', cb ?? onProgress),
		notify: (event, payload, envId) => notify(event, payload, envId),
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
		// the stack dir 1:1: materialise the captured stack dir (/volumes/__dockhand_stackdir__)
		// and run `docker compose up -d` against the ORIGINAL compose filename — so include:,
		// override files, and sibling configs referenced by relative paths resolve, and the
		// file keeps its real name (e.g. immich.yaml). The backup always captures the full dir
		// plus the recorded compose filename, so there is no normalized-compose.yaml fallback.
		redeployStack: async (name, envId, destId, snapId, restoreSecrets) => {
			const { redeployStackFromDir, getStackDir } = await import('../stacks');
			const { existsSync } = await import('fs');
			const { join } = await import('path');
			const { upsertStackSource } = await import('../db');
			const { runRedeployStack } = await import('./redeploy-stack-core');

			const log = (msg: string) => console.log(`[Restore:redeploy ${name}] ${msg}`);
			log(`start: env=${envId ?? 'local'} destination=${destId} snapshot=${snapId}`);

			const meta = await getSnapshotMetadata(destId, snapId);
			const composeFileName = meta?.stack?.composeFileName ?? '';
			if (!composeFileName) {
				throw new Error('snapshot has no recorded compose filename; cannot redeploy this stack');
			}

			const stackDir = await getStackDir(name, envId ?? undefined);
			const destination = await loadDest(destId);
			const composePath = join(stackDir, composeFileName);

			// Order matters: materialise -> register(internal) -> deploy. Registration happens
			// BEFORE the deploy so a failed `docker compose up` still leaves an editable managed
			// stack. See redeploy-stack-core.ts for the invariant + the reasoning.
			await runRedeployStack({
				log,
				// Restore the stack's secrets FROM THE SNAPSHOT (opt-in, default on). Stored as
				// at-rest ciphertext under this instance's key; writing them into the TARGET
				// env's DB before redeploy lets redeployStackFromDir's normal secret injection
				// pick them up. setStackEnvVars re-runs encrypt(), a pass-through for an already-
				// encrypted value (no double-encryption). On a different instance without the key
				// these won't decrypt - the restore UI warns about that.
				restoreSecrets: async () => {
					const snapSecrets = meta?.stack?.secrets ?? [];
					if (restoreSecrets && snapSecrets.length > 0) {
						const { setStackEnvVars } = await import('../db');
						const secrets = snapSecrets.map((s) => ({ key: s.key, value: s.value, isSecret: true }));
						await setStackEnvVars(name, envId ?? null, secrets);
						log(`restored ${secrets.length} secret(s) from snapshot → env ${envId ?? 'local'}`);
					}
				},
				// Materialise into the CANONICAL stack dir (stacks/<envName>/<stackName>/) so the
				// restored stack is a normal managed stack on disk, not a throwaway /tmp copy
				// (#1329). Carries the path-traversal + data-loss + atomic-swap guards;
				// overwrite=true because an in-place restore is destructive by design.
				materialise: async () => {
					log(`materialising snapshot stackfiles → canonical dir: ${stackDir} (compose: ${composeFileName})`);
					const wrote = await materialiseStackFiles(destination, snapId, name, stackDir, true);
					return wrote && existsSync(composePath);
				},
				register: async () => {
					const envPath = existsSync(join(stackDir, '.env')) ? join(stackDir, '.env') : null;
					await upsertStackSource({ stackName: name, environmentId: envId ?? null, sourceType: 'internal', composePath, envPath });
					log(`registered: composePath=${composePath} envPath=${envPath ?? '(none)'}`);
				},
				deploy: async () => {
					const r = await redeployStackFromDir(name, stackDir, composeFileName, envId ?? undefined);
					if (!r.success) throw new Error(r.error || 'docker compose up failed');
				}
			});
		},
		readSnapshotMetadata: (destId, snapId) => getSnapshotMetadata(destId, snapId),
		// Materialise the snapshot's captured stack files into Dockhand's LOCAL data
		// dir (targetPath) so Dockhand can manage/redeploy the restored stack. The stack
		// dir is always at /volumes/__dockhand_stackdir__ in the snapshot; materialise
		// reads it from there and swaps it into targetPath.
		writeLocalStackFiles: async (destId, snapId, stackName, targetPath, overwrite, envId) => {
			const destination = await loadDest(destId);
			const wrote = await materialiseStackFiles(destination, snapId, stackName, targetPath, overwrite);
			// Register the materialised stack as managed (internal) so the UI can EDIT and
			// redeploy it. Without this the restored stack is EXTERNAL - compose sits on disk
			// but the UI offers only start/stop/remove, so "update the compose file... then
			// redeploy" is impossible. Only when we know the canonical dir + compose name.
			if (wrote && envId !== undefined) {
				try {
					const { join } = await import('path');
					const { existsSync } = await import('fs');
					const { upsertStackSource } = await import('../db');
					const composeFileName = (await getSnapshotMetadata(destId, snapId))?.stack?.composeFileName;
					if (composeFileName && existsSync(join(targetPath, composeFileName))) {
						const envPath = existsSync(join(targetPath, '.env')) ? join(targetPath, '.env') : null;
						await upsertStackSource({ stackName, environmentId: envId ?? null, sourceType: 'internal', composePath: join(targetPath, composeFileName), envPath });
					}
				} catch (e) {
					console.log(`[Restore] register-managed failed for "${stackName}": ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			return wrote;
		},
		stackDirFor: async (stackName, envId) => {
			const { getStackDir } = await import('../stacks');
			return getStackDir(stackName, envId ?? undefined);
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
	return {
		runLocal: (dest: any, args: string[], tier?: 'interactive' | 'data', stream?: { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void }) =>
			restic.runLocal(dest, args, tier, stream)
	};
}

/** List the volume names present in a snapshot (from `restic ls /volumes/`). The reserved
 * __dockhand_stackdir__ key (the stack dir captured as a volume) is filtered OUT here — it
 * is NOT a user data volume, so it must never reach the restore volume picker, "restore
 * all", or the in-place swap. The stack dir is restored only via the redeploy path. */
async function listSnapshotVolumes(destination: any, snapshotId: string): Promise<string[]> {
	const { isReservedVolumeKey } = await import('./stackdir-plan');
	const run = await restic.runLocal(destination, ['ls', '--json', '--no-lock', snapshotId, '/volumes/']);
	// A FAILED `ls` (timeout / killed / slow remote backend) is NOT "the snapshot has no
	// volumes" - returning [] there makes restore report a MISLEADING "not found in snapshot,
	// Available: none" for a snapshot that actually holds data. Fail loud with the real reason.
	if (run.exitCode !== 0) {
		throw new BackupError('RESTIC', `could not list the snapshot's volumes: ${run.stderr.trim() || 'restic ls failed'}`, { exitCode: run.exitCode });
	}
	const names = new Set<string>();
	for (const line of run.stdout.split('\n')) {
		try {
			const e = JSON.parse(line.trim());
			// Accept EITHER node discriminator: message_type (current restic) or struct_type
			// (deprecated) - a restic bump that drops the old field must not silently return [].
			if ((e?.message_type === 'node' || e?.struct_type === 'node') && typeof e.path === 'string' && e.path.startsWith('/volumes/')) {
				const parts = e.path.split('/');
				if (parts.length >= 3 && parts[2] && !isReservedVolumeKey(parts[2])) names.add(parts[2]);
			}
		} catch { /* skip non-JSON */ }
	}
	return [...names];
}

async function notify(event: string, payload: Record<string, unknown>, envId: number | null | undefined): Promise<void> {
	try { await sendEventNotification(event as any, payload as any, envId ?? undefined); } catch { /* never changes the outcome */ }
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
): Promise<{ snapshotId: string; volumes: string[]; volumeTypes: Record<string, 'volume' | 'bind'>; volumeSources: Record<string, string>; backupTime: string | null; sourceEnvironmentId: number | null; hasMetadata: boolean; hasStackFiles: boolean; sourceSecretKeys: string[] }> {
	const destination = await getBackupDestination(destinationId);
	if (!destination) throw new Error('backup destination not found');
	const instanceId = await getInstanceId();
	await guardSnapshotAccess(reader(), destination, instanceId, snapshotId, access);
	const volumes = await listSnapshotVolumes(destination, snapshotId);
	// Cheap metadata presence check (ls the /metadata dir, depth-1).
	const meta = await restic.runLocal(destination, ['ls', '--json', '--no-lock', snapshotId, '/metadata']);
	const hasMetadata = meta.exitCode === 0 && meta.stdout.includes('/metadata/metadata.json');
	// Per-volume type (volume|bind) for the restore UI's icons, and the ORIGINAL source per
	// volume (named volume -> its name; bind -> its absolute host path) so the clone UI can
	// pre-fill a 1:1 destination. hasStackFiles is DERIVED from the typed layout (stack !=
	// undefined), not a stored flag. sourceSecretKeys is NAMES only (values stay ciphertext).
	const volumeTypes: Record<string, 'volume' | 'bind'> = {};
	const volumeSources: Record<string, string> = {};
	let hasStackFiles = false;
	let backupTime: string | null = null;
	let sourceEnvironmentId: number | null = null;
	let sourceSecretKeys: string[] = [];
	let mdType: string | null = null;
	let mdTargetName: string | null = null;
	if (hasMetadata) {
		const dump = await restic.runLocal(destination, ['dump', '--no-lock', snapshotId, '/metadata/metadata.json']);
		const layout = dump.exitCode === 0 ? parseSnapshotLayout(dump.stdout) : null;
		if (layout) {
			backupTime = layout.backupTime || null;
			sourceEnvironmentId = layout.environmentId;
			mdType = layout.type;
			mdTargetName = layout.targetName;
			hasStackFiles = layout.stack !== undefined;
			sourceSecretKeys = (layout.stack?.secrets ?? []).map((s) => s.key);
			for (const v of layout.volumes) {
				// Key by v.key — the /volumes/<key> segment listSnapshotVolumes returns and the
				// restore UI indexes on. For a bind key !== name (name is the host source).
				volumeTypes[v.key] = v.type;
				if (v.source) volumeSources[v.key] = v.source;
			}
		}
	}
	return { snapshotId, volumes, volumeTypes, volumeSources, backupTime, sourceEnvironmentId, hasMetadata, hasStackFiles, sourceSecretKeys };
}

/** Per-target resolved destination + whether the host already holds data there. */
export interface RestoreTargetPreview {
	volumes: Array<{ key: string; type: 'bind' | 'volume'; target: string; origin: string; hasData: import('./stackdir-plan').ProbeDataKind }>;
	stackFiles: { targetDir: string; willWrite: boolean; hasData: import('./stackdir-plan').ProbeDataKind } | null;
	unresolved: Array<{ key: string; reason: string }>;
	helperOk: boolean;
	helperError?: string;
}

/**
 * Resolve the EXACT on-disk targets a restore would write (via the shared resolveRestoreTargets -
 * the same computation the real restore uses) and probe each one on the TARGET host to report
 * whether it already holds data. Only host paths / volume names cross the boundary here - never
 * Config.Env or secrets - so no metadata redaction is needed. `helperOk:false` means the probe
 * container can't run at all (image pull/run failed); callers hard-fail because a restore can't
 * succeed either.
 */
export async function previewRestoreTargets(
	destinationId: number,
	snapshotId: string,
	jobLike: {
		mode: 'in-place' | 'new-location';
		environmentId: number | null;
		targetType?: 'container' | 'stack';
		targetName?: string | null;
		targetPath?: string | null;
		volumeDestinations?: Array<{ volume: string; kind: 'volume' | 'path'; target: string }>;
		skipStackFiles?: boolean;
		mergeStackFiles?: boolean;
		volumes?: string[];
	},
	access: { isEnterprise: boolean; canAccessEnvironment: (id: number) => Promise<boolean> } = { isEnterprise: false, canAccessEnvironment: async () => true },
): Promise<RestoreTargetPreview> {
	const { resolveRestoreTargets } = await import('./restore-targets');
	const destination = await getBackupDestination(destinationId);
	if (!destination) throw new Error('backup destination not found');
	const instanceId = await getInstanceId();
	await guardSnapshotAccess(reader(), destination, instanceId, snapshotId, access);

	const envId = jobLike.environmentId;
	const metadata = await getSnapshotMetadata(destinationId, snapshotId);
	const allVolumes = await listSnapshotVolumes(destination, snapshotId);
	const requested = jobLike.volumes && jobLike.volumes.length > 0 ? jobLike.volumes : allVolumes;
	const stackDir = jobLike.targetType === 'stack' && jobLike.targetName
		? await (async () => { const { getStackDir } = await import('../stacks'); return getStackDir(jobLike.targetName!, envId ?? undefined); })()
		: null;

	const resolved = resolveRestoreTargets({ job: jobLike, volumes: requested, metadata: metadata as any, stackDir });

	// Probe each resolved target on the target host. A helper-failed on ANY probe flips helperOk
	// off (the helper is per-env; if it can't run once it won't run for the rest).
	// Probe every target in PARALLEL - the probes are independent, read-only helper runs, and
	// ensureHelperImage is memoized per env so the burst does one inspect not N. Serial per-volume
	// spawns were the dominant latency (the sticky modal), especially on hawser where each spawn
	// crosses the WS transport.
	const volProbes = await Promise.all(resolved.volumes.map(async (v) => ({
		v, probe: v.type === 'volume' ? await probeVolumeData(v.target, envId) : await probeHostPath(v.target, envId),
	})));
	const stackProbe = resolved.stackFiles
		? (resolved.stackFiles.willWrite ? await probeHostPath(resolved.stackFiles.targetDir, envId) : { kind: 'empty' as const })
		: null;

	// Collect helperOk AFTER all probes: a helper-failed on ANY probe flips it off.
	let helperOk = true;
	let helperError: string | undefined;
	const noteHelper = (r: { kind: import('./stackdir-plan').ProbeDataKind; reason?: string }) => {
		if (r.kind === 'helper-failed') { helperOk = false; if (!helperError) helperError = r.reason; }
		return r.kind;
	};

	const volumes: RestoreTargetPreview['volumes'] = volProbes.map(({ v, probe }) => ({
		key: v.key, type: v.type, target: v.target, origin: v.origin, hasData: noteHelper(probe),
	}));
	const stackFiles: RestoreTargetPreview['stackFiles'] = resolved.stackFiles
		? { targetDir: resolved.stackFiles.targetDir, willWrite: resolved.stackFiles.willWrite, hasData: noteHelper(stackProbe!) }
		: null;

	return { volumes, stackFiles, unresolved: resolved.unresolved, helperOk, helperError };
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
export async function getSnapshotMetadata(destinationId: number, snapshotId: string): Promise<SnapshotLayout | null> {
	const destination = await loadDest(destinationId);
	const instanceId = await getInstanceId();
	await guardSnapshotAccess(reader(), destination, instanceId, snapshotId, { isEnterprise: false, canAccessEnvironment: async () => true });
	const run = await restic.runLocal(destination, ['dump', '--no-lock', snapshotId, '/metadata/metadata.json']);
	if (run.exitCode !== 0) return null;
	// parseSnapshotLayout returns null on bad JSON / wrong version / bad shape - an explicit
	// "unreadable metadata" outcome, not a cascade of undefineds. Callers read TYPED fields.
	const layout = parseSnapshotLayout(run.stdout);
	if (!layout) console.warn(`[Backup] snapshot ${snapshotId.slice(0, 8)}: metadata.json present but unreadable (bad shape/version)`);
	return layout;
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
	const r = await checkRepository(reader(), destination, opts?.dataSubset ?? '5%', opts?.onProgress);
	logRepoOp(destination.name, `verify (${opts?.dataSubset ?? '5%'})`, r.ok, r.ok ? { output: r.output } : { error: r.error });
	return r.ok ? { success: true, output: r.output } : { success: false, error: r.error };
}

/** A repo-maintenance task. `repair-index`/`repair-snapshots` map to restic
 * `repair index` / `repair snapshots`. */
export type RepoTask = 'unlock' | 'check' | 'prune' | 'stats' | 'repair-index' | 'repair-snapshots';

/** Run a repo-maintenance task. Returns { success } for the route + activity log. */
export interface RepoStats { totalSize: number; totalFiles: number; snapshots: number }

export async function runRepoTask(destinationId: number, task: RepoTask, opts?: { maxUnused?: string; dataSubset?: string; staleOnly?: boolean; onProgress?: (line: string) => void }): Promise<{ success: boolean; output?: string; error?: string; stats?: RepoStats }> {
	const destination = await loadDest(destinationId);
	const onProgress = opts?.onProgress;
	if (task === 'repair-index' || task === 'repair-snapshots') {
		const sub = task === 'repair-index' ? 'index' : 'snapshots';
		// repair takes the repo lock — serialize against a concurrent backup to the same
		// repo, and --retry-lock so a legitimately-running cross-instance backup doesn't
		// make repair fail REPO_LOCKED (parity with prune/forget).
		const stream = onProgress && {
			onStdout: (c: string) => { for (const l of formatResticLines(c)) onProgress(l); },
			onStderr: (c: string) => { for (const l of formatResticLines(c)) onProgress(l); }
		};
		const run = await serializeByRepo(destinationId, () => restic.runLocal(destination, ['repair', sub, '--retry-lock', '5m'], 'data', stream || undefined));
		logRepoOp(destination.name, `repair ${sub}`, run.exitCode === 0, { output: run.stdout, error: run.stderr });
		return run.exitCode === 0 ? { success: true, output: run.stdout.trim() } : { success: false, error: run.stderr.trim() || 'repair failed' };
	}
	// prune/check hold the repo lock; run them serialized on the destination so a
	// scheduled maintenance pass can't collide with a backup writing to the same repo.
	// unlock: the EXPLICIT user action uses `--remove-all`; an AUTOMATIC caller passes
	// staleOnly (plain unlock) so it never wipes a live foreign lock on a shared repo.
	// stats (--no-lock) is read-safe and stays unserialized.
	const r = task === 'prune' ? await serializeByRepo(destinationId, () => pruneRepository(reader(), destination, opts?.maxUnused, onProgress))
		: task === 'check' ? await serializeByRepo(destinationId, () => checkRepository(reader(), destination, opts?.dataSubset, onProgress))
		: task === 'unlock' ? await serializeByRepo(destinationId, () => unlockRepository(reader(), destination, !opts?.staleOnly, onProgress))
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
	// Mark this config as user-cancelled so the engine reports the killed helper's
	// non-zero exit as "cancelled" instead of a restic failure. Cleared in runBackup's
	// finally. (Set even if the run finishes cleanly before the kill lands — a stale
	// flag is harmless: it's only read on the failure path of THIS run and cleared at end.)
	cancellingBackupConfigs.add(configId);
	// Force-kill any helper that ignored SIGINT (pathological restic hang), so the
	// user's cancel resolves regardless. Best-effort, out of band.
	void (async () => {
		const { listContainers, dockerFetch } = await import('../docker');
		for (let i = 0; i < 15; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			try {
				const alive = (await listContainers(true, envId)).some((c) => c.state === 'running' && signalled.includes(c.id));
				if (!alive) return;   // SIGINT worked: restic released its lock cleanly, nothing to clear
			} catch { return; }
		}
		// SIGINT was ignored -> SIGKILL. That orphans the restic repo lock (its hostname is the
		// dead container id, so restic won't age it out as stale for 30 min, and the next backup
		// eats ~5 min of --retry-lock). We just killed OUR OWN helper for this repo under the
		// per-repo serializer, so a scoped --remove-all is safe (no other op of ours is running,
		// and a foreign instance's live lock is protected because it can't be proven ours here -
		// but we only reach this after killing our helper, so the lock we clear is the one we orphaned).
		for (const id of signalled) {
			try { await dockerFetch(`/containers/${id}/kill`, { method: 'POST' }, envId); } catch { /* gone */ }
		}
		if (config?.destinationId != null) {
			try {
				const destination = await getBackupDestination(config.destinationId);
				if (destination) await serializeByRepo(config.destinationId, () => unlockRepository(reader(), destination, true));
			} catch { /* best-effort: the pre-backup plain unlock + retry-lock is still the fallback */ }
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
		cancellingBackupConfigs.delete(configId);
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
		selectedVolumes: parseSelectedVolumes(config.selectedVolumes),
		stopBeforeBackup: config.stopBeforeBackup ?? false,
		retention: config.retention ?? null,
		options: buildJobOptions(opts),
		helperName: `dockhand-backup-${config.id}`,
	};

	return await new BackupService(backupPorts(destination, onProgress)).run(job, triggeredBy);
}

/** Run a restore. The route layer has already validated the request + auth and
 * supplies the caller's access context for the ownership guard. */
export async function runRestore(
	job: RestoreJob,
	access: { isEnterprise: boolean; canAccessEnvironment: (id: number) => Promise<boolean> } = { isEnterprise: false, canAccessEnvironment: async () => true },
	onProgress?: (status: string, message: string) => void,
): Promise<RestoreResult> {
	const destination = await getBackupDestination(job.destinationId);
	if (!destination) return { status: 'error', code: 'VALIDATION', error: 'backup destination not found' };

	// Thread the destination's RESTORE flags (parsed from the split flags column, validated
	// against the restore allowlist) into the restore command. This reaches ALL restore
	// modes (in-place/clone/new-location) via the build*Restore flags param. Backup flags stay OUT of restore (restic.ts's backupFlagsForCommand
	// returns nothing for the restore command).
	const restoreFlags = sanitizeRestoreFlags(parseBackupFlags(destination.flags).restore);

	// A local-path repo is allowed on any env: the restore helper (on the target
	// daemon) fails loud via the localRepoGuard if the repo isn't visible there
	// (wrong-host mount), so no silent bad restore — see restic-script.ts.
	return new RestoreService(restorePorts(destination, access, onProgress)).run({ ...job, restoreFlags }, 'manual');
}
