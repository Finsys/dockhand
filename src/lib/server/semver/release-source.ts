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
 * Pure, no I/O, unit-tested. `resolveReleaseSource` returns only a CONFIDENT source
 * (label or ghcr name) or null - it never guesses. `resolveReleaseSourceCandidates`
 * additionally offers GUESSED fallbacks (image name / other labels) that the caller
 * must validate against the wanted version before trusting (a wrong repo is worse
 * than no notes).
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
	/** True for a GUESSED source (image name / a non-source label). A guessed repo is
	 *  only trusted once the API confirms a release matching the wanted version -
	 *  the caller drops it if no note matches (a wrong repo is worse than no notes). */
	needsValidation?: boolean;
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

/** Pull an `owner/repo` slug from a github.com or ghcr.io URL anywhere in a string. */
function githubSlugFromText(text: string): string | null {
	const m = text.match(/(?:github\.com|ghcr\.io)\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/);
	if (!m || !m[1] || !m[2]) return null;
	return `${m[1].toLowerCase()}/${m[2].replace(/\.git$/, '').toLowerCase()}`;
}

/** `owner/repo` from an image name, stripping registry host, tag and digest. */
function slugFromImageName(imageName: string): string | null {
	const repo = stripImageTag(imageName);
	const parts = repo.split('/');
	// Drop a leading registry host segment (has a dot or a port), e.g. ghcr.io, docker.io.
	if (parts.length > 2 && /[.:]/.test(parts[0])) parts.shift();
	if (parts.length < 2 || !parts[0] || !parts[1]) return null;
	return `${parts[0]}/${parts[1]}`;
}

/**
 * Resolve release-note sources for an image, best-first. The first entry (if any)
 * is the CONFIDENT source (`org.opencontainers.image.source` label, or a ghcr image
 * name). Any following entries are GUESSED fallbacks (`needsValidation: true`), used
 * only when no confident source exists: an `owner/repo` slug taken from the image
 * name treated as a GitHub repo, and any github.com / ghcr.io URL found in OTHER
 * labels/annotations. Guessed candidates are deduped, capped (a crafted label set
 * must not fan out into many outbound API calls), and must be validated by the
 * caller (a release tag matching the wanted version) before their notes are shown.
 */
export function resolveReleaseSourceCandidates(
	imageName: string | null | undefined,
	labels?: Record<string, string> | null
): ReleaseSource[] {
	const confident = resolveReleaseSource(imageName, labels);
	if (confident) return [confident];

	// Cap guessed candidates: each becomes one outbound GitHub API call at fetch time,
	// and a container can carry arbitrarily many labels, so a crafted label set must
	// not amplify into a fan-out. The real source is almost always the first one or two.
	const MAX_GUESSES = 5;
	const seen = new Set<string>();
	const candidates: ReleaseSource[] = [];
	const add = (slug: string | null) => {
		if (!slug || candidates.length >= MAX_GUESSES) return;
		const key = slug.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push({ ...githubSource(key), needsValidation: true });
	};

	// (a) owner/repo from the image name, as a GitHub repo (covers Docker Hub
	//     images whose name mirrors their GitHub slug, e.g. grafana/grafana).
	if (imageName) add(slugFromImageName(imageName));

	// (b) any github.com / ghcr.io URL in a NON-source label or annotation
	//     (url, documentation, vendor-specific), first match per label.
	if (labels) {
		for (const [k, v] of Object.entries(labels)) {
			if (k === 'org.opencontainers.image.source' || !v) continue;
			add(githubSlugFromText(v));
		}
	}

	return candidates;
}

function githubSource(slug: string): ReleaseSource {
	return {
		kind: 'github',
		slug,
		apiBase: `https://api.github.com/repos/${slug}/releases`,
		releasesUrl: `https://github.com/${slug}/releases`
	};
}
