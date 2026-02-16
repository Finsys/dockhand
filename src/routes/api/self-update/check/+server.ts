import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getOwnContainerId } from '$lib/server/host-path';
import { getRegistryManifestDigest } from '$lib/server/docker';
import type { RequestHandler } from './$types';

/**
 * Fetch from the local Docker socket directly (not through environment routing)
 */
async function localDockerFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
	return fetch(`http://localhost${path}`, {
		...options,
		// @ts-ignore - Bun supports unix sockets
		unix: socketPath
	});
}

/**
 * Check if a Dockhand update is available.
 * Admin-only. Auto-checked when Settings > About is opened.
 *
 * Uses localDockerFetch exclusively to avoid environment routing issues
 * when the image comes from a private registry.
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	const containerId = getOwnContainerId();
	if (!containerId) {
		return json({
			updateAvailable: false,
			error: 'Not running in Docker'
		});
	}

	try {
		// Inspect own container to get current image info
		const inspectResponse = await localDockerFetch(`/containers/${containerId}/json`);
		if (!inspectResponse.ok) {
			return json({
				updateAvailable: false,
				error: 'Failed to inspect own container'
			});
		}

		const inspectData = await inspectResponse.json() as {
			Config?: { Image?: string; Labels?: Record<string, string> };
			Image?: string;
			Name?: string;
		};

		const currentImage = inspectData.Config?.Image || '';
		const currentImageId = inspectData.Image || '';
		const containerName = inspectData.Name?.replace(/^\//, '') || '';

		if (!currentImage) {
			return json({
				updateAvailable: false,
				error: 'Could not determine current image'
			});
		}

		// Detect if managed by Docker Compose
		const isComposeManaged = !!inspectData.Config?.Labels?.['com.docker.compose.project'];

		// Digest-based images (e.g. image@sha256:...) can't be checked for updates
		if (currentImage.includes('@sha256:')) {
			return json({
				updateAvailable: false,
				currentImage,
				currentDigest: currentImage.split('@')[1],
				containerName,
				isComposeManaged
			});
		}

		// Inspect image via local Docker socket to get RepoDigests
		const imageResponse = await localDockerFetch(`/images/${encodeURIComponent(currentImageId)}/json`);
		if (!imageResponse.ok) {
			return json({
				updateAvailable: false,
				currentImage,
				containerName,
				isComposeManaged,
				error: 'Could not inspect current image'
			});
		}

		const imageInfo = await imageResponse.json() as { RepoDigests?: string[] };
		const repoDigests = imageInfo.RepoDigests || [];

		// Extract local digests from RepoDigests entries (format: "registry/image@sha256:...")
		const localDigests = repoDigests
			.map((rd: string) => {
				const at = rd.lastIndexOf('@');
				return at > -1 ? rd.substring(at + 1) : null;
			})
			.filter(Boolean) as string[];

		if (localDigests.length === 0) {
			return json({
				updateAvailable: false,
				currentImage,
				containerName,
				isComposeManaged,
				isLocalImage: true
			});
		}

		// Query registry for latest digest
		const registryDigest = await getRegistryManifestDigest(currentImage);
		if (!registryDigest) {
			return json({
				updateAvailable: false,
				currentImage,
				containerName,
				isComposeManaged,
				error: 'Could not query registry'
			});
		}

		const hasUpdate = !localDigests.includes(registryDigest);

		return json({
			updateAvailable: hasUpdate,
			currentImage,
			currentDigest: localDigests[0],
			newDigest: registryDigest,
			containerName,
			isComposeManaged
		});
	} catch (err) {
		return json({
			updateAvailable: false,
			error: 'Check failed: ' + String(err)
		});
	}
};
