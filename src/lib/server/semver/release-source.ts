/**
 * Resolve WHERE to fetch a container image's release notes from. Two forge
 * families share one release-notes shape and are handled here:
 *
 *  - GitHub          -> https://api.github.com/repos/<slug>/releases
 *  - Gitea / Forgejo -> https://<host>/api/v1/repos/<slug>/releases
 *    (Codeberg is a Forgejo instance; self-hosted Gitea/Forgejo work too.)
 *
 * Both return the same fields (`tag_name`, `name`, `body`, `published_at`,
 * `html_url`), so the fetch + version-match logic is identical - only the base
 * URL differs. Priority mirrors resolveChangelogUrl: the
 * `org.opencontainers.image.source` label wins, then a `ghcr.io/<owner>/<repo>`
 * image name (always GitHub).
 *
 * Pure, no I/O, unit-tested. Images with no recognizable source resolve to null
 * (we never guess a repo - a wrong repo is worse than no notes).
 */

const GHCR_PREFIX = 'ghcr.io/';

export type ForgeKind = 'github' | 'gitea';

export interface ReleaseSource {
	kind: ForgeKind;
	/** `owner/repo`. */
	slug: string;
	/** Fully-formed releases API base, ready for `?per_page`/`?limit` + `&page`. */
	apiBase: string;
	/** Human-facing releases page (for the "View releases" fallback link). */
	releasesUrl: string;
}

/** Pull `owner/repo` out of a forge URL, tolerating trailing slash / `.git`. */
function slugFromUrl(url: string, host: string): string | null {
	const idx = url.indexOf(host);
	if (idx === -1) return null;
	const after = url
		.slice(idx + host.length)
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.replace(/\.git$/, '');
	const parts = after.split('/');
	if (parts.length < 2 || !parts[0] || !parts[1]) return null;
	return `${parts[0]}/${parts[1]}`;
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

function stripImageTag(image: string): string {
	const atIdx = image.indexOf('@');
	const withoutDigest = atIdx >= 0 ? image.slice(0, atIdx) : image;
	const colonIdx = withoutDigest.lastIndexOf(':');
	if (colonIdx > withoutDigest.lastIndexOf('/')) {
		return withoutDigest.slice(0, colonIdx);
	}
	return withoutDigest;
}

export function resolveReleaseSource(
	imageName: string | null | undefined,
	labels?: Record<string, string> | null
): ReleaseSource | null {
	const source = labels?.['org.opencontainers.image.source'];
	if (source) {
		const host = hostOf(source);
		if (host === 'github.com') {
			const slug = slugFromUrl(source, 'github.com');
			if (slug) return githubSource(slug);
		} else if (host) {
			// Any other host is treated as a Gitea/Forgejo instance. Its releases
			// API is host-relative, so the notes come from the SAME host the image
			// declares (codeberg.org, gitea.com, a self-hosted forge, ...).
			const slug = slugFromUrl(source, host);
			if (slug) {
				return {
					kind: 'gitea',
					slug,
					apiBase: `https://${host}/api/v1/repos/${slug}/releases`,
					releasesUrl: `https://${host}/${slug}/releases`
				};
			}
		}
	}

	if (imageName && imageName.startsWith(GHCR_PREFIX)) {
		const repo = stripImageTag(imageName.slice(GHCR_PREFIX.length));
		const parts = repo.split('/');
		if (parts.length >= 2 && parts[0] && parts[1]) {
			return githubSource(`${parts[0]}/${parts[1]}`);
		}
	}

	return null;
}

function githubSource(slug: string): ReleaseSource {
	return {
		kind: 'github',
		slug,
		apiBase: `https://api.github.com/repos/${slug}/releases`,
		releasesUrl: `https://github.com/${slug}/releases`
	};
}
