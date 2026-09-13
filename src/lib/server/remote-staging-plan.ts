/**
 * Pure decision logic for copying a stack's files onto a `direct` remote host FOR BACKUP (no
 * server deps - safe to unit test). The IO (helper container + put-archive) lives in
 * stage-remote-stackfiles.ts; this module only decides IF and WHERE.
 */
import { normalizeBaseDir, stackDirIn } from './stack-paths';

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
