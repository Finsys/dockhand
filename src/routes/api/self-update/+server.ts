import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getOwnContainerId, getHostDockerSocket, getOwnDockerHost, getOwnNetworkMode } from '$lib/server/host-path';
import { buildRegistryAuthHeader, unixSocketRequest, unixSocketStreamRequest } from '$lib/server/docker';
import type { RequestHandler } from './$types';
import { prefersJSON, sseToJSON } from '$lib/server/sse';

const UPDATER_IMAGE = 'fnsys/dockhand-updater:latest';
const UPDATER_LABEL = 'dockhand.updater';

/** Get TCP Docker host if configured, null otherwise. */
function getDockerTcpHost(): string | null {
	const dockerHost = process.env.DOCKER_HOST || getOwnDockerHost();
	return dockerHost?.startsWith('tcp://') ? dockerHost : null;
}

/** Fetch from the local Docker (buffered). Supports TCP and Unix socket. */
function localDockerFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const tcpHost = getDockerTcpHost();
	if (tcpHost) {
		return fetch(tcpHost.replace('tcp://', 'http://') + path, options);
	}
	const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
	return unixSocketRequest(socketPath, path, options);
}

/** Fetch from the local Docker (streaming body for pull progress). */
function localDockerStreamFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const tcpHost = getDockerTcpHost();
	if (tcpHost) {
		return fetch(tcpHost.replace('tcp://', 'http://') + path, options);
	}
	const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
	return unixSocketStreamRequest(socketPath, path, options);
}

/**
 * Pull an image via local Docker, streaming progress via callback.
 */
async function pullImageLocal(imageName: string, onProgress?: (line: string) => void): Promise<void> {
	let fromImage = imageName;
	let tag = 'latest';
	if (imageName.includes(':')) {
		const lastColon = imageName.lastIndexOf(':');
		const potentialTag = imageName.substring(lastColon + 1);
		if (!potentialTag.includes('/')) {
			fromImage = imageName.substring(0, lastColon);
			tag = potentialTag;
		}
	}

	const authHeaders = await buildRegistryAuthHeader(imageName);
	const response = await localDockerStreamFetch(
		`/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
		{ method: 'POST', headers: authHeaders }
	);

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to pull image: ${text}`);
	}

	const reader = response.body?.getReader();
	if (reader) {
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!onProgress || !value) continue;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const json = JSON.parse(line);
					if (json.error) {
						onProgress(`Error: ${json.error}`);
					} else if (json.status) {
						let msg = json.status;
						if (json.id) msg = `${json.id}: ${msg}`;
						if (json.progress) msg += ` ${json.progress}`;
						onProgress(msg);
					}
				} catch {
					onProgress(line.trim());
				}
			}
		}
	}
}

/**
 * Check if Docker access allows write operations.
 * TCP connections always allow writes (no RO mount concept).
 * Socket connections check if the mount is read-write.
 */
async function isDockerWritable(containerId: string): Promise<boolean> {
	// TCP connections don't have mount-level RO/RW — access implies full control
	if (getDockerTcpHost()) return true;

	const response = await localDockerFetch(`/containers/${containerId}/json`);
	if (!response.ok) return false;

	const info = await response.json() as {
		Mounts?: Array<{ Source: string; Destination: string; RW: boolean }>;
	};

	const socketDest = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
	const socketMount = info.Mounts?.find(m => m.Destination === socketDest);
	return socketMount?.RW ?? false;
}

/**
 * Remove any existing updater containers
 */
async function cleanupExistingUpdaters(): Promise<void> {
	const response = await localDockerFetch(
		`/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [UPDATER_LABEL + '=true'] }))}`
	);
	if (response.ok) {
		const containers = await response.json() as Array<{ Id: string; State: string }>;
		for (const container of containers) {
			if (container.State === 'running') {
				await localDockerFetch(`/containers/${container.Id}/stop`, { method: 'POST' });
			}
			await localDockerFetch(`/containers/${container.Id}?force=true`, { method: 'DELETE' });
		}
	}
}

