import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRegistry } from '$lib/server/db';
import { getRegistryAuth } from '$lib/server/docker';

interface TagInfo {
	name: string;
	size?: number;
	lastUpdated?: string;
	digest?: string;
}

function isDockerHub(url: string): boolean {
	const lower = url.toLowerCase();
	return lower.includes('docker.io') ||
		   lower.includes('hub.docker.com') ||
		   lower.includes('registry.hub.docker.com');
}

interface PaginatedTags {
	tags: TagInfo[];
	total: number;
	page: number;
	pageSize: number;
	hasNext: boolean;
	hasPrev: boolean;
}

async function fetchDockerHubTags(imageName: string, page: number = 1, pageSize: number = 20): Promise<PaginatedTags> {
	// Docker Hub uses a different API
	// For official images: https://hub.docker.com/v2/repositories/library/<image>/tags
	// For user images: https://hub.docker.com/v2/repositories/<user>/<image>/tags

	let repoPath = imageName;
	if (!imageName.includes('/')) {
		// Official image (e.g., nginx -> library/nginx)
		repoPath = `library/${imageName}`;
	}

	const url = `https://hub.docker.com/v2/repositories/${repoPath}/tags?page_size=${pageSize}&page=${page}&ordering=last_updated`;

	const response = await fetch(url, {
		headers: {
			'Accept': 'application/json'
		}
	});

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error('Image not found on Docker Hub');
		}
		const err = new Error(`Docker Hub returned error: ${response.status}`) as any;
		err.statusCode = response.status;
		throw err;
	}

	const data = await response.json();
	const results = data.results || [];

	const tags = results.map((tag: any) => ({
		name: tag.name,
		size: tag.full_size || tag.images?.[0]?.size,
		lastUpdated: tag.last_updated || tag.tag_last_pushed,
		digest: tag.images?.[0]?.digest
	}));

	return {
		tags,
		total: data.count || 0,
		page,
		pageSize,
		hasNext: !!data.next,
		hasPrev: !!data.previous
	};
}

async function fetchRegistryTags(registry: any, imageName: string): Promise<TagInfo[]> {
	// Note: orgPath is not used here because imageName already contains the full repo path
	const { baseUrl, authHeader } = await getRegistryAuth(registry, `repository:${imageName}:pull`);
	const tagsUrl = `${baseUrl}/v2/${imageName}/tags/list`;

	const headers: HeadersInit = {
		'Accept': 'application/json'
	};

	if (authHeader) {
		headers['Authorization'] = authHeader;
	}

	const response = await fetch(tagsUrl, {
		method: 'GET',
		headers
	});

	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error('Authentication failed. Please check your credentials and permissions.');
		}
		if (response.status === 404) {
			throw new Error('Image not found in registry');
		}
		throw new Error(`Registry returned error: ${response.status}`);
	}

	const data = await response.json();
	const tags = data.tags || [];

	// For V2 registries, we only get tag names, not sizes or dates
	// We could fetch manifests for each tag to get more info, but that's expensive
	// Just return the basic info for now
	return tags.map((name: string) => ({
		name,
		size: undefined,
		lastUpdated: undefined,
		digest: undefined
	}));
}

/**
 * @openapi
 * summary: List the tags of an image from Docker Hub or a configured registry (paginated for Docker Hub)
 * description: With no registry parameter, Docker Hub is queried; V2 registries return all tags in one page. Upstream Docker Hub error status codes are proxied back.
 * query: registry:integer ID of the configured registry; omit to query Docker Hub (from GET /api/registries)
 * query: image:string! Repository/image name
 * query: page:integer Page number for Docker Hub pagination (default 1)
 * query: pageSize:integer Page size for Docker Hub pagination (default 20)
 * resp-200: {tags:array<{name:string!, size:integer, lastUpdated:string, digest:string}>!, total:integer!, page:integer!, pageSize:integer!, hasNext:boolean!, hasPrev:boolean!}
 * resp-200-example: {"tags":[{"name":"1.27","lastUpdated":"2026-06-01T00:00:00Z"}],"total":1,"page":1,"pageSize":20,"hasNext":false,"hasPrev":false}
 * resp-400: The image query parameter is missing
 * resp-404: The referenced registry does not exist
 * resp-500: Failed to fetch tags
 * resp-503: Could not connect to the registry (connection refused or host not found)
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const registryId = url.searchParams.get('registry');
		const imageName = url.searchParams.get('image');
		const page = parseInt(url.searchParams.get('page') || '1');
		const pageSize = parseInt(url.searchParams.get('pageSize') || '20');

		if (!imageName) {
			return json({ error: 'Image name is required' }, { status: 400 });
		}

		let result: PaginatedTags;

		if (!registryId) {
			// No registry specified, assume Docker Hub
			result = await fetchDockerHubTags(imageName, page, pageSize);
		} else {
			const registry = await getRegistry(parseInt(registryId));
			if (!registry) {
				return json({ error: 'Registry not found' }, { status: 404 });
			}

			if (isDockerHub(registry.url)) {
				result = await fetchDockerHubTags(imageName, page, pageSize);
			} else {
				// V2 registries don't support pagination well, return all tags
				const tags = await fetchRegistryTags(registry, imageName);
				result = {
					tags,
					total: tags.length,
					page: 1,
					pageSize: tags.length,
					hasNext: false,
					hasPrev: false
				};
			}
		}

		return json(result);
	} catch (error: any) {
		console.error('Error fetching tags:', error);

		if (error.code === 'ECONNREFUSED') {
			return json({ error: 'Could not connect to registry' }, { status: 503 });
		}
		if (error.code === 'ENOTFOUND') {
			return json({ error: 'Registry host not found' }, { status: 503 });
		}
		if (error.statusCode) {
			return json({ error: error.message || 'Failed to fetch tags' }, { status: error.statusCode });
		}

		return json({ error: error.message || 'Failed to fetch tags' }, { status: 500 });
	}
};
