/**
 * Stack-level update policy (#1539).
 *
 * A declarative per-stack update policy read from compose metadata: a top-level
 * `x-dockhand.update` block plus optional per-service `x-dockhand.update`
 * overrides. Compose preserves `x-` extension fields through `config`
 * round-trips and vanilla `compose up` ignores them, so the policy is
 * version-controlled and travels with the stack definition.
 *
 * This module is intentionally PURE (js-yaml only, no db/docker imports) so the
 * parsing and the cascade decision are unit-testable without a daemon.
 *
 * Absence of the block is the back-compat default: `recreate` + no cascade,
 * which is byte-identical to the pre-#1539 auto-update.
 *
 *   x-dockhand:
 *     update:
 *       mode: rebuild          # recreate (default) | build | rebuild
 *       cascade: same-image    # false (default) | same-image | all
 *       no-cache: true         # optional, only meaningful with build/rebuild
 *       exclude: [db, redis]   # services never touched by a cascade
 *
 *   services:
 *     worker:
 *       x-dockhand:
 *         update:
 *           mode: rebuild      # per-service override wins over the stack default
 */

import jsyaml from 'js-yaml';

export type StackUpdateMode = 'recreate' | 'build' | 'rebuild';
export type StackCascadeScope = 'false' | 'same-image' | 'all';

export interface StackUpdatePolicy {
	/** What "apply an update" does for the changed service. */
	mode: StackUpdateMode;
	/**
	 * How far an update propagates beyond the changed service. UNDEFINED when the
	 * compose block did not specify it: only an unspecified cascade lets `mode: rebuild`
	 * imply "whole stack", so an explicit `cascade: false` can restrain a rebuild. (#1539 review)
	 */
	cascade?: StackCascadeScope;
	/** Pass `--no-cache` to builds (build/rebuild modes only). */
	noCache: boolean;
	/** Services that a cascade must never redeploy. Always wins over the scope. */
	exclude: string[];
}

export interface StackServicePolicyInfo {
	name: string;
	/** The service's `image:` value, verbatim (may contain `${...}` interpolation). */
	image?: string;
	/** Whether the service declares a build context (`build:` / `dockerfile_inline`). */
	hasBuild: boolean;
	/** ONLY the fields explicitly present in the service's own x-dockhand block. */
	override: Partial<StackUpdatePolicy>;
}

export interface ParsedStackUpdatePolicy {
	stack: StackUpdatePolicy;
	services: StackServicePolicyInfo[];
	/** True when the compose file could not be parsed (policy falls back to defaults). */
	unparseable: boolean;
}

export interface StackUpdatePlan {
	/** Effective mode for the changed service (per-service override applied). */
	mode: StackUpdateMode;
	/** Effective no-cache flag for the changed service. */
	noCache: boolean;
	/** True when the whole stack (minus excluded services) is rebuilt. */
	wholeStack: boolean;
	/**
	 * Services for `docker compose up`: the changed service first, then any
	 * cascade targets, with excluded services removed. Empty means "all services"
	 * is never produced here — the changed service is always present.
	 */
	targets: string[];
	/** Services protected by `exclude` that a cascade would otherwise have touched. */
	excludedServices: string[];
	/** Per-service skips to report in the execution history. */
	skipped: { service: string; reason: string }[];
	/**
	 * Set when the requested mode was degraded because it could not be honoured (e.g.
	 * `mode: build` on a service with no build context). Reported so the run never
	 * claims a build/recreate it did not perform. (#1539 review)
	 */
	modeDegraded?: { from: StackUpdateMode; reason: string };
}

export function defaultStackUpdatePolicy(): StackUpdatePolicy {
	// No `cascade` key: undefined means "not specified" (see the interface).
	return { mode: 'recreate', noCache: false, exclude: [] };
}

/** True when the plan is the pre-#1539 behavior (no compose-level update work). */
export function isDefaultStackUpdatePlan(plan: StackUpdatePlan): boolean {
	return plan.mode === 'recreate' && plan.targets.length <= 1;
}

/**
 * Build/rebuild modes produce the image from the compose build context and apply
 * it through `docker compose up`. The auto-update task's temp-tag scan flow only
 * ever sees images pulled from a registry, so a built image would be deployed with
 * no vulnerability gating at all. When a gate is configured (`criteria` other than
 * `never`), the caller must refuse the build/rebuild plan rather than deploy an
 * unscanned image — and record the run as skipped, never as a satisfied gate. (#1539 review)
 */
export function buildModeBlockedByVulnerabilityGate(
	mode: StackUpdateMode,
	criteria: string
): boolean {
	const buildMode = mode === 'build' || mode === 'rebuild';
	return buildMode && criteria !== 'never';
}

/**
 * Apply the `wasRunning` guard to a cascade: the Docker-API path never restarts a
 * deliberately-stopped container, but `docker compose up --force-recreate` does. Keep
 * only services that are currently running — plus the changed service, which IS the
 * update — and report the stopped ones as skipped instead of resurrecting them. (#1539 review)
 */
