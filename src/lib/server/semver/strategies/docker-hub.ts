/**
 * List tags from Docker Hub via its own tags API (not the Registry v2
 * `/tags/list`), ordered newest-first, so recent version tags land on the first
 * page or two.
 *
 * No server-side `name=` filter: Hub's `name` param is a SUBSTRING match, so
 * narrowing by the current major digit (e.g. `1` for `1.25`) would exclude a
 * clean newer major like `2.0` (no `1` in the name) and silently hide the single
 * most important upgrade. We page newest-first instead and let the pure
 * comparator pick the target.
 */

/** Newest-first pages; a few pages cover recent version tags across major lines. */
const MAX_PAGES = 3;
const PAGE_SIZE = 100;

interface HubTag {
	name: string;
}
interface HubTagsResponse {
	results?: HubTag[];
	next?: string | null;
}

/**
 * @param repo Full Hub repo path, e.g. `library/nginx` or `grafana/grafana`.
 */
export async function fetchDockerHubTags(repo: string): Promise<string[]> {
	const tags: string[] = [];

	for (let page = 1; page <= MAX_PAGES; page++) {
		const url = `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=${PAGE_SIZE}&page=${page}&ordering=last_updated`;
		const response = await fetch(url, { headers: { Accept: 'application/json' } });
		if (!response.ok) break;

		const data = (await response.json()) as HubTagsResponse;
		tags.push(...(data.results ?? []).map((t) => t.name));
		if (!data.next) break;
	}

	return tags;
}
