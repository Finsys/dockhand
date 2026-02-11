import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRegistry } from '$lib/server/db';
import { getRegistryAuth } from '$lib/server/docker';

const PAGE_SIZE = 100;

export const GET: RequestHandler = async ({ url }) => {
	try {
		const registryId = url.searchParams.get('registry');
		const lastParam = url.searchParams.get('last'); // For pagination

		if (!registryId) {
			return json({ error: 'Registry ID is required' }, { status: 400 });
		}

		const registry = await getRegistry(parseInt(registryId));
		if (!registry) {
			return json({ error: 'Registry not found' }, { status: 404 });
		}

		// Docker Hub doesn't support catalog listing
		if (registry.url.includes('docker.io') || registry.url.includes('hub.docker.com') || registry.url.includes('registry.hub.docker.com')) {
			return json({ error: 'Docker Hub does not support catalog listing. Please use search instead.' }, { status: 400 });
		}

		const { baseUrl, orgPath, authHeader } = await getRegistryAuth(registry, 'registry:catalog:*');

		// Build catalog URL with pagination
		let catalogUrl = `${baseUrl}/v2/_catalog?n=${PAGE_SIZE}`;
		if (lastParam) {
			catalogUrl += `&last=${encodeURIComponent(lastParam)}`;
		}

		const headers: HeadersInit = {
			'Accept': 'application/json'
		};

		if (authHeader) {
			headers['Authorization'] = authHeader;
		}

		const response = await fetch(catalogUrl, {
			method: 'GET',
			headers
		});

		if (!response.ok) {
			if (response.status === 401) {
				return json({ error: 'Authentication failed. Please check your credentials.' }, { status: 401 });
			}
			if (response.status === 404) {
				return json({ error: 'Registry does not support V2 catalog API' }, { status: 404 });
			}
			return json({ error: `Registry returned error: ${response.status}` }, { status: response.status });
		}

		const data = await response.json();

		// The V2 API returns { repositories: [...] }
		let repositories: string[] = data.repositories || [];

		// If the registry URL has an organization path, filter to only show repos under that path
		if (orgPath) {
			const orgPrefix = orgPath.replace(/^\//, ''); // Remove leading slash
			repositories = repositories.filter(repo => repo.startsWith(orgPrefix + '/') || repo === orgPrefix);
		}

		// Parse Link header for pagination
		// Format: </v2/_catalog?last=xxx&n=100>; rel="next"
		let nextLast: string | null = null;
		const linkHeader = response.headers.get('Link');
		if (linkHeader) {
			const nextMatch = linkHeader.match(/<[^>]*[?&]last=([^&>]+)[^>]*>;\s*rel="next"/);
			if (nextMatch) {
				nextLast = decodeURIComponent(nextMatch[1]);
			}
		}

		// For each repository, we could fetch tags, but that's expensive
		// Just return the repository names for now
		const results = repositories.map((name: string) => ({
			name,
			description: '',
			star_count: 0,
			is_official: false,
			is_automated: false
		}));

		return json({
			repositories: results,
			pagination: {
				pageSize: PAGE_SIZE,
				hasMore: !!nextLast,
				nextLast: nextLast
			}
		});
	} catch (error: any) {
		console.error('Error fetching registry catalog:', error);

		if (error.code === 'ECONNREFUSED') {
			return json({ error: 'Could not connect to registry' }, { status: 503 });
		}
		if (error.code === 'ENOTFOUND') {
			return json({ error: 'Registry host not found' }, { status: 503 });
		}
		if (error.cause?.code === 'ERR_SSL_PACKET_LENGTH_TOO_LONG') {
			return json({ error: 'SSL error: Registry may be using HTTP, not HTTPS. Try changing the URL to http://' }, { status: 503 });
		}
		if (error.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || error.cause?.code === 'CERT_HAS_EXPIRED') {
			return json({ error: 'SSL certificate error. Registry may have an invalid or self-signed certificate.' }, { status: 503 });
		}

		return json({ error: 'Failed to fetch catalog: ' + (error.message || 'Unknown error') }, { status: 500 });
	}
};