export function filterCascadeTargetsToRunning(
	targets: string[],
	changedService: string,
	running: ReadonlySet<string>
): { targets: string[]; stopped: string[] } {
	const kept: string[] = [];
	const stopped: string[] = [];
	for (const t of targets) {
		if (t === changedService || running.has(t)) kept.push(t);
		else stopped.push(t);
	}
	return { targets: kept, stopped };
}

// =============================================================================
// PARSING (tolerant: a bad value degrades to the default, never throws)
// =============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function normalizeMode(value: unknown): StackUpdateMode | undefined {
	if (typeof value !== 'string') return undefined;
	const v = value.trim().toLowerCase();
	return v === 'recreate' || v === 'build' || v === 'rebuild' ? v : undefined;
}

function normalizeCascade(value: unknown): StackCascadeScope | undefined {
	if (value === false) return 'false';
	if (typeof value !== 'string') return undefined;
	const v = value.trim().toLowerCase();
	return v === 'false' || v === 'same-image' || v === 'all' ? v : undefined;
}

function normalizeNoCache(value: unknown): boolean | undefined {
	if (value === true || value === false) return value;
	if (typeof value !== 'string') return undefined;
	const v = value.trim().toLowerCase();
	if (v === 'true' || v === 'yes' || v === '1') return true;
	if (v === 'false' || v === 'no' || v === '0') return false;
	return undefined;
}

