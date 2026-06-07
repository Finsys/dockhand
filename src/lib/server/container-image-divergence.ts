/**
 * Helpers for surfacing env/label divergence between a running
 * container and its image. Pure read-only — never used to mutate
 * the container; used only to power UI hints.
 *
 * Background: as of #1135 / commit 0f989bd7 revert, Dockhand no
 * longer "merges" image-baked env or labels into a container during
 * auto-update. The container's Config.Env and Config.Labels are
 * preserved verbatim (so a user's runtime `-e` / `-l` override is
 * never silently wiped). The trade-off, originally raised by #1061,
 * is that an image's updated default env/label values do not
 * automatically propagate to running containers.
 *
 * These helpers let the UI surface "this container's value differs
 * from the image's current value" so users can decide whether to
 * Remove & Deploy. We do NOT try to classify "user-set vs
 * image-baked" — that information isn't recoverable from Docker.
 */

/** Parse a Docker env list (`KEY=value` strings) into a Map. */
function parseEnv(entries: string[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const e of entries) {
		const i = e.indexOf('=');
		if (i === -1) {
			m.set(e, '');
		} else {
			m.set(e.slice(0, i), e.slice(i + 1));
		}
	}
	return m;
}

/**
 * Keys where the container's env value differs from the image's
 * CURRENT env value. Keys present in only one side are excluded —
 * they're either user-only or image-only, neither of which is
 * "divergence" we can usefully act on.
 */
export function detectImageEnvDivergence(
	containerEnv: string[],
	imageEnv: string[]
): string[] {
	const cont = parseEnv(containerEnv);
	const img = parseEnv(imageEnv);
	const diff: string[] = [];
	for (const [k, v] of cont) {
		if (img.has(k) && img.get(k) !== v) {
			diff.push(k);
		}
	}
	return diff;
}

/**
 * Keys where the container's label value differs from the image's
 * CURRENT label value. Same semantics as detectImageEnvDivergence.
 */
export function detectImageLabelDivergence(
	containerLabels: Record<string, string> | null | undefined,
	imageLabels: Record<string, string> | null | undefined
): string[] {
	const cont = containerLabels || {};
	const img = imageLabels || {};
	const diff: string[] = [];
	for (const [k, v] of Object.entries(cont)) {
		if (k in img && img[k] !== v) {
			diff.push(k);
		}
	}
	return diff;
}
