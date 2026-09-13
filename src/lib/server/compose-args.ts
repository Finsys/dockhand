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
	removeVolumes?: boolean;
	build?: boolean;
	noBuildCache?: boolean;
	pullPolicy?: string;
	serviceName?: string;
}

export function buildComposeOperationArgs(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull' | 'build',
	options: ComposeOperationArgOptions = {}
): string[] {
	const { forceRecreate, removeVolumes, build, noBuildCache, pullPolicy, serviceName } = options;
	const args: string[] = [];

	switch (operation) {
		case 'up':
			args.push('up', '-d', '--remove-orphans');
			if (forceRecreate) args.push('--force-recreate');
			// A no-cache rebuild is handled by a separate `build` step, so `up` must not
			// also carry --build (and never --no-cache, which up doesn't accept).
			if (build && !noBuildCache) args.push('--build');
			if (pullPolicy) args.push('--pull', pullPolicy);
			if (serviceName) args.push(serviceName);
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
			if (serviceName) args.push(serviceName);
			break;
		case 'build':
			args.push('build');
			if (noBuildCache) args.push('--no-cache');
			if (serviceName) args.push(serviceName);
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