function normalizeExclude(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

/**
 * `exclude` is the protective field of the policy: dropping a malformed value while
 * `cascade` survives would fail OPEN (the cascade runs, the guard is gone). So any
 * present-but-invalid `exclude` rejects the WHOLE block, falling back to defaults
 * instead of silently applying a weaker policy. A string list is the only valid form. (#1539 review)
 */
function isValidExclude(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Read only the recognized keys of one `x-dockhand.update` block. */
function readUpdateBlock(raw: unknown): Partial<StackUpdatePolicy> {
	const block = asRecord(raw);
	if (!block) return {};
	// A present-but-invalid `exclude` rejects the entire block (fail safe, never open).
	const excludeRaw = block.exclude;
	if (excludeRaw !== undefined && excludeRaw !== null && !isValidExclude(excludeRaw)) {
		return {};
	}
	const out: Partial<StackUpdatePolicy> = {};
	// YAML allows `no-cache`; accept `noCache` too (either spelling).
	const mode = normalizeMode(block.mode);
	if (mode) out.mode = mode;
	const cascade = normalizeCascade(block.cascade);
	if (cascade) out.cascade = cascade;
	const noCache = normalizeNoCache(block['no-cache'] ?? block.noCache);
	if (noCache !== undefined) out.noCache = noCache;
	const exclude = normalizeExclude(block.exclude);
	if (exclude) out.exclude = exclude;
	return out;
}

/** The `update:` sub-block of an `x-dockhand` extension block, if present. */
function readXdockhandUpdate(extension: unknown): Partial<StackUpdatePolicy> {
	const ext = asRecord(extension);
	if (!ext) return {};
	return readUpdateBlock(ext.update);
}

/**
 * Parse a compose file's x-dockhand update policy. Never throws: invalid YAML
 * or malformed blocks degrade to the default policy (back-compat first).
 */
export function parseStackUpdatePolicy(composeContent: string): ParsedStackUpdatePolicy {
	const defaults = defaultStackUpdatePolicy();
	let doc: Record<string, unknown> | null = null;
	try {
		const loaded = jsyaml.load(composeContent);
		doc = asRecord(loaded);
	} catch {
		return { stack: defaults, services: [], unparseable: true };
	}
	if (!doc) {
		return { stack: defaults, services: [], unparseable: true };
	}

	const stack: StackUpdatePolicy = { ...defaults, ...readXdockhandUpdate(doc['x-dockhand']) };

	const servicesRaw = asRecord(doc.services);
	const services: StackServicePolicyInfo[] = [];
	if (servicesRaw) {
		for (const [name, rawSvc] of Object.entries(servicesRaw)) {
			const svc = asRecord(rawSvc);
			if (!svc) continue;
			services.push({
				name,
				image: typeof svc.image === 'string' ? svc.image : undefined,
				hasBuild: svc.build !== undefined && svc.build !== null && svc.build !== false,
				override: readXdockhandUpdate(svc['x-dockhand'])
			});
		}
	}

	return { stack, services, unparseable: false };
}

/** Merge the stack default with a service's own override (override wins). */
export function resolveServicePolicy(
	parsed: ParsedStackUpdatePolicy,
	serviceName: string
): StackUpdatePolicy {
	const svc = parsed.services.find((s) => s.name === serviceName);
	return { ...parsed.stack, ...(svc?.override ?? {}) };
}

export function serviceHasBuildContext(
	parsed: ParsedStackUpdatePolicy,
	serviceName: string
): boolean {
	return parsed.services.find((s) => s.name === serviceName)?.hasBuild ?? false;
}

/**
 * Normalize an image reference for same-image comparison: drop the digest, treat
 * an absent/`latest` tag as implicit, and strip the default registry + library
 * namespace so `nginx`, `nginx:latest`, and `docker.io/library/nginx:latest`
 * all compare equal.
 */
export function normalizeImageRef(ref: string | undefined | null): string {
	if (!ref) return '';
	let s = ref.trim();
	const at = s.indexOf('@');
	if (at !== -1) s = s.slice(0, at);
	const lastSlash = s.lastIndexOf('/');
	const lastColon = s.lastIndexOf(':');
	let repo = s;
	let tag = '';
	if (lastColon > lastSlash) {
		repo = s.slice(0, lastColon);
		tag = s.slice(lastColon + 1);
	}
	repo = repo
		.replace(/^index\.docker\.io\//, '')
		.replace(/^registry-1\.docker\.io\//, '')
		.replace(/^docker\.io\//, '')
		.replace(/^library\//, '');
	if (!tag || tag === 'latest') return repo;
	return `${repo}:${tag}`;
}

/**
 * Decide what an update to `changedService` should do under the stack's policy.
 *
 * `exclude` always wins for CASCADE targets; the directly-updated service is
 * never excluded from its own update. Rebuild mode and `cascade: all` both mean
 * "the whole stack (minus exclude)", which is expressed as an explicit target
 * list so excluded services are genuinely skipped.
 */
export function planStackUpdate(
	parsed: ParsedStackUpdatePolicy,
	changedService: string,
	changedImage?: string
): StackUpdatePlan {
	const policy = resolveServicePolicy(parsed, changedService);
	const known = parsed.services.map((s) => s.name);
	const excluded = new Set(policy.exclude);

	// An explicit `cascade` always wins; only an unspecified one lets `mode: rebuild`
	// imply "whole stack". This is what lets `cascade: false` restrain a rebuild. (#1539 review)
	const cascadeScope = policy.cascade;

	// build/rebuild only make sense for a service with a build context: otherwise the plan
	// would report success while `up --build` builds nothing. Degrade to recreate (a real
	// registry update) and record why. (#1539 review)
	let mode = policy.mode;
	let modeDegraded: StackUpdatePlan['modeDegraded'];
	if ((mode === 'build' || mode === 'rebuild') && !serviceHasBuildContext(parsed, changedService)) {
		modeDegraded = { from: mode, reason: 'service has no build context' };
		mode = 'recreate';
	}

	const sameImage = (name: string): boolean => {
		const svc = parsed.services.find((s) => s.name === name);
		const a = normalizeImageRef(svc?.image);
		const b = normalizeImageRef(changedImage);
		return a !== '' && b !== '' && a === b;
	};

	const wholeStack = cascadeScope === 'all' || (mode === 'rebuild' && cascadeScope === undefined);

	let cascadeCandidates: string[] = [];
	if (wholeStack) {
		cascadeCandidates = known;
	} else if (cascadeScope === 'same-image') {
		cascadeCandidates = known.filter((n) => sameImage(n));
	}

	// Exclude always wins for cascaded services (never for the changed service itself).
	const cascade = cascadeCandidates.filter((n) => n !== changedService && !excluded.has(n));
	const excludedServices = cascadeCandidates.filter((n) => n !== changedService && excluded.has(n));

	const targets = [changedService, ...cascade];
	const skipped = [
		...new Set(excludedServices.filter((n) => !targets.includes(n)))
	].map((service) => ({ service, reason: 'excluded' }));

	return {
		mode,
		noCache: policy.noCache,
		wholeStack,
		targets,
		excludedServices: [...new Set(excludedServices)],
		skipped,
		...(modeDegraded ? { modeDegraded } : {})
	};
}

/**
 * Turn a plan into the exact compose invocation plus the truthful skip record for the
 * apply path. Pure, so the apply decision is unit-testable without a daemon (#1539 review):
 * - stopped cascade targets are dropped so `--force-recreate` cannot resurrect a service
 *   the operator deliberately stopped (the Docker-API path's `wasRunning` equivalent),
 * - the auto-update path never removes orphans and never starts dependencies,
 * - build / no-cache / force-recreate flags are derived once, consistently.
 */
export function decideStackApply(input: {
	plan: StackUpdatePlan;
	changedService: string;
	buildFromContext: boolean;
	running: ReadonlySet<string>;
}): {
	apply: boolean;
	targets: string[];
	serviceNames: string[];
	build: boolean;
	noBuildCache: boolean;
	forceRecreate: boolean;
	skipped: { service: string; reason: string }[];
} {
	const { plan, changedService, buildFromContext, running } = input;
	if (isDefaultStackUpdatePlan(plan)) {
		return { apply: false, targets: [], serviceNames: [], build: false, noBuildCache: false, forceRecreate: false, skipped: [] };
	}
	const filtered = plan.targets.length > 1
		? filterCascadeTargetsToRunning(plan.targets, changedService, running)
		: { targets: plan.targets, stopped: [] as string[] };
	const build = plan.mode === 'build' || plan.mode === 'rebuild';
	return {
		apply: true,
		targets: filtered.targets,
		serviceNames: filtered.targets.slice(1),
		build,
		noBuildCache: plan.noCache && build,
		forceRecreate: !buildFromContext && filtered.targets.length > 1,
		skipped: [...plan.skipped, ...filtered.stopped.map((service) => ({ service, reason: 'stopped' }))]
	};
}
