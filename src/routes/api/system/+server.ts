import { json } from '@sveltejs/kit';
import {
	getDockerInfo,
	getDockerVersion,
	listContainers,
	listImages,
	listVolumes,
	listNetworks,
	getDockerConnectionInfo
} from '$lib/server/docker';
import { getStackSources } from '$lib/server/db';
import { isPostgres, isSqlite, getDatabaseSchemaVersion, getPostgresConnectionInfo } from '$lib/server/db/drizzle';
import { hasEnvironments } from '$lib/server/db';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { authorize } from '$lib/server/authorize';

// Detect if running inside a Docker container
function detectContainerRuntime(): { inContainer: boolean; runtime?: string; containerId?: string } {
	// Check for .dockerenv file (Docker)
	if (existsSync('/.dockerenv')) {
		let containerId: string | undefined;
		try {
			// Try to get container ID from hostname (Docker sets it)
			containerId = os.hostname();
			// Validate it looks like a container ID (12+ hex chars)
			if (!/^[a-f0-9]{12,}$/i.test(containerId)) {
				containerId = undefined;
			}
		} catch {}
		return { inContainer: true, runtime: 'docker', containerId };
	}

	// Check cgroup for container indicators
	try {
		if (existsSync('/proc/1/cgroup')) {
			const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
			if (cgroup.includes('docker') || cgroup.includes('containerd') || cgroup.includes('kubepods')) {
				const runtime = cgroup.includes('kubepods') ? 'kubernetes' :
					cgroup.includes('containerd') ? 'containerd' : 'docker';
				return { inContainer: true, runtime };
			}
		}
	} catch {}

	return { inContainer: false };
}

// Get Bun runtime info
function getBunInfo() {
	const memUsage = process.memoryUsage();
	return {
		version: typeof Bun !== 'undefined' ? Bun.version : null,
		revision: typeof Bun !== 'undefined' ? Bun.revision?.slice(0, 7) : null,
		memory: {
			heapUsed: memUsage.heapUsed,
			heapTotal: memUsage.heapTotal,
			rss: memUsage.rss,
			external: memUsage.external
		}
	};
}

// Get info about our own container if running in Docker
async function getOwnContainerInfo(containerId: string | undefined): Promise<any> {
	if (!containerId) return null;

	try {
		// Try to inspect our own container via local socket
		const socketPaths = [
			'/var/run/docker.sock',
			process.env.DOCKER_SOCKET
		].filter(Boolean);

		for (const socketPath of socketPaths) {
			if (!socketPath || !existsSync(socketPath)) continue;

			try {
				const response = await fetch(`http://localhost/containers/${containerId}/json`, {
					// @ts-ignore - Bun supports unix socket
					unix: socketPath
				});

				if (response.ok) {
					const info = await response.json();
					return {
						id: info.Id?.slice(0, 12),
						name: info.Name?.replace(/^\//, ''),
						image: info.Config?.Image,
						imageId: info.Image?.slice(7, 19), // Remove 'sha256:' prefix
						created: info.Created,
						status: info.State?.Status,
						restartCount: info.RestartCount,
						labels: {
							version: info.Config?.Labels?.['org.opencontainers.image.version'],
							revision: info.Config?.Labels?.['org.opencontainers.image.revision']
						}
					};
				}
			} catch {}
		}
	} catch {}

	return null;
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	// Check basic environment view permission
	if (auth.authEnabled && !await auth.can('environments', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const envId = url.searchParams.get('env') ? parseInt(url.searchParams.get('env')!) : null;

		// Check environment access in enterprise mode
		if (envId && auth.authEnabled && auth.isEnterprise && !await auth.canAccessEnvironment(envId)) {
			return json({ error: 'Access denied to this environment' }, { status: 403 });
		}
		const schemaVersion = await getDatabaseSchemaVersion();

		// Try to get Docker info, but don't fail if Docker isn't available
		let dockerInfo = null;
		let dockerVersion = null;
		let connectionInfo = null;
		let containers: any[] = [];
		let images: any[] = [];
		let volumes: any[] = [];
		let networks: any[] = [];

		// Only try Docker connection if environment is specified
		if (envId) {
			try {
				[dockerInfo, dockerVersion, containers, images, volumes, networks, connectionInfo] = await Promise.all([
					getDockerInfo(envId),
					getDockerVersion(envId),
					listContainers(true, envId),
					listImages(envId),
					listVolumes(envId),
					listNetworks(envId),
					getDockerConnectionInfo(envId)
				]);
			} catch (dockerError) {
				// Docker not available - continue with null values
				console.log('Docker not available for system info:', dockerError instanceof Error ? dockerError.message : String(dockerError));
			}
		}

		const stacks = await getStackSources();
		const runningContainers = containers.filter(c => c.state === 'running').length;
		const stoppedContainers = containers.length - runningContainers;

		const bunInfo = getBunInfo();
		const containerRuntime = detectContainerRuntime();
		const ownContainer = containerRuntime.inContainer
			? await getOwnContainerInfo(containerRuntime.containerId || os.hostname())
			: null;

		return json({
			docker: dockerInfo && dockerVersion ? {
				version: dockerVersion.Version,
				apiVersion: dockerVersion.ApiVersion,
				os: dockerInfo.OperatingSystem,
				arch: dockerInfo.Architecture,
				kernelVersion: dockerInfo.KernelVersion,
				serverVersion: dockerInfo.ServerVersion,
				connection: connectionInfo ? {
					type: connectionInfo.type,
					socketPath: connectionInfo.socketPath,
					host: connectionInfo.host,
					port: connectionInfo.port
				} : { type: 'socket' }
			} : null,
			host: dockerInfo ? {
				name: dockerInfo.Name,
				cpus: dockerInfo.NCPU,
				memory: dockerInfo.MemTotal,
				storageDriver: dockerInfo.Driver
			} : null,
			runtime: {
				bun: bunInfo.version,
				bunRevision: bunInfo.revision,
				nodeVersion: process.version,
				platform: os.platform(),
				arch: os.arch(),
				kernel: os.release(),
				memory: bunInfo.memory,
				container: containerRuntime,
				ownContainer
			},
			database: {
				type: isPostgres ? 'PostgreSQL' : 'SQLite',
				schemaVersion: schemaVersion.version,
				schemaDate: schemaVersion.date,
				...(isPostgres && getPostgresConnectionInfo() ? {
					host: getPostgresConnectionInfo()!.host,
					port: getPostgresConnectionInfo()!.port
				} : {})
			},
			stats: {
				containers: {
					total: containers.length,
					running: runningContainers,
					stopped: stoppedContainers
				},
				images: images.length,
				volumes: volumes.length,
				networks: networks.length,
				stacks: stacks.length
			}
		});
	} catch (error) {
		console.error('Error fetching system info:', error);
		return json({ error: 'Failed to fetch system info' }, { status: 500 });
	}
};
