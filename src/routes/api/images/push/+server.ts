import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectImage, tagImage, pushImage, parseRegistryUrl } from '$lib/server/docker';
import { getRegistry, getEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditImage } from '$lib/server/audit';
import { sendEdgeStreamRequest, isEdgeConnected } from '$lib/server/hawser';

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

		// Stream the push progress
		const encoder = new TextEncoder();
		let controllerClosed = false;
		let controller: ReadableStreamDefaultController<Uint8Array>;
		let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
		let cancelEdgeStream: (() => void) | null = null;

		const safeEnqueue = (data: string) => {
			if (!controllerClosed) {
				try {
					controller.enqueue(encoder.encode(data));
				} catch {
					controllerClosed = true;
				}
			}
		};

		const cleanup = () => {
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval);
				heartbeatInterval = null;
			}
			if (cancelEdgeStream) {
				cancelEdgeStream();
				cancelEdgeStream = null;
			}
			controllerClosed = true;
		};

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

		const stream = new ReadableStream({
			async start(ctrl) {
				controller = ctrl;

				// Start heartbeat to keep connection alive through Traefik (10s idle timeout)
				heartbeatInterval = setInterval(() => {
					safeEnqueue(`: keepalive\n\n`);
				}, 5000);

				try {
					// Send tagging status
					safeEnqueue(`data: ${JSON.stringify({ status: 'tagging', message: 'Tagging image...' })}\n\n`);

					// Tag the image with the target registry
					await tagImage(imageId, repo, tag, envIdNum);

					// Send pushing status
					safeEnqueue(`data: ${JSON.stringify({ status: 'pushing', message: 'Pushing to registry...' })}\n\n`);

					// Handle edge mode with streaming
					if (edgeCheck.isEdge && edgeCheck.environmentId) {
						if (!isEdgeConnected(edgeCheck.environmentId)) {
							safeEnqueue(`data: ${JSON.stringify({ status: 'error', error: 'Edge agent not connected' })}\n\n`);
							cleanup();
							controller.close();
							return;
						}

						// Create X-Registry-Auth header
						const authHeader = Buffer.from(JSON.stringify(authConfig)).toString('base64');

						const { cancel } = sendEdgeStreamRequest(
							edgeCheck.environmentId,
							'POST',
							`/images/${encodeURIComponent(targetTag)}/push`,
							{
								onData: (data: string) => {
									// Data is base64 encoded JSON lines from Docker
									try {
										const decoded = Buffer.from(data, 'base64').toString('utf-8');
										const lines = decoded.split('\n').filter(line => line.trim());
										for (const line of lines) {
											try {
												const progress = JSON.parse(line);
												if (progress.error) {
													safeEnqueue(`data: ${JSON.stringify({ status: 'error', error: formatError(progress.error) })}\n\n`);
												} else {
													safeEnqueue(`data: ${JSON.stringify(progress)}\n\n`);
												}
											} catch {
												// Ignore parse errors for partial lines
											}
										}
									} catch {
										// If not base64, try as-is
										try {
											const progress = JSON.parse(data);
											if (progress.error) {
												safeEnqueue(`data: ${JSON.stringify({ status: 'error', error: formatError(progress.error) })}\n\n`);
											} else {
												safeEnqueue(`data: ${JSON.stringify(progress)}\n\n`);
											}
										} catch {
											// Ignore
										}
									}
								},
								onEnd: async () => {
									// Audit log
									await auditImage(event, 'push', imageId, imageName || targetTag, envIdNum, { targetTag, registry: registry.name });

									safeEnqueue(`data: ${JSON.stringify({
										status: 'complete',
										message: `Image pushed to ${targetTag}`,
										targetTag
									})}\n\n`);

									cleanup();
									controller.close();
								},
								onError: (error: string) => {
									console.error('Edge push error:', error);
									safeEnqueue(`data: ${JSON.stringify({ status: 'error', error: formatError(error) })}\n\n`);
									cleanup();
									controller.close();
								}
							},
							undefined,
							{ 'X-Registry-Auth': authHeader }
						);

						cancelEdgeStream = cancel;
					} else {
						// Non-edge mode: use existing pushImage function
						await pushImage(targetTag, authConfig, (progress) => {
							safeEnqueue(`data: ${JSON.stringify(progress)}\n\n`);
						}, envIdNum);

						// Audit log
						await auditImage(event, 'push', imageId, imageName || targetTag, envIdNum, { targetTag, registry: registry.name });

						// Send completion message
						safeEnqueue(`data: ${JSON.stringify({
							status: 'complete',
							message: `Image pushed to ${targetTag}`,
							targetTag
						})}\n\n`);

						cleanup();
						controller.close();
					}
				} catch (error: any) {
					console.error('Error pushing image:', error);
					safeEnqueue(`data: ${JSON.stringify({
						status: 'error',
						error: formatError(error)
					})}\n\n`);
					cleanup();
					controller.close();
				}
			},
			cancel() {
				cleanup();
			}
		});

		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'X-Accel-Buffering': 'no'
			}
		});
	} catch (error: any) {
		console.error('Error setting up push:', error);
		return json({ error: error.message || 'Failed to push image' }, { status: 500 });
	}
};
