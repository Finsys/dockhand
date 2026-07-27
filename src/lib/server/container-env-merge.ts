/**
 * Value-aware "rebase" of a container's env/labels onto a new image
 * during in-place update (#1226, #1256).
 *
 * Pure, dependency-free, unit-testable — no Docker, no node:http/fs — so
 * `bun test tests/unit/` can import it directly.
 *
 * Background: when Dockhand recreates a container on a new image it must
 * rebuild the create body from the OLD container's inspect. A container's
 * Config.Env / Config.Labels are FLATTENED at create time: image-baked
 * defaults and the user's runtime `-e`/`-l` overrides are indistinguishable.
 * Spreading them verbatim freezes the OLD image's defaults, so an image
 * that bumps a baked env (e.g. APP_VERSION) or an OCI label never takes
 * effect on update (#1226 / #1256).
 *
 * The recoverable signal is VALUE comparison against the OLD image:
 *   container[K] == oldImage[K]  -> image-baked, user never touched it -> adopt newImage[K]
 *   container[K] != oldImage[K]  -> user override                      -> keep container[K]
 *   K only in container          -> user-added                         -> keep container[K]
 *   K only in newImage           -> new image default                  -> add newImage[K]
 *
 * This is the #1135 merge corrected from key-membership to value-equality:
 * a user's override of a baked key (value differs) is preserved, while a
 * baked key the user never touched follows the new image. The caller must
 * fall back to verbatim when the old image can't be inspected.
 */

/**
 * The subset of an image's Config needed to rebase env/labels. Captured
 * from an image inspect BEFORE a new image is pulled (the old image may be
 * untagged/GC'd afterward and no longer inspectable).
 */
export interface ImageEnvLabels {
	Env?: string[];
	Labels?: Record<string, string>;
}

/**
 * Operational labels that must never be dropped by a rebase, even if a
 * future image happens to bake the same key. These are set by Docker
 * Compose / Dockhand and are load-bearing for stack association and
 * update tracking.
 */
function isProtectedLabel(key: string): boolean {
	return (
		key.startsWith('com.docker.compose.') ||
		key.startsWith('com.docker.stack.') ||
		key.startsWith('dockhand.') ||
		key.startsWith('dh.')
	);
}

/**
 * Sentinel for a bare env entry (`KEY` with no `=`), which Docker treats
 * as "inherit this var from the daemon environment" — semantically
 * distinct from `KEY=`. We keep it distinct so such entries round-trip
 * unchanged instead of being normalized to an empty value.
 */
const INHERIT = Symbol('inherit-from-daemon');
type EnvValue = string | typeof INHERIT;

/** Parse a Docker env list (`KEY=value` strings) into a Map (last wins). */
function parseEnv(entries: string[]): Map<string, EnvValue> {
	const m = new Map<string, EnvValue>();
	for (const e of entries) {
		const i = e.indexOf('=');
		if (i === -1) {
			m.set(e, INHERIT);
		} else {
			m.set(e.slice(0, i), e.slice(i + 1));
		}
	}
	return m;
}

/** Serialize one KEY/value pair back to a Docker env string. */
function toEnvString(key: string, value: EnvValue): string {
	return value === INHERIT ? key : `${key}=${value}`;
}

/**
 * Rebase a container's env onto the new image's defaults.
 *
 * Emits new-image defaults first (in new-image order), then any user
 * entries not already emitted (in container order). User values always
 * win over image defaults for the same key.
 */
export function rebaseEnvOntoImage(
	containerEnv: string[],
	oldImageEnv: string[],
	newImageEnv: string[]
): string[] {
	const container = parseEnv(containerEnv);
	const oldImage = parseEnv(oldImageEnv);
	const newImage = parseEnv(newImageEnv);

	// Recover the user layer: container entries that are NOT byte-identical
	// to an old-image default (differing value, or key absent from old image).
	const userLayer = new Map<string, EnvValue>();
	for (const [k, v] of container) {
		if (!oldImage.has(k) || oldImage.get(k) !== v) {
			userLayer.set(k, v);
		}
	}

	const out: string[] = [];
	const emitted = new Set<string>();

	// New image defaults as the base, unless the user overrode that key.
	for (const [k, v] of newImage) {
		if (userLayer.has(k)) {
			out.push(toEnvString(k, userLayer.get(k)!));
		} else {
			out.push(toEnvString(k, v));
		}
		emitted.add(k);
	}

	// User entries for keys the new image doesn't define (user-only / kept overrides).
	for (const [k, v] of userLayer) {
		if (!emitted.has(k)) {
			out.push(toEnvString(k, v));
			emitted.add(k);
		}
	}

	return out;
}

