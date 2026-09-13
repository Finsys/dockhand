/**
 * List tags from any Registry HTTP API v2 host (Codeberg, GitLab, Harbor,
 * self-hosted, ...) via `/v2/<repo>/tags/list`, following the `Link: rel="next"`
 * header across pages so version tags aren't lost behind a first page full of
 * git-hash tags. Auth uses our shared WWW-Authenticate token flow, which also
 * works anonymously for public repos.
 */
import { getRegistryAuthHeader } from '../../docker';
import { isSafeRegistryHost } from '../../registry-auth';

/** Stop after this many pages — a guard against pathological repos, not a real limit. */
const MAX_PAGES = 50;
const PAGE_SIZE = 1000;

interface TagsListResponse {
	tags?: string[];
}

/** Parse `</v2/repo/tags/list?last=x&n=1000>; rel="next"` into the next path. */
function nextPagePath(linkHeader: string | null): string | null {
	const match = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
	return match ? match[1] : null;
}

export async function fetchGenericV2Tags(
	registry: string,
	repo: string,
	credentials?: { username: string; password: string } | null
): Promise<string[]> {
	// SSRF guard: `registry` comes from a user-controlled image reference. Block
	// loopback/metadata/reserved but allow LAN registries (self-hosted Harbor).
	if (!isSafeRegistryHost(registry).ok) return [];

	const base = `https://${registry}`;
	const authHeader = await getRegistryAuthHeader(base, `repository:${repo}:pull`, credentials ?? undefined);
	const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'Dockhand/1.0' };
	if (authHeader) headers['Authorization'] = authHeader;

	const tags: string[] = [];
	let path: string | null = `/v2/${repo}/tags/list?n=${PAGE_SIZE}`;

	for (let page = 0; page < MAX_PAGES && path; page++) {
		const response = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
		if (response.status >= 300 && response.status < 400) break; // don't follow a redirect off the guarded host
		if (!response.ok) break; // 4xx/5xx: stop with whatever we have.

		const data = (await response.json()) as TagsListResponse;
		tags.push(...(data.tags ?? []));
		path = nextPagePath(response.headers.get('link'));
	}

	return tags;
}
