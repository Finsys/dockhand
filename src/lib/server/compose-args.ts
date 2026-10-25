/**
 * Operation-specific `docker compose` CLI args, split out of executeLocalCompose so the
 * arg construction is unit-testable without a daemon.
 *
 * `--no-cache` and `--pull` (base images) are `docker compose build` flags, not `up` flags.
 * A no-cache rebuild or a base-image pull runs a separate `build` first (see
 * shouldRunSeparateBuildStep and pullBuildThenUp).
 */
export interface ComposeOperationArgOptions {
	forceRecreate?: boolean;
	removeVolumes?: boolean;
	build?: boolean;
	noBuildCache?: boolean;
	/** `build`: pull a newer version of each Dockerfile's FROM image (`--pull`). `pull`: skip
	 *  services with a build section, which the base-image build replaces anyway. */
	pullBase?: boolean;
	/** `up` only: never build, even for `pull_policy: build`; the images were just built. */
	noBuild?: boolean;
	pullPolicy?: string;
	serviceName?: string;
}

export function buildComposeOperationArgs(
	operation: 'up' | 'down' | 'stop' | 'start' | 'restart' | 'pull' | 'build',
	options: ComposeOperationArgOptions = {}
): string[] {
	const { forceRecreate, removeVolumes, build, noBuildCache, pullBase, noBuild, pullPolicy, serviceName } = options;
	const args: string[] = [];

	switch (operation) {
		case 'up':
			args.push('up', '-d', '--remove-orphans');
			if (forceRecreate) args.push('--force-recreate');
			// A no-cache rebuild is handled by a separate `build` step, so `up` must not
			// also carry --build (and never --no-cache, which up doesn't accept).
			if (build && !noBuildCache && !noBuild) args.push('--build');
			if (noBuild) args.push('--no-build');
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
			if (pullPolicy === 'always') args.push('--policy', 'always');
			if (pullBase) args.push('--ignore-buildable');
			if (serviceName) args.push(serviceName);
			break;
		case 'build':
			args.push('build');
			if (pullBase) args.push('--pull');
			if (noBuildCache) args.push('--no-cache');
			if (serviceName) args.push(serviceName);
			break;
	}

	return args;
}

/**
 * A no-cache rebuild needs a separate `docker compose build --no-cache` before `up`.
 * It only runs for local/direct deployments; on Hawser a no-cache request is silently a
 * no-op rather than a hard error. A base-image pull is separate: see pullBuildThenUp.
 */
export function shouldRunSeparateBuildStep(
	build: boolean | undefined,
	noBuildCache: boolean | undefined,
	connectionType: string | null | undefined
): boolean {
	const isHawser = connectionType === 'hawser-standard' || connectionType === 'hawser-edge';
	return !!build && !!noBuildCache && !isHawser;
}

/** What a deploy logs when the Hawser agent has no build operation, so base images are not pulled. */
export const BUILD_STEP_UNSUPPORTED_WARNING =
	'The Hawser agent is older than 0.2.51 and cannot pull base images; building with the base images present locally';

/**
 * Run a deploy's separate build step. `stop` is the failed result when the deploy must stop.
 * `built` says the images are fresh, so `up` must not build again: a second build without
 * `--pull` uses the cached base and undoes the pull. An agent without the build operation
 * is a warning, not a failure, and `up --build` then builds from the cached base images.
 */
export async function runBuildStep<R extends { success: boolean; error?: string }>(
	run: () => Promise<R>,
	warn: (message: string) => void
): Promise<{ stop?: R; built: boolean }> {
	const result = await run();
	if (result.success) return { built: true };
	if (/unsupported compose operation/i.test(result.error ?? '')) {
		warn(BUILD_STEP_UNSUPPORTED_WARNING);
		return { built: false };
	}
	return { stop: result, built: false };
}

/**
 * A deploy's steps for "Pull base images": pull, `build --pull`, then up. The pull goes
 * first because pulling after the build replaces the fresh image of a service whose tag is
 * in a registry. 'always' pulls with `--policy always`, 'respect' honours pull_policy; a
 * failed pull is a warning, as a service sharing a built image is in no registry. After a
 * successful build `up` must not build again.
 */
export async function pullBuildThenUp<R extends { success: boolean; error?: string }>(
	pullPolicy: string | undefined,
	run: (operation: 'pull' | 'build' | 'up', opts: { pullPolicy?: string; noBuild?: boolean }) => Promise<R>,
	warn: (message: string) => void
): Promise<R> {
	if (pullPolicy && !(await run('pull', { pullPolicy: pullPolicy === 'always' ? 'always' : undefined })).success) {
		warn(PULL_FAILED_WARNING);
	}
	const step = await runBuildStep(() => run('build', {}), warn);
	if (step.stop) return step.stop;
	return run('up', { noBuild: step.built });
}

/** The options one pullBuildThenUp step runs with; an up after a successful build never builds. */
export function stepOptions<T extends { pullPolicy?: string; build?: boolean; noBuild?: boolean }>(
	base: T,
	opts: { pullPolicy?: string; noBuild?: boolean }
): T {
	return { ...base, pullPolicy: opts.pullPolicy, ...(opts.noBuild ? { build: false, noBuild: true } : {}) };
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
