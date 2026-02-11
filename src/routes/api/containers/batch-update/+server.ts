import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { listContainers, pullImage, inspectContainer } from '$lib/server/docker';
import { auditContainer } from '$lib/server/audit';
import { recreateContainer } from '$lib/server/scheduler/tasks/container-update';

export interface BatchUpdateResult {
	containerId: string;
	containerName: string;
	success: boolean;
	error?: string;
}

/**
 * Batch update containers by recreating them with latest images.
 * Preserves ALL container settings including health checks, resource limits,
 * capabilities, DNS, security options, ulimits, and network connections.
 * Expects JSON body: { containerIds: string[] }
 */
export const POST: RequestHandler = async (event) => {
	const { url, cookies, request } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Need create permission to recreate containers
	if (auth.authEnabled && !await auth.can('containers', 'create', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { containerIds } = body as { containerIds: string[] };

		if (!containerIds || !Array.isArray(containerIds) || containerIds.length === 0) {
			return json({ error: 'containerIds array is required' }, { status: 400 });
		}

		const results: BatchUpdateResult[] = [];

		// Process containers sequentially to avoid resource conflicts
		for (const containerId of containerIds) {
			try {
				const containers = await listContainers(true, envIdNum);
				const container = containers.find(c => c.id === containerId);

				if (!container) {
					results.push({
						containerId,
						containerName: 'unknown',
						success: false,
						error: 'Container not found'
					});
					continue;
				}

				// Get full container config
				const inspectData = await inspectContainer(containerId, envIdNum) as any;
				const config = inspectData.Config;
				const imageName = config.Image;
				const containerName = container.name;

				// Pull latest image first
				try {
					await pullImage(imageName, undefined, envIdNum);
				} catch (pullError: any) {
					results.push({
						containerId,
						containerName,
						success: false,
						error: `Pull failed: ${pullError.message}`
					});
					continue;
				}

				let updateSuccess = false;
				let newContainerId = containerId;

				updateSuccess = await recreateContainer(containerName, envIdNum);
				if (updateSuccess) {
					const updatedContainers = await listContainers(true, envIdNum);
					const updatedContainer = updatedContainers.find(c => c.name === containerName);
					if (updatedContainer) {
						newContainerId = updatedContainer.id;
					}
				}

				if (!updateSuccess) {
					results.push({
						containerId,
						containerName,
						success: false,
						error: 'Container recreation failed'
					});
					continue;
				}

				// Audit log
				await auditContainer(event, 'update', newContainerId, containerName, envIdNum, { batchUpdate: true });

				results.push({
					containerId: newContainerId,
					containerName,
					success: true
				});
			} catch (error: any) {
				results.push({
					containerId,
					containerName: 'unknown',
					success: false,
					error: error.message
				});
			}
		}

		const successCount = results.filter(r => r.success).length;
		const failCount = results.filter(r => !r.success).length;

		return json({
			success: failCount === 0,
			results,
			summary: {
				total: results.length,
				success: successCount,
				failed: failCount
			}
		});
	} catch (error: any) {
		console.error('Error in batch update:', error);
		return json({ error: 'Failed to batch update containers', details: error.message }, { status: 500 });
	}
};
