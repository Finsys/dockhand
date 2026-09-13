/**
 * "Details" links for Lissy93 portainer-templates (#1211).
 *
 * The community site portainer-templates.as93.net renders a rich per-template page
 * for the Lissy93 catalog, but its URL slug is NOT a plain kebab of the title (it
 * strips ALL non-alphanumerics inside a word: `Pi-Hole` -> `pihole`,
 * `Pi-Hole-Unbound` -> `piholeunbound`). We can GUESS a slug that matches ~96% of
 * titles, so to avoid dead links we treat the site's own sitemap as the source of
 * truth: emit a Details link ONLY when the guessed slug actually exists there.
 * The 4% we can't match simply get no Details link (never a wrong one).
 */

const SITEMAP_URL = 'https://portainer-templates.as93.net/sitemap.xml';
const BASE_URL = 'https://portainer-templates.as93.net';
const CACHE_TTL = 24 * 60 * 60 * 1000; // slugs change rarely; refresh daily

let cache: { slugs: Set<string>; fetchedAt: number } | null = null;
let inflight: Promise<Set<string>> | null = null;

/** Test-only: clear the in-memory slug cache so a test starts from a cold state. */
export function __resetAs93Cache(): void {
	cache = null;
	inflight = null;
}

/**
 * Build the candidate slug the way as93.net does: split on whitespace, strip every
 * non-alphanumeric from each word, lowercase, join with '-'. Pure + unit-tested.
 * This is only a CANDIDATE - it must be confirmed against the sitemap before use.
 */
export function slugifyTitle(title: string): string {
	return title
		.split(/\s+/)
		.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
		.filter(Boolean)
		.join('-');
}

/** Parse `<loc>https://portainer-templates.as93.net/<slug></loc>` entries into a Set. */
export function parseSitemapSlugs(xml: string): Set<string> {
	const slugs = new Set<string>();
	for (const m of xml.matchAll(/portainer-templates\.as93\.net\/([a-z0-9-]+)/g)) {
		if (m[1]) slugs.add(m[1]);
	}
	return slugs;
}

/** Fetch + cache the sitemap slug set (in-memory, 24h). Never throws; empty on failure. */
export async function getAs93Slugs(fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
	if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) return cache.slugs;
	if (inflight) return inflight;

	inflight = (async () => {
		try {
			const res = await fetchImpl(SITEMAP_URL, {
				headers: { Accept: 'application/xml' },
				redirect: 'manual',
				signal: AbortSignal.timeout(15000)
			});
			if (!res.ok) return cache?.slugs ?? new Set<string>();
			const slugs = parseSitemapSlugs(await res.text());
			// Only replace the cache on a non-empty parse - a transient bad body must
			// not wipe a good set and drop every Details link.
			if (slugs.size > 0) cache = { slugs, fetchedAt: Date.now() };
			return cache?.slugs ?? slugs;
		} catch {
			return cache?.slugs ?? new Set<string>();
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

/**
 * The as93.net details URL for a template title, or null when the guessed slug is
 * not in the sitemap (so we never emit a dead link). Pure lookup against a slug set
 * the caller loaded once via getAs93Slugs.
 */
export function resolveAs93Url(title: string, slugs: Set<string>): string | null {
	const slug = slugifyTitle(title);
	if (!slug || !slugs.has(slug)) return null;
	return `${BASE_URL}/${slug}`;
}
