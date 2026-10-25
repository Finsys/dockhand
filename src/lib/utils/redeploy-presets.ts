/**
 * The redeploy popover's two pure pieces: the one-click presets and the compose
 * command they produce.
 *
 * The command MIRRORS buildComposeOperationArgs('up', ...) in
 * $lib/server/compose-args.ts and cannot import it - SvelteKit refuses a
 * server-only import from client code. The mirror is therefore held by
 * tests/redeploy-presets.test.ts, which asserts the two agree flag for flag and
 * in order; without that a flag added on the server would leave the popover
 * quietly showing a command nobody runs.
 */

export interface DeployChoice {
	pull: boolean;
	build: boolean;
	forceRecreate: boolean;
	/** With pull: a separate `docker compose pull`, which honours each service's pull_policy, instead of `--pull always`. */
	respectPullPolicy?: boolean;
	/** With build: a separate `docker compose build --pull` first, which refreshes each Dockerfile's FROM image. */
	pullBase?: boolean;
}

export interface RedeployPreset {
	label: string;
	pull: boolean;
	forceRecreate: boolean;
}

/**
 * The three ways people redeploy. `build` is deliberately absent: it follows the
 * compose file (does it have a build: section), not the deploy intent, so a preset
 * must not silently turn it on or off.
 */
export const REDEPLOY_PRESETS: RedeployPreset[] = [
	{ label: 'Only changed', pull: false, forceRecreate: false },
	{ label: 'Recreate all', pull: false, forceRecreate: true },
	{ label: 'Pull + recreate', pull: true, forceRecreate: true }
];

/** Whether a preset describes the current checkbox state, so it can be shown as active. */
export function isPresetActive(preset: RedeployPreset, choice: Pick<DeployChoice, 'pull' | 'forceRecreate'>): boolean {
	return preset.pull === choice.pull && preset.forceRecreate === choice.forceRecreate;
}

/** The command the chosen options will run, for the preview under the checkboxes. */
export function composeCommandFor(choice: DeployChoice): string {
	// A separate build (pullBuildThenUp) pulls first, then builds, then starts without building.
	const separateBuild = !!(choice.build && choice.pullBase);
	const separatePull = choice.pull && (choice.respectPullPolicy || separateBuild);
	const up = [
		'docker compose up -d --remove-orphans',
		choice.forceRecreate ? '--force-recreate' : '',
		choice.build && !separateBuild ? '--build' : '',
		separateBuild ? '--no-build' : '',
		choice.pull && !separatePull ? '--pull always' : ''
	]
		.filter(Boolean)
		.join(' ');
	const pull = separatePull
		? ['docker compose pull', choice.respectPullPolicy ? '' : '--policy always', separateBuild ? '--ignore-buildable' : ''].filter(Boolean).join(' ')
		: '';
	return [pull, separateBuild ? 'docker compose build --pull' : '', up].filter(Boolean).join('; ');
}
