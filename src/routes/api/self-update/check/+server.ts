import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getOwnContainerId, getOwnDockerHost } from '$lib/server/host-path';
import { getRegistryManifestDigest, unixSocketRequest } from '$lib/server/docker';
import { compareVersions } from '$lib/utils/version';
import type { RequestHandler } from './$types';

/** Fetch from the local Docker directly (not through environment routing) */
function localDockerFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const dockerHost = process.env.DOCKER_HOST || getOwnDockerHost();

	if (dockerHost?.startsWith('tcp://')) {
		// TCP connection (socat proxy, socket-proxy, remote Docker)
		const url = dockerHost.replace('tcp://', 'http://') + path;
		return fetch(url, options);
	}

	// Unix socket (default)
	const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
	return unixSocketRequest(socketPath, path, options);
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
		console.log('[SelfUpdate] Not running in Docker, skipping update check');
		return json({
			updateAvailable: false,
			error: 'Not running in Docker'
		});
	}

	try {
		// Inspect own container to get current image info
		const inspectResponse = await localDockerFetch(`/containers/${containerId}/json`);
		if (!inspectResponse.ok) {
			console.log(`[SelfUpdate] Failed to inspect container ${containerId.substring(0, 12)}: ${inspectResponse.status}`);
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

		console.log(`[SelfUpdate] Container: ${containerId.substring(0, 12)}, image: ${currentImage}, tag: ${currentImage.split(':').pop() || 'latest'}`);

		if (!currentImage) {
			console.log('[SelfUpdate] Could not determine current image from inspect data');
			return json({
				updateAvailable: false,
				error: 'Could not determine current image'
			});
		}

		// Detect if managed by Docker Compose
		const isComposeManaged = !!inspectData.Config?.Labels?.['com.docker.compose.project'];

		// Digest-based images (e.g. image@sha256:...) can't be checked for updates
		if (currentImage.includes('@sha256:')) {
			console.log('[SelfUpdate] Image pinned by digest, cannot check for updates');
			return json({
				updateAvailable: false,
				currentImage,
				currentDigest: currentImage.split('@')[1],
				containerName,
				isComposeManaged
			});
		}

		// Extract tag from image name
		const colonIdx = currentImage.lastIndexOf(':');
		const tag = colonIdx > -1 ? currentImage.substring(colonIdx + 1) : 'latest';
		const imageWithoutTag = colonIdx > -1 ? currentImage.substring(0, colonIdx) : currentImage;

		// Check if this is a versioned tag (e.g., v1.0.18, 1.0.18, v1.0.18-baseline)
		const versionMatch = tag.match(/^(v?\d+\.\d+\.\d+)(-baseline)?$/);

		if (versionMatch) {
			// Version-based check: compare against latest released version from changelog
			const currentTagVersion = versionMatch[1];
			const suffix = versionMatch[2] || ''; // '-baseline' or ''
			console.log(`[SelfUpdate] Version-based check: current=${currentTagVersion}${suffix}`);

			try {
				const changelogResponse = await fetch(
					'https://raw.githubusercontent.com/Finsys/dockhand/main/src/lib/data/changelog.json',
					{ signal: AbortSignal.timeout(5000) }
				);

				if (!changelogResponse.ok) {
					console.log(`[SelfUpdate] Failed to fetch changelog from GitHub: ${changelogResponse.status}`);
					return json({
						updateAvailable: false,
						currentImage,
						containerName,
						isComposeManaged,
						error: 'Could not fetch changelog from GitHub'
					});
				}

				const changelog = await changelogResponse.json() as Array<{
					version: string;
					comingSoon?: boolean;
					date?: string;
					changes?: Array<{ type: string; text: string }>;
				}>;

				// Find latest released version (first entry without comingSoon)
				const latestRelease = changelog.find(entry => !entry.comingSoon);

				if (!latestRelease) {
					console.log('[SelfUpdate] No released version found in changelog');
					return json({
						updateAvailable: false,
						currentImage,
						containerName,
						isComposeManaged,
						error: 'No released version found in changelog'
					});
				}

				const latestVersion = latestRelease.version;
				const hasNewer = compareVersions(latestVersion, currentTagVersion) > 0;
				console.log(`[SelfUpdate] Latest changelog version: ${latestVersion}, current: ${currentTagVersion}, hasNewer: ${hasNewer}`);

				if (hasNewer) {
					// Build new image tag preserving registry prefix and suffix
					const newTag = `v${latestVersion.replace(/^v/, '')}${suffix}`;
					const newImage = `${imageWithoutTag}:${newTag}`;

					console.log(`[SelfUpdate] Update available: ${currentImage} → ${newImage}`);
					return json({
						updateAvailable: true,
						currentImage,
						newImage,
						latestVersion: latestVersion.replace(/^v/, ''),
						containerName,
						isComposeManaged
					});
				}

				console.log(`[SelfUpdate] Up to date (version ${currentTagVersion})`);
				return json({
					updateAvailable: false,
					currentImage,
					containerName,
					isComposeManaged
				});
			} catch (err) {
				console.log(`[SelfUpdate] Version check failed: ${err}`);
				return json({
					updateAvailable: false,
					currentImage,
					containerName,
					isComposeManaged,
					error: 'Version check failed: ' + String(err)
				});
			}
		}

		// Digest-based check for mutable tags (:latest, :baseline, etc.)
		console.log(`[SelfUpdate] Digest-based check for mutable tag: ${tag}`);

		// Inspect image via local Docker socket to get RepoDigests
		const imageResponse = await localDockerFetch(`/images/${encodeURIComponent(currentImageId)}/json`);
		if (!imageResponse.ok) {
			console.log(`[SelfUpdate] Failed to inspect image ${currentImageId}: ${imageResponse.status}`);
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
			console.log('[SelfUpdate] No RepoDigests found — local/untagged image, cannot check registry');
			return json({
				updateAvailable: false,
				currentImage,
				newImage: currentImage,
				containerName,
				isComposeManaged,
				isLocalImage: true
			});
		}

		console.log(`[SelfUpdate] Local digests: ${localDigests.map(d => d.substring(0, 19)).join(', ')}`);

		// Query registry for latest digest
		const registryDigest = await getRegistryManifestDigest(currentImage);
		if (!registryDigest) {
			console.log(`[SelfUpdate] Could not query registry for ${currentImage}`);
			return json({
				updateAvailable: false,
				currentImage,
				newImage: currentImage,
				containerName,
				isComposeManaged,
				error: 'Could not query registry'
			});
		}

		const hasUpdate = !localDigests.includes(registryDigest);
		console.log(`[SelfUpdate] Registry digest: ${registryDigest.substring(0, 19)}, match: ${!hasUpdate}, updateAvailable: ${hasUpdate}`);

		return json({
			updateAvailable: hasUpdate,
			currentImage,
			newImage: currentImage,
			currentDigest: localDigests[0],
			newDigest: registryDigest,
			containerName,
			isComposeManaged
		});
	} catch (err) {
		console.log(`[SelfUpdate] Check failed with error: ${err}`);
		return json({
			updateAvailable: false,
			error: 'Check failed: ' + String(err)
		});
	}
};
