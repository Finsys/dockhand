/**
 * Shared aggregation for the Vulnerabilities dashboard: flattens the latest
 * persisted scans into per-CVE findings, filters out images no longer present
 * on the host, and enriches each finding with the containers/stacks using it.
 *
 * Used by both GET /api/vulnerabilities (grid) and GET /api/vulnerabilities/export.
 */
import { getAllLatestScans, getScannedImageIds } from '$lib/server/scan-queries';
import { countFindings, listScannedImageNames, EMPTY_COUNTS } from '$lib/server/vuln-summary';
import { listImages, listContainers, DockerConnectionError, EnvironmentNotFoundError } from '$lib/server/docker';
import { flattenScansToFindings, filterFindings, sortFindings } from '$lib/utils/vulnerability';
import { pickScanDisplayName } from '$lib/server/scanner-output-core';
import type { Finding, FindingContainer, VulnerabilitySummary, ScanRow, FindingFilter, SortField } from '$lib/utils/vulnerability';
import {
	aggregateCache, inflight, metaCache, metaInflight, currentMetaEpoch,
	CACHE_TTL_MS, MAX_VIEWS, MAX_ENVS,
	invalidateVulnerabilitiesCache,
	type CacheEntry, type AggregatedVulnerabilities, type VulnerabilitiesMeta
} from '$lib/server/vulnerabilities-cache';

// Re-export the shared client/server helpers so existing importers keep working.
export type { Finding, FindingContainer, VulnerabilitySummary, ScanRow };
export type { AggregatedVulnerabilities, VulnerabilitiesMeta };
export { flattenScansToFindings, invalidateVulnerabilitiesCache };

export async function aggregateVulnerabilities(envIdNum: number): Promise<AggregatedVulnerabilities> {
	const scans = await getAllLatestScans(envIdNum);

	// Best-effort live Docker state — total image count (for "Images scanned: N/M")
	// and running containers used to enrich each finding. Never throw on Docker down.
	let existingImageIds: Set<string> | null = null;
	let totalImages = 0;
	const containersByImage = new Map<string, FindingContainer[]>();
	const stacksByImage = new Map<string, Set<string>>();
	// What the host calls each image now, which can differ from the name the scan
	// recorded: an auto-update scan runs against a temporary tag.
	const namesByImage = new Map<string, string>();
	try {
		const images = await listImages(envIdNum);
		totalImages = images.length;
		existingImageIds = new Set(images.map((img) => img.id));
		for (const img of images) {
			const current = pickScanDisplayName(img.id, img.tags);
			if (current !== img.id) namesByImage.set(img.id, current);
		}
	} catch (error) {
		if (!(error instanceof DockerConnectionError) && !(error instanceof EnvironmentNotFoundError)) {
			console.error('Error listing images for vulnerability summary:', error);
		}
	}
	try {
		const containers = await listContainers(true, envIdNum);
		for (const c of containers) {
			if (!c.imageId) continue;
			const list = containersByImage.get(c.imageId) ?? [];
			list.push({ id: c.id, name: c.name });
			containersByImage.set(c.imageId, list);

			const stack = c.labels?.['com.docker.compose.project'];
			if (stack) {
				const set = stacksByImage.get(c.imageId) ?? new Set<string>();
				set.add(stack);
				stacksByImage.set(c.imageId, set);
			}
		}
	} catch (error) {
		if (!(error instanceof DockerConnectionError) && !(error instanceof EnvironmentNotFoundError)) {
			console.error('Error listing containers for vulnerability enrichment:', error);
		}
	}

	const scannedImageIds = new Set<string>();
	let critical = 0, high = 0, medium = 0, low = 0;

	// Keep only scans for images still present on the host (scanned <= total).
	const liveScans = existingImageIds
		? scans.filter((s) => existingImageIds!.has(s.imageId))
		: scans;
	for (const s of liveScans) scannedImageIds.add(s.imageId);

	const findings = flattenScansToFindings(liveScans, { containersByImage, stacksByImage, namesByImage });
	for (const f of findings) {
		switch ((f.severity || '').toLowerCase()) {
			case 'critical': critical++; break;
			case 'high': high++; break;
			case 'medium': medium++; break;
			case 'low': low++; break;
		}
	}

	// If Docker was unreachable we couldn't filter stale scans; fall back to the raw
	// distinct scanned count and use it as the total so the ratio stays sane.
	if (!existingImageIds) {
		totalImages = scannedImageIds.size;
	}

	return {
		findings,
		summary: {
			total: findings.length,
			critical,
			high,
			medium,
			low,
			imagesScanned: scannedImageIds.size,
			totalImages
		}
	};
}