/**
 * Build the container create config from inspect data (same logic as recreateContainerFromInspect).
 * Does NOT include NetworkingConfig — the new container is created without networks
 * to avoid static IP conflicts with the still-running old container.
 */
function buildCreateConfig(inspectData: any, newImage: string): any {
	const config = inspectData.Config || {};
	const hostConfig = inspectData.HostConfig || {};

	const createConfig: any = {
		...config,
		Image: newImage,
		HostConfig: { ...hostConfig }
	};

	// Clear MacAddress for Docker API < 1.44 compatibility
	delete createConfig.MacAddress;

	// Clear Entrypoint and Cmd so the new image's defaults are used.
	// This prevents carrying over a stale entrypoint from a previous runtime
	// (e.g. Bun's docker-entrypoint.sh → Node.js docker-entrypoint-node.sh).
	delete createConfig.Entrypoint;
	delete createConfig.Cmd;

	// Clear Hostname so Docker assigns the new container's own ID
	// Otherwise the old container's hostname is inherited, breaking self-identification
	delete createConfig.Hostname;

	// Preserve anonymous volumes from Mounts not in HostConfig.Binds
	const existingBinds = new Set((hostConfig.Binds || []).map((b: string) => {
		const parts = b.split(':');
		return parts.length >= 2 ? parts[1] : parts[0];
	}));
	const mounts = inspectData.Mounts || [];
	const additionalBinds: string[] = [];
	for (const mount of mounts) {
		if (mount.Type === 'volume' && mount.Name && mount.Destination) {
			if (!existingBinds.has(mount.Destination)) {
				additionalBinds.push(`${mount.Name}:${mount.Destination}`);
			}
		}
	}
	if (additionalBinds.length > 0) {
		createConfig.HostConfig = {
			...createConfig.HostConfig,
			Binds: [...(createConfig.HostConfig.Binds || []), ...additionalBinds]
		};
	}

	// No NetworkingConfig — avoids static IP conflicts with still-running old container.
	// Networks are connected by the sidecar after the old container is removed.

	return createConfig;
}

/**
 * Build NETWORKS and NETWORK_OPTS_* env vars from inspect data's NetworkSettings.
 * The sidecar uses these to reconnect networks via `docker network connect` CLI.
 */
function buildNetworkEnvVars(inspectData: any): string[] {
	const networks: Record<string, any> = inspectData.NetworkSettings?.Networks || {};
	const entries = Object.entries(networks);
	if (entries.length === 0) return [];

	const networkNames: string[] = [];
	const envVars: string[] = [];

	for (const [netName, netConfig] of entries) {
		networkNames.push(netName);

		const nc = netConfig as any;
		const opts: string[] = [];

		if (nc.IPAMConfig?.IPv4Address) {
			opts.push(`--ip ${nc.IPAMConfig.IPv4Address}`);
		}
		if (nc.IPAMConfig?.IPv6Address) {
			opts.push(`--ip6 ${nc.IPAMConfig.IPv6Address}`);
		}
		if (nc.Aliases && nc.Aliases.length > 0) {
			for (const alias of nc.Aliases) {
				opts.push(`--alias ${alias}`);
			}
		}
		if (nc.Links && nc.Links.length > 0) {
			for (const link of nc.Links) {
				opts.push(`--link ${link}`);
			}
		}

		if (opts.length > 0) {
			// Env var name: dots and dashes become underscores
			const safeNetName = netName.replace(/[.-]/g, '_');
			envVars.push(`NETWORK_OPTS_${safeNetName}=${opts.join(' ')}`);
		}
	}

	envVars.unshift(`NETWORKS=${networkNames.join(' ')}`);
	return envVars;
}

