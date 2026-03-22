import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { listContainers, inspectContainer, checkImageUpdateAvailable } from '$lib/server/docker';
import { clearPendingContainerUpdates, addPendingContainerUpdate } from '$lib/server/db';
import { isSystemContainer } from '$lib/server/scheduler/tasks/update-utils';
import { createJobResponse } from '$lib/server/sse';

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
 * Returns progress events during checking, final result when done.
 */
export const POST: RequestHandler = async ({ url, cookies, request }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Need at least view permission
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	return createJobResponse(async (send) => {
		// Clear existing pending updates for this environment before checking
		if (envIdNum) {
			await clearPendingContainerUpdates(envIdNum);
		}

		const allContainers = await listContainers(true, envIdNum);
		const containers = allContainers;

		send('progress', { checked: 0, total: containers.length });

		// Check container for updates
		let checked = 0;
		const checkContainer = async (container: typeof containers[0]): Promise<UpdateCheckResult> => {
			try {
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

		// Sliding window concurrency limit to avoid DNS threadpool saturation (#676).
		const CONCURRENCY = 20;
		const results: UpdateCheckResult[] = new Array(containers.length);
		let next = 0;
		async function runNext(): Promise<void> {
			while (next < containers.length) {
				const idx = next++;
				results[idx] = await checkContainer(containers[idx]);
				checked++;
				send('progress', { checked, total: containers.length });
			}
		}
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, containers.length) }, () => runNext()));

		const updatesFound = results.filter(r => r.hasUpdate).length;

		// Save containers with updates to the database for persistence
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

		send('result', {
			total: containers.length,
			updatesFound,
			results
		});
	}, request);
};