// ---------------------------------------------------------------------------
// Paged access with a short-TTL cache of the flattened+enriched result.
//
// Findings are exploded from per-scan JSON blobs, so we can't page at the SQL
// layer — every request must flatten the full set. To keep paging/scrolling
// cheap, the full AggregatedVulnerabilities is cached per environment for a
// few seconds and reused across page requests. This bounds *browser* memory
// (only a page is sent to the client) without re-flattening on every scroll.
// ---------------------------------------------------------------------------

async function getCacheEntry(envIdNum: number): Promise<CacheEntry> {
	const cached = aggregateCache.get(envIdNum);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
	if (cached) aggregateCache.delete(envIdNum); // release the expired findings array

	let promise = inflight.get(envIdNum);
	if (!promise) {
		promise = aggregateVulnerabilities(envIdNum).finally(() => inflight.delete(envIdNum));
		inflight.set(envIdNum, promise);
	}
	const data = await promise;
	// A concurrent cold caller may have already installed an entry for this same
	// aggregation — reuse it so both share one views/meta cache.
	const existing = aggregateCache.get(envIdNum);
	if (existing && existing.data === data) return existing;
	const entry: CacheEntry = { at: Date.now(), data, views: new Map() };
	aggregateCache.set(envIdNum, entry);
	// Bound *cache* memory across environments. This is a performance cache only —
	// evicting an env never hides its vulns: the next request for it just
	// re-aggregates from the DB. Past the cap, drop an expired entry if there is
	// one (free win), else the oldest, never the entry we just created.
	if (aggregateCache.size > MAX_ENVS) {
		const now = Date.now();
		let victim: number | undefined;
		for (const [id, e] of aggregateCache) {
			if (id === envIdNum) continue;
			if (now - e.at >= CACHE_TTL_MS) { victim = id; break; } // prefer an expired entry
			if (victim === undefined) victim = id; // fall back to the oldest (insertion order)
		}
		if (victim !== undefined) aggregateCache.delete(victim);
	}
	return entry;
}

/** The cached entry if one is already warm; never builds one. */
function peekCacheEntry(envIdNum: number): CacheEntry | undefined {
	const cached = aggregateCache.get(envIdNum);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
	return undefined;
}

interface LiveImageState {
	/** Scanned image ids the host still has - what the dashboard reports on. */
	scannedIds: string[];
	scannedIdSet: Set<string>;
	totalImages: number;
	containersByImage: Map<string, FindingContainer[]>;
	stacksByImage: Map<string, Set<string>>;
	/** What the host calls each image now, where that differs from its id. */
	namesByImage: Map<string, string>;
}

/**
 * The live Docker side of the dashboard: which scanned images still exist, how
 * many images there are, and which containers and stacks use them.
 *
 * Docker being down is not an error here - the page still renders from what the
 * database knows, minus the enrichment.
 */
/** An enrichment read that Docker refused is logged unless Docker is simply away. */
function reportEnrichmentError(what: string, error: unknown): void {
	if (error instanceof DockerConnectionError || error instanceof EnvironmentNotFoundError) return;
	console.error(`Error listing ${what} for vulnerability summary:`, error);
}

/** Which images the daemon still has, and the display name each one goes by. */
async function imagesOnHost(
	envIdNum: number
): Promise<{ present: Set<string> | null; totalImages: number; namesByImage: Map<string, string> }> {
	const namesByImage = new Map<string, string>();
	try {
		const images = await listImages(envIdNum);
		const present = new Set(images.map((img) => img.id));
		for (const img of images) {
			const current = pickScanDisplayName(img.id, img.tags);
			if (current !== img.id) namesByImage.set(img.id, current);
		}
		return { present, totalImages: images.length, namesByImage };
	} catch (error) {
		reportEnrichmentError('images', error);
		// null present = Docker said nothing, which the caller treats as "cannot filter".
		return { present: null, totalImages: 0, namesByImage };
	}
}

/** Which containers and stacks use each image. */
async function usageByImage(envIdNum: number): Promise<{
	containersByImage: Map<string, FindingContainer[]>;
	stacksByImage: Map<string, Set<string>>;
}> {
	const containersByImage = new Map<string, FindingContainer[]>();
	const stacksByImage = new Map<string, Set<string>>();
	try {
		for (const c of await listContainers(true, envIdNum)) {
			if (!c.imageId) continue;
			const list = containersByImage.get(c.imageId) ?? [];
			list.push({ id: c.id, name: c.name });
			containersByImage.set(c.imageId, list);
			const stack = c.labels?.['com.docker.compose.project'];
			if (!stack) continue;
			const set = stacksByImage.get(c.imageId) ?? new Set<string>();
			set.add(stack);
			stacksByImage.set(c.imageId, set);
		}
	} catch (error) {
		reportEnrichmentError('containers', error);
	}
	return { containersByImage, stacksByImage };
}