/**
 * SSE stream endpoint for self-update.
 * Pulls image, creates new container, then launches minimal sidecar.
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	const body = await request.json().catch(() => ({})) as { newImage?: string };
	const newImage = body.newImage;
	if (!newImage) {
		return json({ error: 'newImage is required' }, { status: 400 });
	}

	// Fail-fast validation before starting SSE stream
	const containerId = getOwnContainerId();
	if (!containerId) {
		return json({ error: 'Not running in Docker' }, { status: 400 });
	}

	const writable = await isDockerWritable(containerId);
	if (!writable) {
		return json({
			error: 'Docker socket is mounted read-only. Self-update requires read-write Docker socket access.'
		}, { status: 400 });
	}

	const nameResponse = await localDockerFetch(`/containers/${containerId}/json`);
	if (!nameResponse.ok) {
		return json({ error: 'Failed to inspect own container' }, { status: 500 });
	}
	const nameInfo = await nameResponse.json() as { Name?: string };
	const containerName = nameInfo.Name?.replace(/^\//, '') || '';
	if (!containerName) {
		return json({ error: 'Failed to determine container name' }, { status: 500 });
	}

	// Start SSE stream for preparation progress
	const encoder = new TextEncoder();
	let controllerClosed = false;

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: any) => {
				if (controllerClosed) return;
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					controllerClosed = true;
				}
			};

			const sendStep = (step: string, status: string, message: string) => {
				send('step', { step, status, message });
			};

			let newContainerId: string | null = null;

			try {
				// Step 1: Pull the new Dockhand image
				sendStep('pulling_image', 'active', `Pulling ${newImage}...`);
				send('log', { message: `Pulling ${newImage}...` });
				await pullImageLocal(newImage, (msg) => send('log', { message: msg }));
				sendStep('pulling_image', 'completed', 'Image pulled');
				send('log', { message: 'Image pulled successfully' });

				// Step 2: Build container config from self-inspect
				sendStep('building_config', 'active', 'Building container config...');
				send('log', { message: `Inspecting container ${containerId.substring(0, 12)}...` });
				const inspectResponse = await localDockerFetch(`/containers/${containerId}/json`);
				if (!inspectResponse.ok) {
					throw new Error('Failed to inspect own container');
				}
				const inspectData = await inspectResponse.json();
				const createConfig = buildCreateConfig(inspectData, newImage);
				const networkEnvVars = buildNetworkEnvVars(inspectData);
				send('log', { message: `Networks: ${networkEnvVars.length > 0 ? networkEnvVars[0] : 'default'}` });
				sendStep('building_config', 'completed', 'Config ready');

				// Step 3: Pull the updater image
				sendStep('pulling_updater', 'active', 'Pulling updater image...');
				send('log', { message: `Pulling ${UPDATER_IMAGE}...` });
				await pullImageLocal(UPDATER_IMAGE, (msg) => send('log', { message: msg }));
				sendStep('pulling_updater', 'completed', 'Updater ready');
				send('log', { message: 'Updater image ready' });

				// Step 4: Create new container with temp name (no NetworkingConfig)
				sendStep('creating_container', 'active', 'Creating new container...');
				send('log', { message: 'Cleaning up previous updater containers...' });
				await cleanupExistingUpdaters();

				// Also clean up any leftover -updating containers from previous attempts
				const staleResponse = await localDockerFetch(
					`/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ name: [`${containerName}-updating`] }))}`
				);
				if (staleResponse.ok) {
					const stale = await staleResponse.json() as Array<{ Id: string; State: string }>;
					for (const c of stale) {
						if (c.State === 'running') {
							await localDockerFetch(`/containers/${c.Id}/stop`, { method: 'POST' }).catch(() => {});
						}
						await localDockerFetch(`/containers/${c.Id}?force=true`, { method: 'DELETE' }).catch(() => {});
					}
				}

				const tempName = `${containerName}-updating`;
				const createResponse = await localDockerFetch(
					`/containers/create?name=${encodeURIComponent(tempName)}`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(createConfig)
					}
				);

				if (!createResponse.ok) {
					const errText = await createResponse.text();
					throw new Error(`Failed to create container: ${errText}`);
				}

				const createResult = await createResponse.json() as { Id: string };
				newContainerId = createResult.Id;
				console.log(`[SelfUpdate] New container created: ${newContainerId.substring(0, 12)} (${tempName})`);
				send('log', { message: `Container created: ${newContainerId.substring(0, 12)} (${tempName})` });
				sendStep('creating_container', 'completed', 'Container created');

				// Step 5: Launch updater sidecar (point of no return)
				sendStep('launching_updater', 'active', 'Launching updater...');

				const updaterEnv = [
					`OLD_CONTAINER_ID=${containerId}`,
					`NEW_CONTAINER_ID=${newContainerId}`,
					`CONTAINER_NAME=${containerName}`,
					...networkEnvVars
				];

				// Pin Docker API version so the updater's bundled Docker CLI
				// doesn't request a version newer than the host daemon supports
				// (e.g. Synology DSM with Docker 24.x / API 1.43)
				if (process.env.DOCKER_API_VERSION) {
					updaterEnv.push(`DOCKER_API_VERSION=${process.env.DOCKER_API_VERSION}`);
					console.log(`[SelfUpdate] Forwarding explicit DOCKER_API_VERSION: ${process.env.DOCKER_API_VERSION}`);
				} else {
					try {
						const versionResp = await localDockerFetch('/version');
						if (versionResp.ok) {
							const versionInfo = await versionResp.json() as { ApiVersion?: string };
							if (versionInfo.ApiVersion) {
								updaterEnv.push(`DOCKER_API_VERSION=${versionInfo.ApiVersion}`);
								console.log(`[SelfUpdate] Using negotiated Docker API version: ${versionInfo.ApiVersion}`);
							}
						}
					} catch {
						console.warn('[SelfUpdate] Could not detect Docker API version, updater will negotiate on its own');
					}
				}

				// Configure updater's Docker access based on connection type
				const tcpHost = getDockerTcpHost();
				const updaterHostConfig: Record<string, unknown> = { AutoRemove: true };

				if (tcpHost) {
					// TCP: pass DOCKER_HOST so docker CLI in sidecar uses TCP
					updaterEnv.push(`DOCKER_HOST=${tcpHost}`);
					// Put sidecar on same network so it can reach the Docker TCP endpoint
					const network = getOwnNetworkMode();
					if (network) {
						updaterHostConfig.NetworkMode = network;
					}
					send('log', { message: `Updater using TCP: ${tcpHost}` });
				} else {
					// Socket: bind-mount the host Docker socket
					const socketHostPath = getHostDockerSocket();
					updaterHostConfig.Binds = [`${socketHostPath}:/var/run/docker.sock`];
				}

				console.log('[SelfUpdate] Creating updater container...');
				const updaterResponse = await localDockerFetch('/containers/create?name=dockhand-updater', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						Image: UPDATER_IMAGE,
						Env: updaterEnv,
						Labels: {
							[UPDATER_LABEL]: 'true'
						},
						HostConfig: updaterHostConfig
					})
				});

				if (!updaterResponse.ok) {
					const errText = await updaterResponse.text();
					throw new Error(`Failed to create updater container: ${errText}`);
				}

				const { Id: updaterId } = await updaterResponse.json() as { Id: string };

				// Start the updater
				const startResponse = await localDockerFetch(`/containers/${updaterId}/start`, { method: 'POST' });
				if (!startResponse.ok) {
					await localDockerFetch(`/containers/${updaterId}?force=true`, { method: 'DELETE' });
					throw new Error('Failed to start updater container');
				}

				console.log(`[SelfUpdate] Updater started (${updaterId.substring(0, 12)}). Dockhand will be stopped shortly.`);
				send('log', { message: `Updater started: ${updaterId.substring(0, 12)}` });
				send('log', { message: 'Handing off to updater sidecar...' });
				sendStep('launching_updater', 'completed', 'Updater launched');
				send('launched', { updaterId });
			} catch (err: any) {
				console.error('[SelfUpdate] Error:', err);
				send('error', { step: 'preparation', message: err.message || String(err) });

				// Clean up the pre-created container on failure
				if (newContainerId) {
					await localDockerFetch(`/containers/${newContainerId}?force=true`, { method: 'DELETE' }).catch(() => {});
				}
			} finally {
				if (!controllerClosed) {
					try { controller.close(); } catch { /* already closed */ }
				}
			}
		}
	});

	const sseResponse = new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
	if (prefersJSON(request)) return sseToJSON(sseResponse);
	return sseResponse;
};
