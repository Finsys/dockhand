/**
 * Pure decision logic for staging a stack's files onto a `direct` remote host (no server
 * deps - safe to unit test). The IO (helper container + put-archive) lives in
 * stage-remote-stackfiles.ts; this module only decides IF and WHERE.
 */

export interface RemoteStagingPlan {
	stage: boolean;
	/** Absolute project dir on the remote host (<remoteBase>/<stack>), when stage is true. */
	projectDir?: string;
	reason: string;
}

/**
 * Decide whether a `direct` deploy should stage files onto the remote host, and where.
 *
 * Staging happens when ALL hold:
 *   - operation is 'up' (down/stop/start/restart don't re-stage),
 *   - the env has a non-empty remote_stacks_dir configured,
 *   - there are stack files to stage.
 * Setting remote_stacks_dir is the user's explicit "keep my stacks here on the host", so we
 * stage the WHOLE stack dir (compose + .env + sibling config) - not only when the compose has
 * relative binds. Relative binds still need it to resolve, but a bind-less stack needs its
 * compose on the host just as much: to be manageable and BACKUPABLE (the helper bind-mounts the
 * host dir; without the compose there, a backup can't capture it).
 * Any miss => stage:false => the deploy takes the exact current code path (no --project-directory).
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
	const base = typeof input.remoteStacksDir === 'string' ? input.remoteStacksDir.trim().replace(/\/+$/, '') : '';
	if (!base) return { stage: false, reason: 'no remote_stacks_dir configured on the env' };
	return { stage: true, projectDir: `${base}/${input.stackName}`, reason: 'direct env with remote_stacks_dir' };
}