async function liveImageState(envIdNum: number): Promise<LiveImageState> {
	const [scanned, { present, totalImages, namesByImage }, { containersByImage, stacksByImage }] =
		await Promise.all([getScannedImageIds(envIdNum), imagesOnHost(envIdNum), usageByImage(envIdNum)]);

	// With Docker unreachable nothing can be filtered out, so every scanned image
	// counts and the ratio stays sane instead of reading as "0 of 0".
	const scannedIds = present ? scanned.filter((id: string) => present.has(id)) : scanned;

	return {
		scannedIds,
		scannedIdSet: new Set(scannedIds),
		totalImages: present ? totalImages : scannedIds.length,
		containersByImage,
		stacksByImage,
		namesByImage
	};
}

async function getAggregatedCached(envIdNum: number): Promise<AggregatedVulnerabilities> {
	return (await getCacheEntry(envIdNum)).data;
}

export interface VulnerabilitiesQuery extends FindingFilter {
	sort?: SortField;
	dir?: 'asc' | 'desc';
	limit?: number;
	offset?: number;
}

export interface PagedVulnerabilities {
	findings: Finding[];
	total: number;
	/** Severity counts + total for the FILTERED set (so the header pills track the
	 *  active filters). imagesScanned/totalImages stay env-wide (not per-filter). */
	summary: VulnerabilitySummary;
}

