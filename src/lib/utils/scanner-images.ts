/**
 * The scanner images Dockhand pulls when nothing is configured.
 *
 * ONE place on purpose: the server defaults, the client store, the settings
 * placeholders and the environment form all read these, so they cannot disagree.
 *
 * Pinned rather than :latest so a scan is reproducible and a new upstream
 * release cannot change results underneath an install. Bumping them here is a
 * deliberate, reviewable act - and an install can override both in
 * Settings > General without waiting for a release.
 *
 * NOTE the tag styles differ upstream: grype prefixes v, trivy does not.
 */
export const DEFAULT_GRYPE_IMAGE = 'anchore/grype:v0.119.0';
export const DEFAULT_TRIVY_IMAGE = 'aquasec/trivy:0.75.0';

/** The repository half of an image reference, without the tag. */
export function imageRepo(image: string): string {
	const lastColon = image.lastIndexOf(':');
	// A registry port (registry:5000/repo) has a slash after its colon; that colon
	// is not a tag separator.
	if (lastColon === -1 || image.slice(lastColon).includes('/')) return image;
	return image.slice(0, lastColon);
}

/** The tag half of an image reference, defaulting to latest when it carries none. */
export function imageTag(image: string): string {
	const repo = imageRepo(image);
	return repo === image ? 'latest' : image.slice(repo.length + 1);
}

/**
 * The scanners as an inventory entry each: name and version follow the CONFIGURED
 * image, so an install on a mirror or a different pin is described as it really is.
 */
export function scannerToolInventory(grypeImage: string, trivyImage: string) {
	return [
		{
			name: imageRepo(grypeImage),
			version: imageTag(grypeImage),
			license: 'Apache-2.0',
			repository: 'https://github.com/anchore/grype'
		},
		{
			name: imageRepo(trivyImage),
			version: imageTag(trivyImage),
			license: 'Apache-2.0',
			repository: 'https://github.com/aquasecurity/trivy'
		}
	];
}
