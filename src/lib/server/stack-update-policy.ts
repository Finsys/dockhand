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
	/** How far an update propagates beyond the changed service. */
	cascade: StackCascadeScope;
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
}

export function defaultStackUpdatePolicy(): StackUpdatePolicy {
	return { mode: 'recreate', cascade: 'false', noCache: false, exclude: [] };
}

/** True when the plan is the pre-#1539 behavior (no compose-level update work). */
export function isDefaultStackUpdatePlan(plan: StackUpdatePlan): boolean {
	return plan.mode === 'recreate' && plan.targets.length <= 1;
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

/** Read only the recognized keys of one `x-dockhand.update` block. */
function readUpdateBlock(raw: unknown): Partial<StackUpdatePolicy> {
	const block = asRecord(raw);
	if (!block) return {};
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

	const sameImage = (name: string): boolean => {
		const svc = parsed.services.find((s) => s.name === name);
		const a = normalizeImageRef(svc?.image);
		const b = normalizeImageRef(changedImage);
		return a !== '' && b !== '' && a === b;
	};

	const wholeStack = policy.mode === 'rebuild' || policy.cascade === 'all';

	let cascadeCandidates: string[] = [];
	if (wholeStack) {
		cascadeCandidates = known;
	} else if (policy.cascade === 'same-image') {
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
		mode: policy.mode,
		noCache: policy.noCache,
		wholeStack,
		targets,
		excludedServices: [...new Set(excludedServices)],
		skipped
	};
}
