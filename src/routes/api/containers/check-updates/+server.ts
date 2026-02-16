import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { listContainers, inspectContainer, checkImageUpdateAvailable } from '$lib/server/docker';
import { clearPendingContainerUpdates, addPendingContainerUpdate } from '$lib/server/db';
import { isSystemContainer } from '$lib/server/scheduler/tasks/update-utils';

export interface UpdateCheckResult {
	containerId: string;
	containerName: string;
	imageName: string;
	hasUpdate: boolean;
	currentDigest?: string;
	newDigest?: string;
	error?: string;
	isLocalImage?: boolean;
	systemContainer?: 'dockhand' | 'hawser' | null;
}

/**
 * Check all containers for available image updates.
 * Returns all results at once after checking in parallel.
 */
export const POST: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Need at least view permission
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		// Clear existing pending updates for this environment before checking
		if (envIdNum) {
			await clearPendingContainerUpdates(envIdNum);
		}

		const allContainers = await listContainers(true, envIdNum);

		// Include all containers (system containers get flagged, not filtered)
		const containers = allContainers;

		// Check container for updates
		const checkContainer = async (container: typeof containers[0]): Promise<UpdateCheckResult> => {
			try {
				// Get container's image name from config
				const inspectData = await inspectContainer(container.id, envIdNum) as any;
				const imageName = inspectData.Config?.Image;
				const currentImageId = inspectData.Image;

				if (!imageName) {
					return {
						containerId: container.id,
						containerName: container.name,
						imageName: container.image,
						hasUpdate: false,
						error: 'Could not determine image name',
						systemContainer: isSystemContainer(container.image) || null
					};
				}

				// Use shared update detection function
				const result = await checkImageUpdateAvailable(imageName, currentImageId, envIdNum);

				return {
					containerId: container.id,
					containerName: container.name,
					imageName,
					hasUpdate: result.hasUpdate,
					currentDigest: result.currentDigest,
					newDigest: result.registryDigest,
					error: result.error,
					isLocalImage: result.isLocalImage,
					systemContainer: isSystemContainer(imageName) || null
				};
			} catch (error: any) {
				return {
					containerId: container.id,
					containerName: container.name,
					imageName: container.image,
					hasUpdate: false,
					error: error.message,
					systemContainer: isSystemContainer(container.image) || null
				};
			}
		};

		// Check all containers in parallel
		const results = await Promise.all(containers.map(checkContainer));

		const updatesFound = results.filter(r => r.hasUpdate).length;

		// Save containers with updates to the database for persistence
		// Skip system containers (Dockhand/Hawser) - they use their own update paths
		if (envIdNum) {
			for (const result of results) {
				if (result.hasUpdate && !result.systemContainer) {
					await addPendingContainerUpdate(
						envIdNum,
						result.containerId,
						result.containerName,
						result.imageName
					);
				}
			}
		}

		return json({
			total: containers.length,
			updatesFound,
			results
		});
	} catch (error: any) {
		console.error('Error checking for updates:', error);
		return json({ error: 'Failed to check for updates', details: error.message }, { status: 500 });
	}
};