/** Human-readable breakdown of what a rebase changed, for logging/UI. */
export interface RebaseSummary {
	/** Keys whose value now follows the new image (image-baked, user untouched). */
	adopted: string[];
	/** Keys where the user's override was preserved (value differs from old image). */
	preserved: string[];
	/** Keys present only on the container (user-added, not in either image). */
	userOnly: string[];
}

/**
 * Classify how each ENV key was treated by the rebase. Pure; safe to call
 * with the same inputs passed to rebaseEnvOntoImage.
 */
export function describeEnvRebase(
	containerEnv: string[],
	oldImageEnv: string[],
	newImageEnv: string[]
): RebaseSummary {
	const container = parseEnv(containerEnv);
	const oldImage = parseEnv(oldImageEnv);
	const newImage = parseEnv(newImageEnv);

	const adopted: string[] = [];
	const preserved: string[] = [];
	const userOnly: string[] = [];

	for (const [k, v] of container) {
		const isUser = !oldImage.has(k) || oldImage.get(k) !== v;
		if (isUser) {
			if (newImage.has(k) || oldImage.has(k)) preserved.push(k);
			else userOnly.push(k);
		} else if (newImage.has(k) && newImage.get(k) !== oldImage.get(k)) {
			// Image-baked, user untouched, and the new image changed the value.
			adopted.push(k);
		}
	}
	// Keys the new image introduces that the container never had.
	for (const k of newImage.keys()) {
		if (!container.has(k)) adopted.push(k);
	}

	return { adopted, preserved, userOnly };
}

/**
 * Classify how each LABEL key was treated by the rebase. Protected
 * operational labels are reported as preserved.
 */
export function describeLabelRebase(
	containerLabels: Record<string, string> | null | undefined,
	oldImageLabels: Record<string, string> | null | undefined,
	newImageLabels: Record<string, string> | null | undefined
): RebaseSummary {
	const container = containerLabels || {};
	const oldImage = oldImageLabels || {};
	const newImage = newImageLabels || {};

	const adopted: string[] = [];
	const preserved: string[] = [];
	const userOnly: string[] = [];

	for (const [k, v] of Object.entries(container)) {
		const isUser = isProtectedLabel(k) || !(k in oldImage) || oldImage[k] !== v;
		if (isUser) {
			if (k in newImage || k in oldImage) preserved.push(k);
			else userOnly.push(k);
		} else if (k in newImage && newImage[k] !== oldImage[k]) {
			adopted.push(k);
		}
	}
	for (const k of Object.keys(newImage)) {
		if (!(k in container)) adopted.push(k);
	}

	return { adopted, preserved, userOnly };
}

/**
 * Rebase a container's labels onto the new image's defaults. Same
 * value-aware logic as env, plus operational labels (compose/dockhand)
 * are always preserved from the container.
 */
export function rebaseLabelsOntoImage(
	containerLabels: Record<string, string> | null | undefined,
	oldImageLabels: Record<string, string> | null | undefined,
	newImageLabels: Record<string, string> | null | undefined
): Record<string, string> {
	const container = containerLabels || {};
	const oldImage = oldImageLabels || {};
	const newImage = newImageLabels || {};

	// User layer: container labels that differ from (or are absent in) the old image.
	const userLayer: Record<string, string> = {};
	for (const [k, v] of Object.entries(container)) {
		if (!(k in oldImage) || oldImage[k] !== v) {
			userLayer[k] = v;
		}
	}

	// Base = new image defaults, user layer wins.
	const out: Record<string, string> = { ...newImage, ...userLayer };

	// Force-preserve operational labels from the container regardless of the image.
	for (const [k, v] of Object.entries(container)) {
		if (isProtectedLabel(k)) {
			out[k] = v;
		}
	}

	return out;
}
