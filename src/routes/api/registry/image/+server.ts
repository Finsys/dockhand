import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRegistry } from '$lib/server/db';
import { getRegistryAuth } from '$lib/server/docker';

function isDockerHub(url: string): boolean {
	const lower = url.toLowerCase();
	return lower.includes('docker.io') ||
		   lower.includes('hub.docker.com') ||
		   lower.includes('registry.hub.docker.com');
}

export const DELETE: RequestHandler = async ({ url }) => {
	try {
		const registryId = url.searchParams.get('registry');
		const imageName = url.searchParams.get('image');
		const tag = url.searchParams.get('tag');

		if (!registryId) {
			return json({ error: 'Registry ID is required' }, { status: 400 });
		}

		if (!imageName) {
			return json({ error: 'Image name is required' }, { status: 400 });
		}

		if (!tag) {
			return json({ error: 'Tag is required' }, { status: 400 });
		}

		const registry = await getRegistry(parseInt(registryId));
		if (!registry) {
			return json({ error: 'Registry not found' }, { status: 404 });
		}

		// Docker Hub doesn't support deletion via API
		if (isDockerHub(registry.url)) {
			return json({ error: 'Docker Hub does not support image deletion via API. Please use the Docker Hub web interface.' }, { status: 400 });
		}

		const { baseUrl, authHeader } = await getRegistryAuth(registry, `repository:${imageName}:pull,push,delete`);
		// Note: orgPath is not used here because imageName already contains the full repo path

		const headers: HeadersInit = {
			'Accept': 'application/vnd.docker.distribution.manifest.v2+json'
		};

		if (authHeader) {
			headers['Authorization'] = authHeader;
		}

		// Step 1: Get the manifest digest
		const manifestUrl = `${baseUrl}/v2/${imageName}/manifests/${tag}`;
		const headResponse = await fetch(manifestUrl, {
			method: 'HEAD',
			headers
		});

		if (!headResponse.ok) {
			if (headResponse.status === 401) {
				return json({ error: 'Authentication failed' }, { status: 401 });
			}
			if (headResponse.status === 404) {
				return json({ error: 'Image or tag not found' }, { status: 404 });
			}
			return json({ error: `Failed to get manifest: ${headResponse.status}` }, { status: headResponse.status });
		}

		const digest = headResponse.headers.get('Docker-Content-Digest');
		if (!digest) {
			return json({ error: 'Could not get image digest. Registry may not support deletion.' }, { status: 400 });
		}

		// Step 2: Delete the manifest by digest
		const deleteUrl = `${baseUrl}/v2/${imageName}/manifests/${digest}`;
		const deleteResponse = await fetch(deleteUrl, {
			method: 'DELETE',
			headers
		});

		if (!deleteResponse.ok) {
			if (deleteResponse.status === 401) {
				return json({ error: 'Authentication failed' }, { status: 401 });
			}
			if (deleteResponse.status === 404) {
				return json({ error: 'Manifest not found' }, { status: 404 });
			}
			if (deleteResponse.status === 405) {
				return json({ error: 'Registry does not allow deletion. Enable REGISTRY_STORAGE_DELETE_ENABLED=true on the registry.' }, { status: 405 });
			}
			return json({ error: `Failed to delete image: ${deleteResponse.status}` }, { status: deleteResponse.status });
		}

		return json({ success: true, message: `Deleted ${imageName}:${tag}` });
	} catch (error: any) {
		console.error('Error deleting image:', error);

		if (error.code === 'ECONNREFUSED') {
			return json({ error: 'Could not connect to registry' }, { status: 503 });
		}
		if (error.code === 'ENOTFOUND') {
			return json({ error: 'Registry host not found' }, { status: 503 });
		}

		return json({ error: error.message || 'Failed to delete image' }, { status: 500 });
	}
};
