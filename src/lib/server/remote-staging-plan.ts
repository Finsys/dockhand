/**
 * Pure decision logic for copying a stack's files onto a `direct` remote host FOR BACKUP (no
 * server deps - safe to unit test). The IO (helper container + put-archive) lives in
 * stage-remote-stackfiles.ts; this module only decides IF and WHERE.
 */
import { posix } from 'node:path';
import { normalizeBaseDir, stackDirIn } from './stack-paths';
import { resolveHostPath, type ContainerMount } from './host-path';

export interface RemoteStagingPlan {
	stage: boolean;
	/** Absolute stack dir on the remote host (<remoteBase>/<stack>), when stage is true. */
	hostDir?: string;
	reason: string;
}

/**
 * Decide whether a `direct` deploy should copy the stack folder onto the remote host, and where.
 * This is BACKUP-only: the backup helper bind-mounts the host dir to capture the compose/config.
 * It does NOT steer deploy - compose runs locally with the user's own bind paths (absolute or
 * matched 1:1), the same as a hawser agent whose STACKS_DIR is a backup-only declaration.
 *
 * Copying happens when ALL hold:
 *   - operation is 'up' (down/stop/start/restart don't re-copy),
 *   - the env has a non-empty remote_stacks_dir configured,
 *   - there are stack files to copy.
 * Any miss => stage:false => nothing is copied (stack-file backup is skipped for the env).
 */
export function planRemoteStaging(input: {
	operation: string;
	remoteStacksDir: string | null | undefined;
	stackName: string;
	composeContent: string;
	hasStackFiles: boolean;
}): RemoteStagingPlan {
	if (input.operation !== 'up') return { stage: false, reason: `operation ${input.operation} does not stage` };
	if (!input.hasStackFiles) return { stage: false, reason: 'no stack files to stage' };
	const base = typeof input.remoteStacksDir === 'string' ? normalizeBaseDir(input.remoteStacksDir) : '';
	if (!base) return { stage: false, reason: 'no remote_stacks_dir configured on the env' };
	// SAME formula the backup resolver reads from (stackDirIn) - deploy COPIES here, backup READS here.
	return { stage: true, hostDir: stackDirIn(base, input.stackName), reason: 'direct env with remote_stacks_dir' };
}

/**
 * True when staging would write Dockhand's own stack folder onto itself: the env reaches the
 * daemon Dockhand runs on, and Dockhand's own mounts place its stack dir at exactly `hostDir`.
 * The copy is then pointless and harmful (each file gets a new inode under the apps that hold it
 * open, modes and hardlinks are not kept), so the caller skips it and keeps the bind rewrite.
 * Any doubt answers false, which keeps the copy.
 */
export function stagingLandsOnItself(input: {
	/** tcp://host:port the deploy talks to. */
	envDockerHost: string;
	/** DOCKER_HOST read from Dockhand's own container, or null. */
	ownDockerHost: string | null;
	/** Dockhand's stack dir, symlinks resolved. */
	workingDir: string;
	hostDir: string;
	mounts: ContainerMount[];
	/** Resolves symlinks in a mount destination; a mount reported through one still lands
	 *  inside the stack dir. Defaults to the path as written. */
	realpath?: (path: string) => string;
}): boolean {
	if (!input.ownDockerHost || input.ownDockerHost !== input.envDockerHost) return false;
	const work = posix.normalize(input.workingDir).replace(/\/+$/, '');
	// Another mount inside the stack dir puts its own host dir there; the folder at hostDir
	// would not hold those files.
	const real = input.realpath ?? ((p: string) => p);
	for (const m of input.mounts) {
		for (const spelled of [m.destination, real(m.destination)]) {
			const dest = posix.normalize(spelled).replace(/\/+$/, '');
			if (dest.startsWith(work + '/')) return false;
		}
	}
	// HOST_DATA_DIR is a declaration, not a measurement; only the mount table proves it.
	const host = resolveHostPath(work, input.mounts, undefined, null);
	if (!host.ok || (host.via !== 'bind' && host.via !== 'volume')) return false;
	return posix.normalize(host.hostPath).replace(/\/+$/, '') === posix.normalize(input.hostDir).replace(/\/+$/, '');
}

/**
 * What a `direct` deploy does with a staging plan: whether to copy, and which host dir the
 * relative binds are rewritten to. The rewrite applies whenever the plan stages, copy or not.
 * `self` is null when the inputs for the self-check could not be read; that keeps the copy.
 */
export function stagingDecision(
	plan: RemoteStagingPlan,
	self: Parameters<typeof stagingLandsOnItself>[0] | null
): { copy: boolean; rewriteHostDir: string | undefined } {
	if (!plan.stage || !plan.hostDir) return { copy: false, rewriteHostDir: undefined };
	return { copy: !(self && stagingLandsOnItself(self)), rewriteHostDir: plan.hostDir };
}

export interface BindRewriteResult {
	content: string;
	modified: boolean;
	/** Human-readable `./x -> <hostDir>/x` mappings, for logging. */
	changes: string[];
}

/**
 * Rewrite a compose file's SAME-DIR relative bind sources (`./x`) to absolute paths under the
 * stack's host dir (`<hostDir>/x`), so a `direct` remote daemon binds the files the deploy
 * copied there instead of a path only Dockhand can see.
 *
 * Only `./x` is rewritten - that's exactly the subtree the staging copy delivers to `hostDir`.
 * A `../x` escapes the stack dir (never staged), so it is left untouched to fail loudly rather
 * than point at a bogus host path. Named volumes, absolute binds, and non-bind lines pass through.
 * The scheme is inferred from a compose line, so no YAML parser is needed (mirrors
 * rewriteComposeVolumePaths); each match is anchored to a `- <src>:<dest>` volume entry.
 *
 * Pure and dependency-free (safe to unit test). `hostDir` must be an absolute POSIX path.
 */
export function rewriteBindsToHostDir(composeContent: string, hostDir: string): BindRewriteResult {
	const base = hostDir.replace(/\/+$/, '');
	const changes: string[] = [];
	// - ./x:/dest  where the WHOLE "src:dest" may be wrapped in matching quotes:
	//   - ./data:/data   |   - "./data:/data"   |   - './data:/data'
	// `./` only - a `../` (or bare `.`) is intentionally NOT matched.
	const RE = /^(\s*-\s*)(['"]?)\.\/([^'":\s]+)(:[^'"]+)(\2)\s*$/;

	const out = composeContent.split('\n').map((line) => {
		const m = line.match(RE);
		if (!m) return line;
		const [, prefix, quote, rel, dest] = m;
		const abs = `${base}/${rel}`;
		changes.push(`  ./${rel} -> ${abs}`);
		return `${prefix}${quote}${abs}${dest}${quote}`;
	});

	return { content: out.join('\n'), modified: changes.length > 0, changes };
}

/**
 * Whether a stack-dir-relative path is sent, given bind sources to leave on the host. The
 * stack's own `.env` / `.env.*` is always sent: held back, Dockhand would generate a `.env`
 * from its stored variables and send that instead.
 */
export function stagedPathSent(relPath: string, keepOnHost: string[]): boolean {
	if (!relPath.includes('/') && (relPath === '.env' || relPath.startsWith('.env.'))) return true;
	return !keepOnHost.some((k) => relPath === k || relPath.startsWith(k + '/'));
}

/** `files` (relative path -> content) without what `stagedPathSent` holds back. */
export function withoutBindSources(files: Record<string, string>, keepOnHost: string[]): Record<string, string> {
	return Object.fromEntries(Object.entries(files).filter(([rel]) => stagedPathSent(rel, keepOnHost)));
}
