/**
 * Resolve a changelog / release-notes URL for a container image (#538).
 *
 * Three tiers in priority order:
 *  1. `dockhand.changelog.url` label  — explicit override set by the image
 *     author or at runtime via `--label dockhand.changelog.url=…`. Wins over
 *     everything. Pattern matches the existing dockhand.* label convention.
 *     May contain `{{version}}` / `{{tag}}` placeholders (see interpolation
 *     below) to build a per-version link (e.g. a monorepo release stream like
 *     `.../releases/tag/transports/{{version}}`); a plain URL with no
 *     placeholders is returned verbatim, unchanged from before.
 *  2. `org.opencontainers.image.source` label — the OCI standard. When it
 *     points at github.com the canonical changelog page is `<source>/releases`.
 *  3. GHCR images — `ghcr.io/<owner>/<repo>` is always the same as
 *     `github.com/<owner>/<repo>`, so the release page is deterministic.
 *
 * No tier 3-style fuzzy match against Docker Hub. Wrong-repo matches are a
 * worse UX than no link, and there is no good answer for unlabelled
 * upstream images like `nginx:latest` (nginx's changelog isn't on GitHub).
 *
 * Pure function: deterministic, no I/O, safe to call from a render loop.
 */

const GITHUB_HOST = 'github.com';
const GHCR_PREFIX = 'ghcr.io/';

// The first dotted-number run in a tag, split into numeric parts. A local copy so
// this client-safe util needs no `$lib/server` import (SvelteKit forbids that in the
// browser). Deliberately minimal - only what the link-template placeholders need.
function versionPartsOf(tag: string): { version: string; parts: string[] } {
	const m = /\d+\.\d+(?:\.\d+)?(?:\.\d+)?/.exec(tag);
	if (!m) return { version: '', parts: [] };
	return { version: m[0], parts: m[0].split('.') };
}

/**
 * Substitute a link-template value's placeholders against a target tag. Supports
 * `${original}`/`${raw}`/`${transformed}` (the tag verbatim - no transform formula is
 * in scope here), `${version}`, and `${major}`/`${minor}`/`${patch}` read from it. A
 * placeholder whose value cannot be derived (the tag is not a version) is left empty.
 * Returns null when the tag is missing, so no half-built URL is offered.
 */
export function interpolateLinkTemplate(template: string, tag: string | null | undefined): string | null {
	if (!tag) return null;
	const { version, parts } = versionPartsOf(tag);
	const part = (i: number) => parts[i] ?? '';
	return template.replace(/\$\{\s*(original|raw|transformed|version|major|minor|patch|prerelease)\s*\}/gi, (_m, name: string) => {
		switch (name.toLowerCase()) {
			case 'original':
			case 'raw':
			case 'transformed':
				return tag;
			case 'version':
				return version;
			case 'major':
				return part(0);
			case 'minor':
				return part(1);
			case 'patch':
				return part(2);
			case 'prerelease': {
				const pr = /(?:^|[-.])(rc|beta|alpha|nightly|dev|pre|snapshot)[.\-]?\d*/i.exec(tag);
				return pr ? pr[0].replace(/^[-.]/, '') : '';
			}
			default:
				return '';
		}
	});
}

/**
 * Substitute `{{version}}` / `{{tag}}` (case-insensitive, whitespace-tolerant)
 * in a changelog-url override. Backward-compatible: a URL with NO placeholder is
 * returned unchanged, and if `version` is not supplied (e.g. the generic
 * "changelog" link on the container/stack list, which has no target version) the
 * template is left as-is so callers can decide - the plain-URL case is unaffected.
 */
export function interpolateChangelogUrl(url: string, version?: string | null): string {
	if (!version || !url.includes('{{')) return url;
	return url.replace(/\{\{\s*(version|tag)\s*\}\}/gi, version);
}

function stripTrailingSlash(s: string): string {
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

function stripImageTag(image: string): string {
	// "image@sha256:…" — split on @ first so we don't lose the digest fragment.
	const atIdx = image.indexOf('@');
	const withoutDigest = atIdx >= 0 ? image.slice(0, atIdx) : image;
	const colonIdx = withoutDigest.lastIndexOf(':');
	// A colon before a slash is a port in a registry hostname, not a tag.
	if (colonIdx > withoutDigest.lastIndexOf('/')) {
		return withoutDigest.slice(0, colonIdx);
	}
	return withoutDigest;
}

export function resolveChangelogUrl(
	imageName: string | null | undefined,
	labels?: Record<string, string> | null,
	version?: string | null
): string | null {
	if (!imageName) return null;

	const override = labels?.['dockhand.changelog.url'];
	if (override && override.trim()) return interpolateChangelogUrl(override.trim(), version);

	const source = labels?.['org.opencontainers.image.source'];
	if (source && source.includes(GITHUB_HOST)) {
		return stripTrailingSlash(source) + '/releases';
	}

	if (imageName.startsWith(GHCR_PREFIX)) {
		const repo = stripImageTag(imageName.slice(GHCR_PREFIX.length));
		// Sanity guard: GHCR images are always owner/repo. Single-segment values
		// like `ghcr.io/something` are malformed; skip rather than emit a bad URL.
		if (repo.split('/').length >= 2) {
			return `https://github.com/${repo}/releases`;
		}
	}

	// Last resort: a `wud.link.template` (or dockhand.link.template) label, so a
	// migrating install keeps its changelog links for Docker Hub images that carry
	// no derivable source. Its placeholders (${original}/${major}/...) resolve
	// against the target version.
	const template = firstLinkTemplate(labels);
	if (template) {
		return interpolateLinkTemplate(template, version);
	}

	return null;
}

/** Link-template label keys, native first - the order they are consulted in. */
const LINK_TEMPLATE_LABELS = [
	'dockhand.link.template',
	'wud.link.template',
	'wud/link.template',
	'getwud.app/link.template',
	'wud.getwud.io/link.template'
];

function firstLinkTemplate(labels?: Record<string, string> | null): string | undefined {
	if (!labels) return undefined;
	for (const key of LINK_TEMPLATE_LABELS) {
		const v = labels[key];
		if (typeof v === 'string' && v.trim()) return v.trim();
	}
	return undefined;
}
