import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRegistry } from '$lib/server/db';
import { getRegistryAuth, isHarborRegistry, harborSearchRepositories, parseRegistryUrl } from '$lib/server/docker';

interface SearchResult {
	name: string;
	description: string;
	star_count: number;
	is_official: boolean;
	is_automated: boolean;
}

function isDockerHub(url: string): boolean {
	const lower = url.toLowerCase();
	return lower.includes('docker.io') ||
		   lower.includes('hub.docker.com') ||
		   lower.includes('registry.hub.docker.com');
}

async function searchDockerHub(term: string, limit: number): Promise<SearchResult[]> {
	// Use Docker Hub's search API directly
	const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(term)}&page_size=${limit}`;

	const response = await fetch(url, {
		headers: {
			'Accept': 'application/json'
		}
	});

	if (!response.ok) {
		throw new Error(`Docker Hub search failed: ${response.status}`);
	}

	const data = await response.json();
	const results = data.results || [];

	return results.map((item: any) => ({
		name: item.repo_name || item.name,
		description: item.short_description || item.description || '',
		star_count: item.star_count || 0,
		is_official: item.is_official || false,
		is_automated: item.is_automated || false
	}));
}

async function searchPrivateRegistry(registry: any, term: string, limit: number): Promise<SearchResult[]> {
	const results: string[] = [];
	const { orgPath } = parseRegistryUrl(registry.url);
	const orgPrefix = orgPath ? orgPath.replace(/^\//, '') : '';

	// Strategy 1: Direct image lookup — try the exact term and org-prefixed variants
	// This uses per-repository auth scope which works on all V2 registries (GitLab, Harbor, etc.)
	const directCandidates: string[] = [];
	if (term.includes('/')) {
		directCandidates.push(term);
	}
	// If registry URL has an org path (e.g., https://registry.example.com/group),
	// try prepending it to the search term
	if (orgPrefix && !term.startsWith(orgPrefix + '/')) {
		directCandidates.push(`${orgPrefix}/${term}`);
	}

	for (const candidate of directCandidates) {
		if (results.length >= limit) break;
		const exists = await tryDirectImageLookup(registry, candidate);
		if (exists && !results.includes(candidate)) {
			results.push(candidate);
		}
	}

	// Strategy 2: Fall back to catalog search for partial/fuzzy matches
	// Some registries (GitLab, Harbor) don't support _catalog for deploy tokens,
	// so catch errors gracefully and return whatever we have from direct lookup
	if (results.length < limit) {
		try {
			const catalogResults = await searchCatalog(registry, term, limit - results.length);
			for (const name of catalogResults) {
				if (!results.includes(name)) {
					results.push(name);
				}
			}
		} catch (e: any) {
			// Catalog not supported but we have direct lookup results — that's fine
			if (results.length > 0) {
				console.warn(`[Registry] Catalog search failed (using direct lookup results): ${e.message}`);
			} else {
				throw e;
			}
		}
	}

	return results.map((name: string) => ({
		name,
		description: '',
		star_count: 0,
		is_official: false,
		is_automated: false
	}));
}

// Try to directly check if an image exists by querying its tags endpoint
async function tryDirectImageLookup(registry: any, imageName: string): Promise<boolean> {
	try {
		// Note: orgPath is not used here because imageName already contains the full repo path
		const { baseUrl, authHeader } = await getRegistryAuth(registry, `repository:${imageName}:pull`);

		const headers: HeadersInit = {
			'Accept': 'application/json'
		};

		if (authHeader) {
			headers['Authorization'] = authHeader;
		}

		const response = await fetch(`${baseUrl}/v2/${imageName}/tags/list`, {
			method: 'GET',
			headers
		});

		// 200 = image exists, 404 = doesn't exist
		return response.ok;
	} catch {
		return false;
	}
}

// Search through catalog (slow for large registries, limited to first few pages)
async function searchCatalog(registry: any, term: string, limit: number): Promise<string[]> {
	// Harbor fallback: use the native project API for search
	if (await isHarborRegistry(registry.url)) {
		const { path: orgPath } = parseRegistryUrl(registry.url);
		return harborSearchRepositories(registry, term, orgPath, limit);
	}

	// Note: orgPath could be used here to filter results, but search is already term-based
	const { baseUrl, authHeader } = await getRegistryAuth(registry, 'registry:catalog:*');

	const headers: HeadersInit = {
		'Accept': 'application/json'
	};

	if (authHeader) {
		headers['Authorization'] = authHeader;
	}

	const termLower = term.toLowerCase();
	const results: string[] = [];
	const PAGE_SIZE = 200;
	const MAX_PAGES = 3; // Limit pages to avoid long waits on huge registries

	let lastRepo: string | null = null;
	let pagesSearched = 0;

	while (results.length < limit && pagesSearched < MAX_PAGES) {
		let catalogUrl = `${baseUrl}/v2/_catalog?n=${PAGE_SIZE}`;
		if (lastRepo) {
			catalogUrl += `&last=${encodeURIComponent(lastRepo)}`;
		}

		const response = await fetch(catalogUrl, {
			method: 'GET',
			headers
		});

		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new Error('Authentication failed. This registry may not support catalog listing (common with GitLab and Harbor deploy tokens).');
			}
			throw new Error(`Registry returned error: ${response.status}`);
		}

		const data = await response.json();
		const repositories: string[] = data.repositories || [];

		if (repositories.length === 0) {
			break;
		}

		// Filter and add matching repos
		for (const name of repositories) {
			if (name.toLowerCase().includes(termLower)) {
				results.push(name);
				if (results.length >= limit) {
					break;
				}
			}
		}

		// Get last repo for next page
		lastRepo = repositories[repositories.length - 1];

		// Check if there are more pages
		const linkHeader = response.headers.get('Link');
		if (!linkHeader || !linkHeader.includes('rel="next"')) {
			if (repositories.length < PAGE_SIZE) {
				break;
			}
		}

		pagesSearched++;
	}

	return results;
}

export const GET: RequestHandler = async ({ url }) => {
	const term = url.searchParams.get('term');
	const limit = parseInt(url.searchParams.get('limit') || '25', 10);
	const registryId = url.searchParams.get('registry');

	if (!term) {
		return json({ error: 'Search term is required' }, { status: 400 });
	}

	try {
		let results: SearchResult[];

		if (!registryId) {
			// No registry specified, search Docker Hub
			results = await searchDockerHub(term, limit);
		} else {
			const registry = await getRegistry(parseInt(registryId));
			if (!registry) {
				return json({ error: 'Registry not found' }, { status: 404 });
			}

			if (isDockerHub(registry.url)) {
				results = await searchDockerHub(term, limit);
			} else {
				results = await searchPrivateRegistry(registry, term, limit);
			}
		}

		return json(results);
	} catch (error: any) {
		console.error('Failed to search images:', error);

		if (error.code === 'ECONNREFUSED') {
			return json({ error: 'Could not connect to registry' }, { status: 503 });
		}
		if (error.code === 'ENOTFOUND') {
			return json({ error: 'Registry host not found' }, { status: 503 });
		}

		return json({ error: error.message || 'Failed to search images' }, { status: 500 });
	}
};
