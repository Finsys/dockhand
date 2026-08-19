/**
 * Fetch per-version release notes from GitHub for the versions a semver check
 * surfaced. The match core (release-tag <-> wanted-version) is pure and unit-
 * tested; only the fetch touches the network. Degrades to an empty list on any
 * failure, so the modal always renders (it falls back to a plain link).
 */

import { parseTag, compareParts } from './tag-parser';
import type { ReleaseSource } from './release-source';

export interface ReleaseNote {
	/** The requested version tag this note is for, e.g. `16.4-alpine`. */
	version: string;
	/** The GitHub release name/title (may be empty). */
	name: string;
	/** The GitHub release tag, e.g. `v16.4`. */
	githubTag: string;
	/** Markdown body of the release. */
	body: string;
	/** ISO date the release was published. */
	publishedAt: string | null;
	/** Direct link to the release page. */
	url: string;
}

interface GithubRelease {
	tag_name: string;
	name: string | null;
	body: string | null;
	published_at: string | null;
	html_url: string;
	draft: boolean;
	prerelease: boolean;
}

/**
 * Pick, for each wanted version tag, the GitHub release whose tag parses to the
 * SAME numeric version. Pure: `releases` is whatever the API returned, `wanted`
 * is the list of image tags (target + skipped). Flavor/prefix noise is ignored —
 * only the numeric tuple has to match, so `v16.4` matches `16.4-alpine`.
 */
export function matchReleasesToVersions(
	releases: Pick<GithubRelease, 'tag_name' | 'name' | 'body' | 'published_at' | 'html_url'>[],
	wanted: string[]
): ReleaseNote[] {
	const notes: ReleaseNote[] = [];
	for (const version of wanted) {
		const parsedWanted = parseTag(version);
		if (!parsedWanted) continue;
		const match = releases.find((r) => {
			const parsedRelease = parseTag(r.tag_name);
			return parsedRelease && compareParts(parsedRelease, parsedWanted) === 0;
		});
		if (match) {
			notes.push({
				version,
				name: match.name ?? '',
				githubTag: match.tag_name,
				body: match.body ?? '',
				publishedAt: match.published_at,
				url: match.html_url
			});
		}
	}
	return notes;
}

const PER_PAGE = 100;
const MAX_PAGES = 3; // 300 recent releases is plenty to cover a handful of skipped versions.

/**
 * Fetch release notes for `wanted` versions from a GitHub or Gitea/Forgejo forge.
 * Both APIs return the same fields and page newest-first; only the page-size
 * query param differs (`per_page` vs `limit`). Walks pages until every wanted
 * version is matched or the page budget is spent. Never throws.
 */
export async function fetchReleaseNotes(
	src: ReleaseSource,
	wanted: string[],
	fetchImpl: typeof fetch = fetch
): Promise<ReleaseNote[]> {
	if (wanted.length === 0) return [];

	const pageSizeParam = src.kind === 'github' ? 'per_page' : 'limit';
	// Unauthenticated GitHub is 60 req/h per IP; a token raises it to 5000/h. Optional -
	// only sent to github.com, so a self-hoster who sets it gets far more headroom (and CI
	// stops rate-limiting). Never sent to a Gitea/Forgejo forge (different auth).
	const ghToken =
		src.kind === 'github'
			? (process.env.DOCKHAND_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim()
			: '';
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'User-Agent': 'dockhand'
	};
	if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

	const collected: GithubRelease[] = [];
	try {
		for (let page = 1; page <= MAX_PAGES; page++) {
			const url = `${src.apiBase}?${pageSizeParam}=${PER_PAGE}&page=${page}`;
			const res = await fetchImpl(url, { headers });
			if (!res.ok) break;
			const batch = (await res.json()) as GithubRelease[];
			if (!Array.isArray(batch) || batch.length === 0) break;
			collected.push(...batch.filter((r) => !r.draft));

			// Stop early once we can match everything we're after.
			const matched = matchReleasesToVersions(collected, wanted);
			if (matched.length >= wanted.length) break;
			if (batch.length < PER_PAGE) break;
		}
	} catch {
		return matchReleasesToVersions(collected, wanted);
	}

	return matchReleasesToVersions(collected, wanted);
}
