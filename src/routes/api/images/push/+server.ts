import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectImage, tagImage, pushImage, parseRegistryUrl } from '$lib/server/docker';
import { getRegistry, getEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditImage } from '$lib/server/audit';
import { sendEdgeStreamRequest, isEdgeConnected } from '$lib/server/hawser';
import { prefersJSON } from '$lib/server/sse';
import { createJob, appendLine, completeJob, failJob } from '$lib/server/jobs';

/**
 * Check if environment is edge mode
 */
async function isEdgeMode(envId?: number): Promise<{ isEdge: boolean; environmentId?: number }> {
	if (!envId) {
		return { isEdge: false };
	}
	const env = await getEnvironment(envId);
	if (env?.connectionType === 'hawser-edge') {
		return { isEdge: true, environmentId: envId };
	}
	return { isEdge: false };
}

export const POST: RequestHandler = async (event) => {
	const { request, url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('images', 'push', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const { imageId, imageName, registryId, newTag } = await request.json();

		if (!imageId || !registryId) {
			return json({ error: 'Image ID and registry ID are required' }, { status: 400 });
		}

		const registry = await getRegistry(registryId);
		if (!registry) {
			return json({ error: 'Registry not found' }, { status: 404 });
		}

		// Get the image info
		const imageInfo = await inspectImage(imageId, envIdNum) as any;

		// Determine the source tag to use
		let sourceTag = imageName;
		if (!sourceTag && imageInfo.RepoTags && imageInfo.RepoTags.length > 0) {
			sourceTag = imageInfo.RepoTags[0];
		}

		if (!sourceTag || sourceTag === '<none>:<none>') {
			return json({ error: 'Image has no tag. Please provide a tag name.' }, { status: 400 });
		}

		// Extract just the image name (without registry prefix if any)
		let baseImageName = sourceTag;
		// Remove any existing registry prefix (e.g., "registry.example.com/myimage:tag" -> "myimage:tag")
		if (baseImageName.includes('/')) {
			const parts = baseImageName.split('/');
			// Check if first part looks like a registry (contains . or :)
			if (parts[0].includes('.') || parts[0].includes(':')) {
				baseImageName = parts.slice(1).join('/');
			}
		}

		// Build the target tag
		// Parse registry URL to get host and org path separately
		const { host: registryHost, fullRegistry } = parseRegistryUrl(registry.url);

		// Check if this is Docker Hub
		const isDockerHub = registryHost.includes('docker.io') ||
			registryHost.includes('hub.docker.com') ||
			registryHost.includes('registry.hub.docker.com') ||
			registryHost.includes('index.docker.io');

		// Use custom tag if provided, otherwise use the base image name
		const targetImageName = newTag || baseImageName;
		// Docker Hub doesn't need host prefix - just username/image:tag
		// For other registries, use full registry path including org (e.g., registry.example.com/org/image:tag)
		const targetTag = isDockerHub ? targetImageName : `${fullRegistry}/${targetImageName}`;

		// Parse repo and tag properly (handle registry:port/image:tag format)
		// Find the last colon that's after the last slash (that's the tag separator)
		const lastSlashIndex = targetTag.lastIndexOf('/');
		const tagPart = targetTag.substring(lastSlashIndex + 1);
		const colonInTagIndex = tagPart.lastIndexOf(':');

		let repo: string;
		let tag: string;

		if (colonInTagIndex !== -1) {
			// Tag exists after the last slash
			repo = targetTag.substring(0, lastSlashIndex + 1 + colonInTagIndex);
			tag = tagPart.substring(colonInTagIndex + 1);
		} else {
			// No tag, use 'latest'
			repo = targetTag;
			tag = 'latest';
		}

		// Prepare auth config
		// Docker Hub uses index.docker.io/v1 for auth
		const authServerAddress = isDockerHub ? 'https://index.docker.io/v1/' : registryHost;
		const authConfig = registry.username && registry.password
			? {
				username: registry.username,
				password: registry.password,
				serveraddress: authServerAddress
			}
			: {
				serveraddress: authServerAddress
			};

		// Check if this is an edge environment
		const edgeCheck = await isEdgeMode(envIdNum);

		const formatError = (error: any): string => {
			const errorMessage = error.message || error || '';
			let userMessage = errorMessage || 'Failed to push image';

			if (error.statusCode === 401 || errorMessage.includes('401')) {
				userMessage = 'Authentication failed. Check registry credentials.';
			} else if (error.statusCode === 404 || errorMessage.includes('404')) {
				userMessage = 'Image not found';
			} else if (errorMessage.includes('https') || errorMessage.includes('tls') || errorMessage.includes('certificate') || errorMessage.includes('x509')) {
				userMessage = `TLS/HTTPS error. If your registry uses HTTP, add it to Docker's insecure-registries in /etc/docker/daemon.json`;
			}

			return userMessage;
		};

		// Core push logic — emit callback receives progress data objects
		async function runPush(emit: (data: unknown) => void): Promise<void> {
			emit({ status: 'tagging', message: 'Tagging image...' });
			await tagImage(imageId, repo, tag, envIdNum);
			emit({ status: 'pushing', message: 'Pushing to registry...' });

			if (edgeCheck.isEdge && edgeCheck.environmentId) {
				if (!isEdgeConnected(edgeCheck.environmentId)) {
					emit({ status: 'error', error: 'Edge agent not connected' });
					return;
				}

				const authHeader = Buffer.from(JSON.stringify(authConfig)).toString('base64');

				await new Promise<void>((resolve, reject) => {
					sendEdgeStreamRequest(
						edgeCheck.environmentId!,
						'POST',
						`/images/${encodeURIComponent(targetTag)}/push`,
						{
							onData: (data: string) => {
								try {
									const decoded = Buffer.from(data, 'base64').toString('utf-8');
									for (const line of decoded.split('\n').filter((l) => l.trim())) {
										try {
											const progress = JSON.parse(line);
											emit(progress.error ? { status: 'error', error: formatError(progress.error) } : progress);
										} catch { /* ignore partial lines */ }
									}
								} catch {
									try {
										const progress = JSON.parse(data);
										emit(progress.error ? { status: 'error', error: formatError(progress.error) } : progress);
									} catch { /* ignore */ }
								}
							},
							onEnd: async () => {
								await auditImage(event, 'push', imageId, imageName || targetTag, envIdNum, { targetTag, registry: registry.name });
								emit({ status: 'complete', message: `Image pushed to ${targetTag}`, targetTag });
								resolve();
							},
							onError: (error: string) => {
								console.error('Edge push error:', error);
								emit({ status: 'error', error: formatError(error) });
								reject(new Error(error));
							}
						},
						undefined,
						{ 'X-Registry-Auth': authHeader }
					);
				});
			} else {
				await pushImage(targetTag, authConfig, (progress) => emit(progress), envIdNum);
				await auditImage(event, 'push', imageId, imageName || targetTag, envIdNum, { targetTag, registry: registry.name });
				emit({ status: 'complete', message: `Image pushed to ${targetTag}`, targetTag });
			}
		}

		// Sync path for API clients sending Accept: application/json only
		if (prefersJSON(request)) {
			try {
				let lastEvent: unknown = null;
				await runPush((data) => { lastEvent = data; });
				return json(lastEvent || { success: true });
			} catch (error: any) {
				return json({ status: 'error', error: formatError(error) }, { status: 500 });
			}
		}

		// Job pattern: return jobId immediately, push runs in background
		const job = createJob();
		(async () => {
			try {
				await runPush((data) => appendLine(job, { data }));
				completeJob(job, job.lines[job.lines.length - 1]?.data ?? { success: true });
			} catch (error: any) {
				appendLine(job, { data: { status: 'error', error: formatError(error) } });
				failJob(job, error.message);
			}
		})();
		return json({ jobId: job.id });
	} catch (error: any) {
		console.error('Error setting up push:', error);
		return json({ error: error.message || 'Failed to push image' }, { status: 500 });
	}
};
