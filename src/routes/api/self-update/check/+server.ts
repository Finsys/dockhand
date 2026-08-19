import { json } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { authorize } from '$lib/server/authorize';
import { getOwnContainerId, getOwnDockerHost, getAutoDetectedDockerHost } from '$lib/server/host-path';
import { getRegistryManifestDigest, unixSocketRequest, dockerFetch } from '$lib/server/docker';
import { getEnvironments } from '$lib/server/db';
import { compareVersions } from '$lib/utils/version';
import type { RequestHandler } from './$types';

/**
 * When there is no local socket and no DOCKER_HOST (e.g. a socket-proxy setup
 * that mounts no docker.sock, #1203), find the environment whose daemon actually
 * runs the Dockhand container by inspecting our own container ID on each
 * candidate. This is deterministic even with several `direct` envs, one of which
 * is a genuinely remote host - the remote daemon returns 404 for our ID, so we
 * never pick it. Memoized: the answer is stable for the process lifetime.
 * Returns the env id, or null if none host us.
 */
let ownEnvIdMemo: number | null | undefined;
async function resolveOwnEnvId(containerId: string): Promise<number | null> {
	if (ownEnvIdMemo !== undefined) return ownEnvIdMemo;

	const envs = await getEnvironments();
	// Socket/local envs first (cheapest, almost always us), then direct.
	const candidates = [
		...envs.filter((e) => e.connectionType === 'socket' || !e.connectionType),
		...envs.filter((e) => e.connectionType === 'direct')
	];
	for (const env of candidates) {
		try {
			const res = await dockerFetch(`/containers/${containerId}/json`, {}, env.id);
			if (res.ok) {
				console.log(`[SelfUpdate] Dockhand runs on environment "${env.name}" (id ${env.id}, ${env.connectionType || 'socket'}); using it for update checks`);
				ownEnvIdMemo = env.id;
				return env.id;
			}
		} catch {
			// Env unreachable or does not host us; try the next candidate.
		}
	}
	console.log('[SelfUpdate] No configured environment hosts the Dockhand container; cannot reach Docker for update check');
	ownEnvIdMemo = null;
	return null;
}

/**
 * Fetch from the Docker daemon running Dockhand itself (not via env routing,
 * which fails on private-registry images - see the private-registry fix).
 *
 * Order: explicit DOCKER_HOST tcp -> local socket if present -> the environment
 * that actually hosts our own container. The last path covers socket-proxy
 * setups with no docker.sock mount and no DOCKER_HOST (#1203), so the user does
 * not have to set DOCKER_HOST (which breaks scanner networking, #1204).
 */
async function localDockerFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const dockerHost = process.env.DOCKER_HOST || getOwnDockerHost() || getAutoDetectedDockerHost();

	if (dockerHost?.startsWith('tcp://')) {
		// TCP connection (socat proxy, socket-proxy, remote Docker)
		const url = dockerHost.replace('tcp://', 'http://') + path;
		return fetch(url, options);
	}

	const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
	if (existsSync(socketPath)) {
		return unixSocketRequest(socketPath, path, options);
	}

	const containerId = getOwnContainerId();
	if (containerId) {
		const ownEnvId = await resolveOwnEnvId(containerId);
		if (ownEnvId !== null) {
			return dockerFetch(path, options, ownEnvId);
		}
	}

	// Nothing usable: fall through to the socket path so the caller gets the
	// original ENOENT rather than a silent success.
	return unixSocketRequest(socketPath, path, options);
}

/**
 * Check if a Dockhand update is available.
 * Admin-only. Auto-checked when Settings > About is opened.
 *
 * Uses localDockerFetch exclusively to avoid environment routing issues
 * when the image comes from a private registry.
 */
/**
 * @openapi
 * summary: Check whether a newer Dockhand image is available (version-tag compare via GitHub changelog, or registry-digest compare for mutable tags like :latest)
 * resp-200: {updateAvailable:boolean!, currentImage:string, newImage:string, latestVersion:string, currentDigest:string, newDigest:string, containerName:string, isComposeManaged:boolean, isLocalImage:boolean, error:string} (also used for "not running in Docker" / inspection / changelog / registry failures — reported as updateAvailable:false + error, not an HTTP error status)
 * resp-403: Admin access required
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
