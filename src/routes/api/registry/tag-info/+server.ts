import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRegistry } from '$lib/server/db';
import { getRegistryAuth } from '$lib/server/docker';

function isDockerHub(rawUrl: string): boolean {
	const lower = rawUrl.toLowerCase();
	return lower.includes('docker.io') || lower.includes('hub.docker.com') || lower.includes('registry.hub.docker.com');
}

// Per-tag size + created date for the registry browser (#876). The V2 tags/list
// endpoint returns only names, so size/date live in the per-tag manifest. This is
// fetched lazily by the UI (one call per visible tag on expand), NOT in tags/list -
// a 125-tag repo must not eat 125 manifest fetches up front.
//
// FOOLPROOF: every failure path returns HTTP 200 with { size: null, lastUpdated: null,
// reason: '<why>' } so a slow/dead/auth-gated/multi-arch tag NEVER breaks the row or
// the tag list. Only a genuinely-missing registry/image param is a 4xx.

interface TagInfoResult {
	size: number | null;
	lastUpdated: string | null;
	reason?: string; // shown in the UI tooltip when size/date are unavailable
}

// Accept both OCI (distribution 3.0 default) and legacy Docker manifests + their index
// forms. Without the OCI types, distribution 3.0 answers MANIFEST_UNKNOWN.
const MANIFEST_ACCEPT = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');

const INDEX_MEDIA_TYPES = new Set([
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json'
]);

async function fetchManifest(
	baseUrl: string,
	image: string,
	ref: string,
	authHeader: string | null
): Promise<{ ok: true; body: any; contentType: string } | { ok: false; reason: string }> {
	const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
	if (authHeader) headers['Authorization'] = authHeader;

	const res = await fetch(`${baseUrl}/v2/${image}/manifests/${encodeURIComponent(ref)}`, {
		method: 'GET',
		headers,
		// short per-request timeout so one slow tag doesn't stall the row
		signal: AbortSignal.timeout(8000)
	});

	if (!res.ok) {
		if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Authentication required' };
		if (res.status === 404) return { ok: false, reason: 'Manifest not found' };
		return { ok: false, reason: `Registry error ${res.status}` };
	}

	const contentType = res.headers.get('content-type') || '';
	const body = await res.json();
	return { ok: true, body, contentType };
}

// Sum a single-arch manifest's compressed size: config blob + all layer blobs.
function sizeFromManifest(m: any): number | null {
	if (!m || typeof m !== 'object') return null;
	const layers = Array.isArray(m.layers) ? m.layers : [];
	const configSize = typeof m.config?.size === 'number' ? m.config.size : 0;
	const layersSize = layers.reduce((acc: number, l: any) => acc + (typeof l?.size === 'number' ? l.size : 0), 0);
	const total = configSize + layersSize;
	return total > 0 ? total : null;
}

// OCI/Docker images may carry a created date in annotations.
function createdFromManifest(m: any): string | null {
	const created = m?.annotations?.['org.opencontainers.image.created'];
	return typeof created === 'string' && created.length > 0 ? created : null;
}

async function resolveTagInfo(registry: any, image: string, tag: string): Promise<TagInfoResult> {
	const { baseUrl, authHeader } = await getRegistryAuth(registry, `repository:${image}:pull`);

	const first = await fetchManifest(baseUrl, image, tag, authHeader);
	if (!first.ok) return { size: null, lastUpdated: null, reason: first.reason };

	// Multi-arch index: follow the first child manifest to compute a representative size.
	if (INDEX_MEDIA_TYPES.has(first.body?.mediaType) || Array.isArray(first.body?.manifests)) {
		const child = (first.body?.manifests || [])[0];
		if (!child?.digest) return { size: null, lastUpdated: null, reason: 'Multi-arch (no child manifest)' };
		const childRes = await fetchManifest(baseUrl, image, child.digest, authHeader);
		if (!childRes.ok) return { size: null, lastUpdated: null, reason: childRes.reason };
		return {
			size: sizeFromManifest(childRes.body),
			lastUpdated: createdFromManifest(childRes.body) || createdFromManifest(first.body),
			reason: undefined
		};
	}

	const size = sizeFromManifest(first.body);
	const lastUpdated = createdFromManifest(first.body);
	const result: TagInfoResult = { size, lastUpdated };
	if (size === null && lastUpdated === null) result.reason = 'No size/date in manifest';
	return result;
}

/**
 * @openapi
 * summary: Resolve the compressed size and creation date of a single registry tag from its manifest (lazy per-tag fetch for the registry browser)
 * query: registry:integer Registry ID; omitted or Docker Hub registries return a graceful "not supported" result instead of a manifest fetch (from GET /api/registries)
 * query: image:string! Image repository/name
 * query: tag:string! Tag name or digest
 * resp-200: {size:number, lastUpdated:string, reason:string}
 * resp-200-example: {"size":104857600,"lastUpdated":"2026-06-01T12:00:00Z"}
 * resp-400: image and tag are required
 * resp-404: Registry not found
 */
export const GET: RequestHandler = async ({ url }) => {
	const registryId = url.searchParams.get('registry');
	const image = url.searchParams.get('image');
	const tag = url.searchParams.get('tag');

	if (!image || !tag) {
		return json({ error: 'image and tag are required' }, { status: 400 });
	}

	// Docker Hub tags already carry size/date from the hub API (see registry/tags),
	// so this per-manifest path is only for self-hosted V2 registries.
	if (!registryId) {
		return json({ size: null, lastUpdated: null, reason: 'Not supported without a registry' } satisfies TagInfoResult);
	}

	const registry = await getRegistry(parseInt(registryId));
	if (!registry) {
		return json({ error: 'Registry not found' }, { status: 404 });
	}
	if (isDockerHub(registry.url)) {
		return json({ size: null, lastUpdated: null, reason: 'Docker Hub tags carry size/date already' } satisfies TagInfoResult);
	}

	try {
		return json(await resolveTagInfo(registry, image, tag) satisfies TagInfoResult);
	} catch (error: any) {
		// Never fail the row: fold any error into a graceful "unavailable" result.
		const reason = error?.name === 'TimeoutError' ? 'Timed out' : (error?.message || 'Unavailable');
		return json({ size: null, lastUpdated: null, reason } satisfies TagInfoResult);
	}
};
