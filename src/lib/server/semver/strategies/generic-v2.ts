/**
 * List tags from any Registry HTTP API v2 host (Codeberg, GitLab, Harbor,
 * self-hosted, ...) via `/v2/<repo>/tags/list`, following the `Link: rel="next"`
 * header across pages so version tags aren't lost behind a first page full of
 * git-hash tags. Auth uses our shared WWW-Authenticate token flow, which also
 * works anonymously for public repos.
 */
import { getRegistryAuthHeader } from '../../docker';
import { isSafeRegistryHost } from '../../registry-auth';
import type { TagList } from '../tag-source-core';
import { registryRequestSignal } from '../../registry/request-timeout';
import { forgetRegistryAuth } from '../../registry/auth-cache';

/** Pages read from each starting point; a guard against pathological repos. */
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

/** One paged read; a failed one records the status and the page (0 = first) it stopped on. */
interface Read {
	tags: string[];
	ok: boolean;
	cut: boolean;
	failedStatus?: number;
	failedPage?: number;
}

async function readTags(registry: string, repo: string, credentials: { username: string; password: string } | null | undefined, after?: string): Promise<Read | null> {
	// SSRF guard: `registry` comes from a user-controlled image reference. Block
	// loopback/metadata/reserved but allow LAN registries (self-hosted Harbor).
	if (!isSafeRegistryHost(registry).ok) return null;

	const base = `https://${registry}`;
	const authHeader = await getRegistryAuthHeader(base, `repository:${repo}:pull`, credentials ?? undefined, registryRequestSignal());
	const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'Dockhand/1.0' };
	if (authHeader) headers['Authorization'] = authHeader;

	const tags: string[] = [];
	let path: string | null = `/v2/${repo}/tags/list?n=${PAGE_SIZE}` + (after ? `&last=${encodeURIComponent(after)}` : '');
	for (let page = 0; page < MAX_PAGES && path; page++) {
		const response = await fetch(`${base}${path}`, { headers, redirect: 'manual', signal: registryRequestSignal() });
		// A redirect (never followed off the guarded host) or a 4xx/5xx ends the read.
		if (!response.ok) {
			if (response.status === 401) forgetRegistryAuth(authHeader, registry);
			return { tags, ok: false, cut: false, failedStatus: response.status, failedPage: page };
		}
		const data = (await response.json()) as TagsListResponse;
		tags.push(...(data.tags ?? []));
		path = nextPagePath(response.headers.get('link'));
	}
	if (path) console.warn(`[Semver] Tag list for ${registry}/${repo}${after ? ` after ${after}` : ''} stopped at ${MAX_PAGES} pages; a newer version past them is not seen`);
	return { tags, ok: true, cut: path !== null };
}

/** Every tag from the start, in the registry's order. Stopping at the cap is the guard
 *  doing its job: listing again soon would stop there too, so it counts as complete. */
export async function fetchGenericV2Tags(
	registry: string,
	repo: string,
	credentials?: { username: string; password: string } | null
): Promise<TagList> {
	const read = await readTags(registry, repo, credentials);
	return read ? { tags: read.tags, complete: read.ok } : { tags: [], complete: true };
}

/**
 * The tags after `after` (the running tag). GHCR lists in push order and takes `last` as a
 * cursor in that order, so these are the tags pushed after the running one - where a
 * release lives in a repo of 200k CI tags that a listing from the start never reaches. A
 * spec registry answers with the tags named after it. A registry whose `last` is an opaque
 * token (ECR: 405) rejects a tag name on the first page; that is a permanent answer, not a
 * failed read, so it yields nothing and counts as complete.
 */
export async function fetchGenericV2TagsAfter(
	registry: string,
	repo: string,
	credentials: { username: string; password: string } | null | undefined,
	after: string
): Promise<TagList> {
	const read = await readTags(registry, repo, credentials, after);
	if (!read) return { tags: [], complete: true };
	const unsupported = !read.ok && read.failedPage === 0 && read.failedStatus !== undefined &&
		read.failedStatus >= 400 && read.failedStatus < 500 && read.failedStatus !== 429;
	if (unsupported) return { tags: [], complete: true };
	return { tags: read.tags, complete: read.ok };
}
