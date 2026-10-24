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

/**
 * The pull policy a deploy request asks for. "Respect pull_policy" swaps `--pull always`,
 * which overrides every service's pull_policy, for a separate `docker compose pull`
 * that honours it.
 */
export function deployPullPolicy(pull?: boolean, respectPullPolicy?: boolean): 'always' | 'respect' | undefined {
	if (!pull) return undefined;
	return respectPullPolicy ? 'respect' : 'always';
}

/**
 * How a deploy pulls for a pull policy: 'respect' runs a separate `docker compose pull`
 * before a plain `up`; any other value goes to `up` as `--pull <value>`.
 */
export function pullSteps(pullPolicy?: string): { separatePull: boolean; upPullPolicy?: string } {
	return pullPolicy === 'respect' ? { separatePull: true } : { separatePull: false, upPullPolicy: pullPolicy };
}

/** What a deploy logs when its separate pull fails and it goes on with the local images. */
export const PULL_FAILED_WARNING = 'Some images could not be pulled; continuing with the images present locally';

/**
 * Run a deploy's pull and up for its pull policy. With 'respect' a separate
 * `docker compose pull` runs first; when it fails, `warn` is told and `up` runs anyway.
 * The result is always the `up` result.
 */
export async function pullThenUp<R extends { success: boolean }>(
	pullPolicy: string | undefined,
	run: (operation: 'pull' | 'up', upPullPolicy?: string) => Promise<R>,
	warn: (message: string) => void
): Promise<R> {
	const { separatePull, upPullPolicy } = pullSteps(pullPolicy);
	if (separatePull && !(await run('pull')).success) warn(PULL_FAILED_WARNING);
	return run('up', upPullPolicy);
}
