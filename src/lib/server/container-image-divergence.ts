/**
 * Helpers for surfacing env/label divergence between a running
 * container and its image. Pure read-only — never used to mutate
 * the container; used only to power UI hints.
 *
 * Background: on update, Dockhand rebases env/labels onto the new image
 * (#1226, #1256) — image-baked values the user never overrode are refreshed
 * to the new image, while runtime `-e`/`-l` overrides are preserved (the
 * #1135 contract). See container-env-merge.ts.
 *
 * These helpers power a UI hint only: they report keys whose container value
 * differs from the image's CURRENT value. They compare container-vs-image at
 * display time and cannot themselves classify "user override vs stale
 * image-baked" (that needs the OLD image, captured only at update time), so
 * the hint's wording covers both cases.
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
