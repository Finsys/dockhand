/**
 * Operation-specific `docker compose` CLI args, split out of executeLocalCompose so the
 * arg construction is unit-testable without a daemon.
 *
 * `--no-cache` is a `docker compose build` flag, NOT an `up` flag: pushing it onto `up`
 * makes the CLI reject the whole command with "unknown flag: --no-cache" (#1479). When a
 * no-cache rebuild is requested, the caller runs a separate `build` operation first (see
 * shouldRunSeparateBuildStep) and then a plain `up` - so `up` omits `--build` in that case
 * (the fresh image already exists).
 */
export interface ComposeOperationArgOptions {
	forceRecreate?: boolean;
	/**
	 * Include `--remove-orphans` on `up` (default true, preserving every existing
	 * caller). The auto-update path passes false: a background job must not delete
	 * containers that merely drifted from the on-disk compose file. (#1539 review)
	 */
	removeOrphans?: boolean;
	/**
	 * Add `--no-deps` to `up` so dependencies of the named services are not started.
	 * An explicit target list is an update, not a cold start: without this, a service
	 * an operator `exclude`d is still recreated when another target depends on it. (#1539 review)
	 */
	noDeps?: boolean;
	removeVolumes?: boolean;
	build?: boolean;
	noBuildCache?: boolean;
	pullPolicy?: string;
	serviceName?: string;
	/**
	 * Multiple target services (#1539 cascade updates). Appended after
	 * `serviceName` so a caller can pass either. Compose accepts a space-separated
	 * service list for `up`/`pull`/`build`.
	 */
	serviceNames?: string[];
}

export function buildComposeOperationArgs(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull' | 'build',
	options: ComposeOperationArgOptions = {}
): string[] {
	const { forceRecreate, removeOrphans, noDeps, removeVolumes, build, noBuildCache, pullPolicy, serviceName, serviceNames } = options;
	const args: string[] = [];
	// One service arg list for every operation: the legacy single `serviceName` plus
	// any explicit list (#1539). De-duplicated, order preserved (changed service first).
	const targets: string[] = [];
	if (serviceName) targets.push(serviceName);
	for (const name of serviceNames ?? []) {
		if (name && !targets.includes(name)) targets.push(name);
	}

	switch (operation) {
		case 'up':
			args.push('up', '-d');
			// Opt-out exists for the unattended auto-update path (#1539 review); every
			// other caller keeps the historical --remove-orphans default.
			if (removeOrphans !== false) args.push('--remove-orphans');
			// Keep an excluded service out of the redeploy even when a target depends on it.
			if (noDeps) args.push('--no-deps');
			if (forceRecreate) args.push('--force-recreate');
			// A no-cache rebuild is handled by a separate `build` step, so `up` must not
			// also carry --build (and never --no-cache, which up doesn't accept).
			if (build && !noBuildCache) args.push('--build');
			if (pullPolicy) args.push('--pull', pullPolicy);
			args.push(...targets);
			break;
		case 'down':
			args.push('down', '--remove-orphans');
			if (removeVolumes) args.push('--volumes');
			break;
		case 'stop':
			args.push('stop');
			break;
		case 'start':
			args.push('start');
			break;
		case 'restart':
			args.push('restart');
			break;
		case 'pull':
			args.push('pull');
			args.push(...targets);
			break;
		case 'build':
			args.push('build');
			if (noBuildCache) args.push('--no-cache');
			args.push(...targets);
			break;
	}

	return args;
}

/**
 * A no-cache rebuild needs a separate `docker compose build --no-cache` before `up`.
 * Hawser's remote agent has no `build` operation (#880/#1020), so the separate step only
 * runs for local/direct deployments; on Hawser a no-cache request is silently a no-op
 * rather than a hard error.
 */
export function shouldRunSeparateBuildStep(
	build: boolean | undefined,
	noBuildCache: boolean | undefined,
	connectionType: string | null | undefined
): boolean {
	const isHawser = connectionType === 'hawser-standard' || connectionType === 'hawser-edge';
	return !!build && !!noBuildCache && !isHawser;
}
