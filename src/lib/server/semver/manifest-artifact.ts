/**
 * Classify a registry manifest as a runnable container image vs a non-image OCI
 * artifact (Helm chart, SBOM, signature, ...). Monorepos increasingly publish
 * Helm charts into the SAME repo as their images (e.g. `maximhq/bifrost` ships
 * chart tag `2.1.29` alongside image tag `v1.6.11`), so the semver check must not
 * offer a chart tag as a "newer version" of an image.
 *
 * Pure: takes the already-parsed manifest JSON, no I/O. The fetch lives in
 * docker.ts; this just reads the media types.
 */

export type ArtifactKind = 'image' | 'chart' | 'other';

/** config.mediaType values that mean "this is a real container image config". */
const IMAGE_CONFIG_TYPES = new Set([
	'application/vnd.oci.image.config.v1+json',
	'application/vnd.docker.container.image.v1+json'
]);

/** Helm's OCI chart config media type. */
const HELM_CONFIG_TYPE = 'application/vnd.cncf.helm.config.v1+json';

/** Manifest LIST / image INDEX media types - a multi-arch image points here. */
const INDEX_TYPES = new Set([
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json'
]);

/** Single-image manifest media types. */
const IMAGE_MANIFEST_TYPES = new Set([
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json'
]);

/**
 * Classify a manifest body (parsed JSON). `topMediaType` is the manifest's own
 * media type when known (from the response Content-Type or a `mediaType` field);
 * an image index has no `config`, so it is recognized by that type alone.
 *
 * - A manifest INDEX / manifest LIST is always a multi-arch IMAGE.
 * - Otherwise the `config.mediaType` decides: Helm config -> chart, image config
 *   -> image, anything else -> other (SBOM, signature, unknown artifact).
 * - Unknown / missing info defaults to 'image' (fail-open: never hide a real
 *   update just because a registry omitted a field).
 */
export function classifyManifest(
	manifest: { mediaType?: string; config?: { mediaType?: string }; manifests?: unknown[] } | null | undefined,
	topMediaType?: string | null
): ArtifactKind {
	if (!manifest) return 'image';

	const top = manifest.mediaType || topMediaType || '';
	if (INDEX_TYPES.has(top) || Array.isArray(manifest.manifests)) return 'image';

	const cfg = manifest.config?.mediaType;
	if (cfg === HELM_CONFIG_TYPE) return 'chart';
	if (cfg && IMAGE_CONFIG_TYPES.has(cfg)) return 'image';

	// A recognized single-image manifest type with no/other config is still an image.
	if (IMAGE_MANIFEST_TYPES.has(top)) return 'image';

	// A config media type we don't recognize, on a non-index manifest, is a
	// non-image artifact (chart variants, SBOM, cosign signature, ...).
	if (cfg) return 'other';

	return 'image';
}

/** True only for a runnable container image (multi-arch index or single image). */
export function isRunnableImage(
	manifest: { mediaType?: string; config?: { mediaType?: string }; manifests?: unknown[] } | null | undefined,
	topMediaType?: string | null
): boolean {
	return classifyManifest(manifest, topMediaType) === 'image';
}