/** Split a comma-separated multi-value filter param into a trimmed, non-empty list. */
function parseList(url: URL, key: string): string[] {
	const raw = url.searchParams.get(key);
	return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Parse the shared filter/sort/paging query params used by the grid and export
 * endpoints, so the parsing lives in one place (a new filter can't be added to
 * one endpoint and forgotten in another).
 */
export function parseVulnerabilitiesQuery(url: URL): VulnerabilitiesQuery {
	const limit = url.searchParams.get('limit');
	const offset = url.searchParams.get('offset');
	const sort = url.searchParams.get('sort');
	return {
		q: url.searchParams.get('q') ?? '',
		severities: parseList(url, 'severity'),
		images: parseList(url, 'image'),
		containers: parseList(url, 'container'),
		stacks: parseList(url, 'stack'),
		sort: (sort as SortField) || undefined,
		dir: url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc',
		limit: limit ? parseInt(limit) : undefined,
		offset: offset ? parseInt(offset) : undefined
	};
}

function viewKey(q: VulnerabilitiesQuery): string {
	return [
		q.sort ?? '', q.dir ?? '',
		(q.q ?? '').toLowerCase().trim(),
		(q.severities ?? []).join('|'),
		(q.images ?? []).join('|'),
		(q.containers ?? []).join('|'),
		(q.stacks ?? []).join('|')
	].join('¬');
}

/**
 * The full filtered+sorted finding set for a query, memoized within the cache
 * window so repeated page/scroll requests reuse the filter+sort work. Shared by
 * the paged grid endpoint and the export endpoint so their ordering can't drift.
 */
export async function getFilteredSortedFindings(envIdNum: number, query: VulnerabilitiesQuery): Promise<Finding[]> {
	const entry = await getCacheEntry(envIdNum);
	const key = viewKey(query);
	const cachedView = entry.views.get(key);
	if (cachedView) {
		// LRU touch: move to newest so it survives eviction.
		entry.views.delete(key);
		entry.views.set(key, cachedView);
		return cachedView;
	}

	const filtered = filterFindings(entry.data.findings, query);
	// filterFindings returns the input BY REFERENCE when no filter is active, and an
	// unsorted view keeps that reference — storing the master findings array as a
	// memoized view would make any accidental in-place mutation of a view corrupt
	// the shared cache. Copy when the view would alias the master. (sortFindings
	// already returns a fresh array.)
	const view = query.sort
		? sortFindings(filtered, query.sort, query.dir ?? 'asc')
		: (filtered === entry.data.findings ? filtered.slice() : filtered);
	// Bound the memo (rapid filter/sort changes would otherwise accumulate a full
	// array per distinct query for the cache window). Evict the oldest.
	if (entry.views.size >= MAX_VIEWS) {
		const oldest = entry.views.keys().next().value;
		if (oldest !== undefined) entry.views.delete(oldest);
	}
	entry.views.set(key, view);
	return view;
}

/** Filter + sort the full set, then return one page. `total` is the filtered count. */
export async function getVulnerabilitiesPage(envIdNum: number, query: VulnerabilitiesQuery): Promise<PagedVulnerabilities> {
	const view = await getFilteredSortedFindings(envIdNum, query);
	const offset = Math.max(0, query.offset ?? 0);
	const limit = query.limit ?? view.length;

	// Severity breakdown of the FILTERED view so the header pills reflect the
	// active filters (imagesScanned/totalImages are env-wide, taken from meta).
	let critical = 0, high = 0, medium = 0, low = 0;
	for (const f of view) {
		switch ((f.severity || '').toLowerCase()) {
			case 'critical': critical++; break;
			case 'high': high++; break;
			case 'medium': medium++; break;
			case 'low': low++; break;
		}
	}
	const meta = await getVulnerabilitiesMeta(envIdNum);

	return {
		findings: view.slice(offset, offset + limit),
		total: view.length,
		summary: {
			total: view.length,
			critical, high, medium, low,
			imagesScanned: meta.summary.imagesScanned,
			totalImages: meta.summary.totalImages
		}
	};
}

/**
 * Totals + distinct filter-dropdown values across the full (unfiltered) set.
 *
 * Counted in the database and read from the live Docker state, so opening the
 * page costs six numbers and a few name lists instead of every scan's findings
 * document - which for a long scan history is hundreds of megabytes.
 *
 * Memoized on the cache entry, but only when one is already warm: asking for
 * meta alone never builds the findings cache.
 */
export async function getVulnerabilitiesMeta(envIdNum: number): Promise<VulnerabilitiesMeta> {
	const warm = peekCacheEntry(envIdNum);
	if (warm?.meta) return warm.meta;

	const cached = metaCache.get(envIdNum);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.meta;

	const pending = metaInflight.get(envIdNum);
	if (pending) return pending;

	const epoch = currentMetaEpoch(envIdNum);
	const call = buildMeta(envIdNum).finally(() => metaInflight.delete(envIdNum));
	metaInflight.set(envIdNum, call);
	const meta = await call;

	// A scan landed while this was building, so the answer is already stale and
	// caching it would hide the new scan for a whole window.
	if (currentMetaEpoch(envIdNum) !== epoch) return meta;

	metaCache.set(envIdNum, { at: Date.now(), meta });
	if (metaCache.size > MAX_ENVS) {
		const oldest = metaCache.keys().next().value;
		if (oldest !== undefined && oldest !== envIdNum) metaCache.delete(oldest);
	}
	if (warm) warm.meta = meta;
	return meta;
}

async function buildMeta(envIdNum: number): Promise<VulnerabilitiesMeta> {
	const live = await liveImageState(envIdNum);
	// A count that cannot be produced leaves the page usable with zeroes rather
	// than failing it: the header is a summary, not the data itself.
	const [counts, imageNames] = await Promise.all([
		countFindings(envIdNum, live.scannedIds).catch((error: unknown) => {
			console.error('Error counting vulnerability findings:', error);
			return { ...EMPTY_COUNTS };
		}),
		listScannedImageNames(envIdNum, live.scannedIds).catch((error: unknown) => {
			console.error('Error listing scanned image names:', error);
			return [] as { imageId: string; imageName: string }[];
		})
	]);

	const containers = new Set<string>();
	const stacks = new Set<string>();
	for (const [imageId, list] of live.containersByImage) {
		if (!live.scannedIdSet.has(imageId)) continue;
		for (const c of list) containers.add(c.name);
	}
	for (const [imageId, set] of live.stacksByImage) {
		if (!live.scannedIdSet.has(imageId)) continue;
		for (const s of set) stacks.add(s);
	}

	const summary: VulnerabilitySummary = {
		total: counts.total,
		critical: counts.critical,
		high: counts.high,
		medium: counts.medium,
		low: counts.low,
		imagesScanned: counts.images,
		totalImages: live.totalImages
	};

	// The dropdown has to offer the same names the findings carry, or picking one
	// matches nothing. Both sides read the live name for an image id and fall back
	// to the name the scan recorded.
	const images = Array.from(
		new Set(imageNames.map((r) => live.namesByImage.get(r.imageId) ?? r.imageName))
	).sort((a, b) => a.localeCompare(b));

	return {
		total: counts.total,
		summary,
		options: {
			images,
			containers: Array.from(containers).sort((a, b) => a.localeCompare(b)),
			stacks: Array.from(stacks).sort((a, b) => a.localeCompare(b))
		}
	};
}
