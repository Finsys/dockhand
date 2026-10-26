/**
 * Operation-specific `docker compose` CLI args, split out of executeLocalCompose so the
 * arg construction is unit-testable without a daemon.
 *
 * `--no-cache` and `--pull` (base images) are `docker compose build` flags, not `up` flags.
 * A no-cache rebuild or a base-image pull runs a separate `build` first (see
 * runsSeparateBuild and pullBuildThenUp).
 */
import { mergeDeletionReports, type DeletionApplyResult } from './git-deletions';
export interface ComposeOperationArgOptions {
	forceRecreate?: boolean;
	removeVolumes?: boolean;
	build?: boolean;
	/** `build`: build without the layer cache (`--no-cache`). `pull` then skips the services that are built. */
	noBuildCache?: boolean;
	/** `build`: pull a newer version of each Dockerfile's FROM image (`--pull`). `pull` then skips the services that are built. */
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
			// Never --no-cache, which up doesn't accept: a no-cache rebuild is a separate build.
			if (build && !noBuild) args.push('--build');
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
			// Before a separate build: the build replaces those images, and a service whose
			// tag is in no registry would fail the pull.
			if (pullBase || noBuildCache) args.push('--ignore-buildable');
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
 * Whether a deploy builds in a separate step before `up` (pullBuildThenUp): for a base-image
 * pull (`build --pull`) and for a no-cache rebuild (`build --no-cache`), which `up` cannot do.
 */
export function runsSeparateBuild(build?: boolean, pullBase?: boolean, noBuildCache?: boolean): boolean {
	return !!build && (!!pullBase || !!noBuildCache);
}

/** What a deploy logs when the Hawser agent has no build operation, so the separate build step cannot run. */
export const BUILD_STEP_UNSUPPORTED_WARNING =
	'The Hawser agent is older than 0.2.51 and has no build operation, so this deploy builds with the layer cache and without pulling base images; update the agent to get either';

/**
 * Run a deploy's separate build step. `stop` is the failed result when the deploy must stop.
 * `built` says the images are fresh, so `up` must not build again: a second build without
 * `--pull` uses the cached base and undoes the pull. An agent without the build operation
 * is a warning, not a failure, and the deploy goes on with a plain `up --build`.
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
 * A deploy's steps for a separate build: pull, build, then up. The pull goes
 * first because pulling after the build replaces the fresh image of a service whose tag is
 * in a registry. 'always' pulls with `--policy always`, 'respect' honours pull_policy; a
 * failed pull is a warning, as a service sharing a built image is in no registry. After a
 * successful build `up` must not build again. `up` never gets `noBuildCache`: an agent older
 * than 0.2.51 would pass it on as `up --no-cache`, which compose rejects. The result is the
 * `up` result, with the file deletions both build and up reported.
 */
export async function pullBuildThenUp<R extends { success: boolean; error?: string; deletion?: DeletionApplyResult }>(
	pullPolicy: string | undefined,
	run: (operation: 'pull' | 'build' | 'up', opts: { pullPolicy?: string; noBuild?: boolean; noBuildCache?: boolean }) => Promise<R>,
	warn: (message: string) => void
): Promise<R> {
	if (pullPolicy && !(await run('pull', { pullPolicy: pullPolicy === 'always' ? 'always' : undefined })).success) {
		warn(PULL_FAILED_WARNING);
	}
	let built: R | undefined;
	const step = await runBuildStep(async () => (built = await run('build', {})), warn);
	if (step.stop) return step.stop;
	const up = await run('up', { noBuild: step.built, noBuildCache: false });
	const deletion = mergeDeletionReports([built?.deletion, up.deletion]);
	return deletion ? { ...up, deletion } : up;
}

/** The options one pullBuildThenUp step runs with; an up after a successful build never builds. */
export function stepOptions<T extends { pullPolicy?: string; build?: boolean; noBuild?: boolean; noBuildCache?: boolean }>(
	base: T,
	opts: { pullPolicy?: string; noBuild?: boolean; noBuildCache?: boolean }
): T {
	return {
		...base,
		pullPolicy: opts.pullPolicy,
		...(opts.noBuildCache === false ? { noBuildCache: false } : {}),
		...(opts.noBuild ? { build: false, noBuild: true } : {})
	};
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

/** The steps a deploy runs and the flags that chose them, for the server log. */
export function deployPlan(build?: boolean, pullBase?: boolean, noBuildCache?: boolean, pullPolicy?: string): string {
	let steps: string;
	if (runsSeparateBuild(build, pullBase, noBuildCache)) {
		const buildFlags = [pullBase && '--pull', noBuildCache && '--no-cache'].filter(Boolean).join(' ');
		steps = `${pullPolicy ? 'pull -> ' : ''}build${buildFlags ? ` ${buildFlags}` : ''} -> up --no-build`;
	} else {
		const { separatePull, upPullPolicy } = pullSteps(pullPolicy);
		steps = `${separatePull ? 'pull -> ' : ''}up${build ? ' --build' : ''}${upPullPolicy ? ` --pull ${upPullPolicy}` : ''}`;
	}
	return `${steps} (build=${!!build}, pullBase=${!!pullBase}, noBuildCache=${!!noBuildCache}, pullPolicy=${pullPolicy ?? 'none'})`;
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
