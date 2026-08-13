
/**
 * stackdir-plan.ts — the ONE place that decides WHICH host folder is captured as a
 * stack's directory. Pure and import-light (no db/docker/fs), so it is unit-testable
 * directly and can't drift into scattered `connectionType` branches.
 *
 * MAIN FLOW: the backup helper bind-mounts the stack folder from the TARGET env's HOST at
 * /volumes/__dockhand_stackdir__:ro, and restic reads it from disk - the helper is a sibling
 * container on the target daemon, so a host path on that daemon is mountable. The snapshot
 * reflects the stack folder AS IT IS ON THE HOST (what the user actually edits).
 *
 * ONE EXCEPTION - a direct-REMOTE env with NO remote_stacks_dir: nothing is staged on the host
 * (deploy went via stdin), so there is no host folder to mount. The caller then tars the
 * compose/config from Dockhand's OWN local copy into the SAME snapshot location instead of
 * hard-failing. This is the only case that doesn't reflect the host 1:1 - because the host has
 * nothing to reflect.
 *
 * This module resolves the CANDIDATE host path (see resolveHostStackDir). A runtime probe
 * (helper bind + `test -f <composeFile>`) then proves the path is real on the target daemon
 * before capture; if it isn't (e.g. a direct env whose working_dir is Dockhand's own
 * /app/data path, not the host's), capture HARD-FAILS to data-only rather than silently
 * backing up an empty auto-created dir.
 */

/** The reserved /volumes key the stack dir is captured under. Long and namespaced so a real
 * user volume can't realistically collide with it. */
export const STACKDIR_VOLUME_KEY = '__dockhand_stackdir__';

/**
 * True for a reserved /volumes key that is NOT a user data volume — currently just the
 * stack-dir capture. Restore uses it to keep this key OUT of everything that treats a
 * /volumes/ entry as restorable container data (the volume picker, "restore all", the
 * in-place swap). The stack dir is restored ONLY via the redeploy/materialise path.
 */
export function isReservedVolumeKey(key: string): boolean {
	return key === STACKDIR_VOLUME_KEY;
}

/**
 * Where a snapshot's captured stack dir lives, for restore to read it back: ALWAYS
 * /volumes/__dockhand_stackdir__. `include` is for `restic restore --include`; `extractSub`
 * is the on-disk subpath the restore lands under its --target.
 */
export function stackDirSource(): { include: string; extractSub: string } {
	return { include: `/volumes/${STACKDIR_VOLUME_KEY}`, extractSub: `volumes/${STACKDIR_VOLUME_KEY}` };
}

/**
 * Derive the host stack dir from a RELATIVE compose bind and the host path the daemon reports
 * for it. This is the MOST AUTHORITATIVE source: the Docker daemon tells us exactly where the
 * bind lives on its host (`mount.Source`), and compose resolves a relative source (`./html`)
 * against the stack dir - so `hostStackDir = <mount.Source> with the relative tail removed`.
 *
 * Example: compose `./html:/x` on host `/docker/data/dockhand/stacks/anton/pppppp` gives the
 * daemon `mount.Source = /docker/data/dockhand/stacks/anton/pppppp/html`; with relSource
 * `./html` we strip `/html` and get the stack dir. Works on socket, direct-local, adopted, and
 * hawser alike (the daemon always knows its own bind sources), and needs no DATA_DIR/HOST_DATA_DIR
 * config. Returns null when the source isn't relative or the tail doesn't match (absolute bind,
 * `${VAR}` source, etc.) - the caller then falls back to translation/label.
 *
 * @param relSource  the compose bind source as written (e.g. `./html`, `./`, `../x`)
 * @param hostSource the absolute host path the daemon reports for that bind (`mount.Source`)
 */
