import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getOwnContainerId, getHostDockerSocket } from '$lib/server/host-path';
import type { RequestHandler } from './$types';

const UPDATER_IMAGE = 'fnsys/dockhand-updater:latest';
const UPDATER_LABEL = 'dockhand.updater';

/**
 * Fetch from the local Docker socket directly.
 * Self-update always operates on the local engine — no environment routing needed.
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
 * Pull an image via local Docker socket, streaming progress via callback.
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

	const response = await localDockerFetch(
		`/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
		{ method: 'POST' }
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
 * Check if Docker socket is mounted read-write
 */
async function isDockerSocketWritable(containerId: string): Promise<boolean> {
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

	const writable = await isDockerSocketWritable(containerId);
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

	const socketHostPath = getHostDockerSocket();

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
						HostConfig: {
							AutoRemove: true,
							Binds: [
								`${socketHostPath}:/var/run/docker.sock`
							]
						}
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

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive'
		}
	});
};
