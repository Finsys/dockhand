import yaml from 'js-yaml';

/**
 * Whether a compose file declares a `build:` section for any service -- used to
 * pre-check "Build images" in the Save & redeploy / Create & Start popover
 * (RedeployPopover's defaultBuild).
 *
 * `build:` can be a bare string (`build: ./dir`) or an object
 * (`build: {context: ., dockerfile: ...}`) -- this checks truthiness, the same way
 * ComposeGraphViewer.svelte's `config.image || (config.build ? 'build' : 'custom')`
 * already does, not `typeof`, so both forms are detected equally.
 *
 * Parse errors (mid-edit, invalid YAML) fall back to false rather than throwing: an
 * unparseable draft shouldn't crash the checkbox, and "Build images" can still be
 * checked manually while the operator is still typing.
 */
export function hasBuildSection(composeContent: string): boolean {
	try {
		const parsed = yaml.load(composeContent) as { services?: Record<string, { build?: unknown }> } | undefined;
		const services = parsed?.services;
		if (!services || typeof services !== 'object') return false;
		return Object.values(services).some((svc) => !!svc?.build);
	} catch {
		return false;
	}
}