export function hostStackDirFromBind(relSource: string, hostSource: string): string | null {
	if (typeof relSource !== 'string' || typeof hostSource !== 'string') return null;
	const rs = relSource.trim();
	const hs = hostSource.trim().replace(/\/+$/, '');
	if (!hs.startsWith('/')) return null;          // host source must be absolute
	if (!/^\.\.?\//.test(rs) && rs !== '.' && rs !== './') return null;  // only relative sources

	// The relative tail below the stack dir: `./html` -> `html`, `./` or `.` -> '' (bind IS the
	// stack dir). Reject `../` sources: the bind is ABOVE the stack dir, so we can't derive it.
	let tail = rs.replace(/^\.\//, '').replace(/\/+$/, '');
	if (tail === '.' || tail === '') {
		return hs;   // the whole stack dir is bind-mounted (`./:/app`) -> host source IS the stack dir
	}
	if (tail.startsWith('../') || tail === '..') return null;

	// Strip the `/tail` suffix from the host source. Must actually end with it, or the mapping
	// is inconsistent (don't guess).
	const suffix = '/' + tail;
	if (!hs.endsWith(suffix)) return null;
	const dir = hs.slice(0, hs.length - suffix.length);
	return dir === '' ? '/' : dir;
}

/**
 * Derive the host stack dir by matching the compose's relative bind DIRS against the daemon's
 * reported bind sources. For each relative dir the compose declares (`html`, from `./html:/x`),
 * find a discovered bind whose host source ENDS WITH `/html` and strip that tail - the remainder
 * is the stack dir. Returns the first consistent match, or null if none. Pure + unit-testable.
 *
 * `relBindDirs`: relative dir names from relativeBindDirsFromCompose (e.g. ['html','data']).
 * `bindSources`: the daemon-reported host source paths of the stack's bind mounts (mount.Source).
 */
export function deriveStackDirFromBinds(relBindDirs: string[], bindSources: string[]): string | null {
	for (const rel of relBindDirs) {
		const tail = '/' + rel.replace(/^\/+|\/+$/g, '');
		for (const src of bindSources) {
			const derived = hostStackDirFromBind('./' + rel.replace(/^\/+/, ''), src);
			if (derived) return derived;
			// Also handle a nested relative dir (`./conf/nginx`) whose source ends with the tail.
			const hs = typeof src === 'string' ? src.trim().replace(/\/+$/, '') : '';
			if (hs.endsWith(tail)) { const d = hs.slice(0, hs.length - tail.length); return d === '' ? '/' : d; }
		}
	}
	return null;
}

/**
 * Whether a bind-derived host path can be TRUSTED for this env. bind-derived comes from the
 * target daemon's reported mount.Source, which is a REAL host path for socket / direct-LOCAL /
 * adopted / hawser (the daemon shares its host with the stack). But for a direct-REMOTE env with
 * NO remote_stacks_dir, the stack was deployed VIA STDIN with working_dir = Dockhand's own
 * container path; `docker compose` then asks the remote daemon to bind `./data`, and the daemon
 * mkdir's a PHANTOM EMPTY dir at that Dockhand-container path on ITS host. Stripping the tail
 * yields a dir that exists remotely but holds NO compose (never staged) -> the probe HARD-FAILS.
 * So distrust bind-derived in exactly that case, letting the caller fall through to kind:'tar'
 * (capture the compose/config from Dockhand's own local copy). When remote_stacks_dir IS set the
 * deploy staged the files there and bind-derived pins the real path, so keep it. Pure + testable.
 */
export function trustBindDerivedForEnv(
	bindDerivedHostPath: string | null,
	opts: { directRemote: boolean; hasRemoteStacksDir: boolean }
): string | null {
	if (opts.directRemote && !opts.hasRemoteStacksDir) return null;
	return bindDerivedHostPath;
}

export type StackDirEntry = { name: string; type: 'dir' | 'file'; size: number; capturedAs?: 'bind' | 'volume' };

/**
 * Tag each stack-dir entry that is ALSO captured as its own volume/bind channel, so the picker
 * can show it as non-deselectable ("captured as a bind mount below") - the user controls it in
 * the Volumes section, not here. An entry is a bind when EITHER `<hostPath>/<name>` matches a
 * daemon-reported bind source (runtime) OR its name is a compose relative-bind dir. The compose
 * source is load-bearing: `bindSources` comes from inspecting the RUNNING containers, so a STOPPED
 * stack reports none and a bind dir (e.g. `./memos`) would wrongly show as a plain, deselectable
 * stack file. `bindDirNames` (from the compose, always available) fixes that. Pure + unit-testable.
 */
export function tagCapturedEntries(entries: StackDirEntry[], hostPath: string, bindSources: string[], bindDirNames: string[] = []): StackDirEntry[] {
	const base = hostPath.replace(/\/+$/, '');
	const bindSet = new Set(bindSources.map((s) => (typeof s === 'string' ? s.replace(/\/+$/, '') : '')));
	const nameSet = new Set(bindDirNames);
	return entries.map((e) =>
		(bindSet.has(`${base}/${e.name}`) || nameSet.has(e.name)) ? { ...e, capturedAs: 'bind' as const } : e
	);
}

/**
 * Parse the probe container's directory listing. The probe runs
 * `find /probe -maxdepth 1 -mindepth 1 -printf '%y\t%s\t%f\n'`, so each line is
 * `<type>\t<size>\t<name>` where type is 'd' (dir) / 'f' (file) / other. Pure + unit-testable.
 * Names may contain spaces but not tabs or newlines (find's %f), so tab-splitting is safe.
 * Dirs sort before files, then alphabetical.
 */
export function parseProbeListing(stdout: string): StackDirEntry[] {
	const out: StackDirEntry[] = [];
	for (const line of stdout.split('\n')) {
		if (!line) continue;
		const tab1 = line.indexOf('\t');
		const tab2 = line.indexOf('\t', tab1 + 1);
		if (tab1 < 0 || tab2 < 0) continue;
		const t = line.slice(0, tab1);
		const size = parseInt(line.slice(tab1 + 1, tab2), 10);
		const name = line.slice(tab2 + 1);
		if (!name) continue;
		out.push({ name, type: t === 'd' ? 'dir' : 'file', size: Number.isFinite(size) ? size : 0 });
	}
	return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

/** Sentinel the probe list-script prints when the target path does NOT exist, so the classifier can
 * tell "helper ran, dir missing" apart from "helper ran, dir empty" (both otherwise list nothing). */
export const PROBE_MISSING_SENTINEL = '__PROBE_MISSING__';

/** Data-presence verdict for a probed host path / volume. `helper-failed` (the container could not
 * run at all) is decided by the CALLER catching the run error - the classifier only sees stdout of
 * a helper that DID run, so it returns has-data / empty / missing. */
export type ProbeDataKind = 'has-data' | 'empty' | 'missing' | 'helper-failed';

/** Classify a probe helper's stdout (pure, unit-testable). The list-script prints the missing
 * sentinel when the path doesn't exist, one `<type>\t<size>\t<name>` line per entry otherwise. */
export function classifyProbeListing(stdout: string): 'has-data' | 'empty' | 'missing' {
	if (stdout.includes(PROBE_MISSING_SENTINEL)) return 'missing';
	return parseProbeListing(stdout).length > 0 ? 'has-data' : 'empty';
}

/**
 * Is the TARGET daemon Dockhand's OWN host? Only then are the DATA_DIR / container-mount
 * translations valid: they map a container path to DOCKHAND'S host (via HOST_DATA_DIR /
 * Dockhand's own mounts), which is the WRONG host for a remote daemon. For a remote env the
 * stack lives on a DIFFERENT machine, so those translations would hand the helper a path that
 * only exists on Dockhand's host, not the remote one. Pure + unit-testable.
 *   - socket / null: local (Dockhand shares the daemon's host).
 *   - direct: local ONLY when the env's tcp host == Dockhand's own docker host (#1203 proof).
 *   - hawser: never local.
 */
export function isLocalDaemon(connectionType: string | null, envTcpHost: string | null, ownDockerHost: string | null): boolean {
	if (connectionType && connectionType.startsWith('hawser')) return false;
	if (connectionType === 'socket' || connectionType == null) return true;
	if (connectionType === 'direct') return !!(ownDockerHost && envTcpHost && ownDockerHost === envTcpHost);
	return false;
}

/** Result of resolving the candidate host stack folder (before the runtime probe). */
export type HostStackDirResolution =
	| { kind: 'candidate'; hostPath: string; composeFile: string; source: string }
	| { kind: 'unknown'; reason: string };

/** Inputs for the pure host-path resolution. All the I/O (compose lookup, DATA_DIR/mount
 * translation, label read) is done by the CALLER and injected here, so this stays pure and
 * unit-testable. The caller passes whichever candidates it could compute; this picks the
 * right one in priority order. */
export interface HostStackDirInput {
	/** basename of Dockhand's compose file for the stack (immich.yaml / docker-compose.yml).
	 * The AUTHORITATIVE compose name - NOT the config_files label, which is `-` when Dockhand
	 * deploys via stdin (`-f -`). */
	composeFileName: string | null;
	/** For a direct-REMOTE env with remote_stacks_dir set: the explicit, user-declared host
	 * path (<remote_stacks_dir>/<stack>) where the deploy staged the files. Highest priority
	 * after a bind pins the dir more exactly. Null for socket/hawser/local. */
	remoteStacksDirHostPath?: string | null;
	/** Host stack dir DERIVED from a relative compose bind's daemon-reported source
	 * (hostStackDirFromBind). The MOST AUTHORITATIVE source - the daemon knows exactly where its
	 * bind lives on the host, so this needs no DATA_DIR/HOST_DATA_DIR config and works on socket,
	 * direct-local, adopted, and hawser. Null when the stack has no usable relative bind. */
	bindDerivedHostPath: string | null;
	/** Dockhand's stack dir translated to the host via DATA_DIR -> HOST_DATA_DIR. Non-null
	 * (and != the container path) when the stack lives under Dockhand's DATA_DIR and the host
	 * data dir is known - the SOCKET/LOCAL Dockhand-deployed case. Fallback when no bind. */
	dataDirHostPath: string | null;
	/** Dockhand's stack dir translated to the host via a container bind mount, for an
	 * adopted/external stack that lives OUTSIDE DATA_DIR but on a mounted host path. */
	mountHostPath: string | null;
	/** com.docker.compose.project.working_dir label. For a HAWSER agent (which ran compose on
	 * the remote host) or a matching-paths direct env, this IS the real host path. Used only
	 * when neither translation applies (the daemon is not Dockhand's own host). */
	workingDirLabel: string | null;
}

/**
 * Resolve the CANDIDATE host stack folder. ONE FLOW still: the helper always bind-mounts this
 * path from the target daemon's host. The subtlety is that "where is the stack folder ON THAT
 * DAEMON'S HOST" differs by wiring, and the compose `working_dir` label is NOT reliable on its
 * own (it is the container-view path for a Dockhand-deployed stack, and `config_files` is `-`
 * for stdin deploys). So the caller computes the candidates and we pick in priority order:
 *   1. `bindDerivedHostPath` - derived from a relative bind's daemon-reported source. The daemon
 *      knows exactly where its bind lives on the host, so this is authoritative and needs no
 *      DATA_DIR config. Works on socket / direct-local / adopted / hawser.
 *   2. `dataDirHostPath` - Dockhand deployed the stack under DATA_DIR and we know the host data
 *      dir (SOCKET/LOCAL). The label `/app/data/...` would be the CONTAINER path; the helper on
 *      the host needs `/docker/data/dockhand/...`.
 *   3. `mountHostPath` - adopted/external stack outside DATA_DIR but on a mounted host path.
 *   4. `workingDirLabel` - HAWSER (agent ran compose on the remote host, label = host path) or
 *      matching-paths direct. Only when nothing above applied.
 *   5. none -> unknown (caller HARD-FAILS a stack backup; option A).
 * A runtime probe (`test -f <composeFile>` in the helper) then CONFIRMS reachability before
 * capture. Pure + unit-testable. */
export function resolveHostStackDir(input: HostStackDirInput): HostStackDirResolution {
	// The probe's `test -f` needs a real compose name. `config_files` is `-` for stdin deploys,
	// so we take the name from Dockhand's own compose file (composeFileName), falling back to the
	// conventional name.
	const composeFile = input.composeFileName && input.composeFileName !== '-'
		? input.composeFileName
		: 'docker-compose.yml';

	const norm = (p: string | null | undefined): string => (typeof p === 'string' ? p.trim().replace(/\/+$/, '') : '');

	const viaBind = norm(input.bindDerivedHostPath);
	if (viaBind) return { kind: 'candidate', hostPath: viaBind, composeFile, source: 'derived from a relative compose bind (daemon-reported host source)' };

	const viaRemoteDir = norm(input.remoteStacksDirHostPath);
	if (viaRemoteDir) return { kind: 'candidate', hostPath: viaRemoteDir, composeFile, source: 'declared host stack path (direct-remote remote_stacks_dir / hawser agent STACKS_DIR)' };

	const viaData = norm(input.dataDirHostPath);
	if (viaData) return { kind: 'candidate', hostPath: viaData, composeFile, source: 'DATA_DIR -> HOST_DATA_DIR translation (Dockhand-deployed, local)' };

	const viaMount = norm(input.mountHostPath);
	if (viaMount) return { kind: 'candidate', hostPath: viaMount, composeFile, source: 'container mount translation (adopted/external stack)' };

	const wd = norm(input.workingDirLabel);
	if (wd) return { kind: 'candidate', hostPath: wd, composeFile, source: 'compose working_dir label (hawser agent / matching paths)' };

	return { kind: 'unknown', reason: 'could not locate the stack folder on the host (no DATA_DIR/mount translation and no working_dir label)' };
}
