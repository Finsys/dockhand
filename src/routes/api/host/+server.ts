import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDockerInfo, getHawserInfo } from '$lib/server/docker';
import { getEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { getEdgeConnectionInfo } from '$lib/server/hawser';
import os from 'node:os';

export interface HostInfo {
	hostname: string;
	ipAddress: string;
	platform: string;
	arch: string;
	cpus: number;
	totalMemory: number;
	freeMemory: number;
	uptime: number;
	dockerVersion: string;
	dockerContainers: number;
	dockerContainersRunning: number;
	dockerImages: number;
	environment: {
		id: number;
		name: string;
		icon?: string;
		socketPath?: string;
		connectionType?: string;
		hawserVersion?: string;
		highlightChanges?: boolean;
	};
}

function getLocalIpAddress(): string {
	const interfaces = os.networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		const netInterface = interfaces[name];
		if (!netInterface) continue;
		for (const net of netInterface) {
			// Skip internal and non-IPv4 addresses
			if (!net.internal && net.family === 'IPv4') {
				return net.address;
			}
		}
	}
	return '127.0.0.1';
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	// Check basic environment view permission
	if (auth.authEnabled && !await auth.can('environments', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		// Get environment ID from query param, or use default
		const envIdParam = url.searchParams.get('env');
		let env;

		if (envIdParam) {
			const envId = parseInt(envIdParam);
			// Check if user can access this specific environment
			if (auth.authEnabled && auth.isEnterprise && !await auth.canAccessEnvironment(envId)) {
				return json({ error: 'Access denied to this environment' }, { status: 403 });
			}
			env = await getEnvironment(envId);
		}

		if (!env) {
			// No environment specified - return basic local info
			return json({
				hostname: os.hostname(),
				ipAddress: getLocalIpAddress(),
				platform: os.platform(),
				arch: os.arch(),
				cpus: os.cpus().length,
				totalMemory: os.totalmem(),
				freeMemory: os.freemem(),
				uptime: os.uptime(),
				dockerVersion: null,
				dockerContainers: 0,
				dockerContainersRunning: 0,
				dockerImages: 0,
				environment: null
			});
		}

		// Determine if this is a truly local connection (socket without remote host)
		const isSocketType = env.connectionType === 'socket' || !env.connectionType;
		const isLocalConnection = isSocketType && (!env.host || env.host === 'localhost' || env.host === '127.0.0.1');

		// Fetch Docker info and Hawser info in parallel for hawser-standard mode
		let dockerInfo: any;
		let uptime = 0;
		let hawserVersion: string | undefined;

		if (env.connectionType === 'hawser-standard') {
			// Parallel fetch for hawser-standard
			const [dockerResult, hawserInfo] = await Promise.all([
				getDockerInfo(env.id),
				getHawserInfo(env.id)
			]);
			dockerInfo = dockerResult;
			if (hawserInfo?.uptime) {
				uptime = hawserInfo.uptime;
			}
			if (hawserInfo?.hawserVersion) {
				hawserVersion = hawserInfo.hawserVersion;
			}
		} else {
			// Sequential for other connection types
			dockerInfo = await getDockerInfo(env.id);

			if (isLocalConnection) {
				uptime = os.uptime();
			} else if (env.connectionType === 'hawser-edge') {
				// For Hawser edge mode, get from edge connection metrics (sync lookup)
				const edgeConn = getEdgeConnectionInfo(env.id);
				if (edgeConn?.lastMetrics?.uptime) {
					uptime = edgeConn.lastMetrics.uptime;
				}
			}
			// For 'direct' connections without Hawser, uptime remains 0 (not available)
		}

		const hostInfo: HostInfo = {
			// For local connections, show local system info; for remote, show Docker host info
			hostname: isLocalConnection ? os.hostname() : (dockerInfo.Name || env.host || 'unknown'),
			ipAddress: isLocalConnection ? getLocalIpAddress() : (env.host || 'unknown'),
			platform: isLocalConnection ? os.platform() : (dockerInfo.OperatingSystem || 'unknown'),
			arch: isLocalConnection ? os.arch() : (dockerInfo.Architecture || 'unknown'),
			cpus: isLocalConnection ? os.cpus().length : (dockerInfo.NCPU || 0),
			totalMemory: isLocalConnection ? os.totalmem() : (dockerInfo.MemTotal || 0),
			freeMemory: isLocalConnection ? os.freemem() : 0, // Not available from Docker API
			uptime,
			dockerVersion: dockerInfo.ServerVersion || 'unknown',
			dockerContainers: dockerInfo.Containers || 0,
			dockerContainersRunning: dockerInfo.ContainersRunning || 0,
			dockerImages: dockerInfo.Images || 0,
			environment: {
				id: env.id,
				name: env.name,
				icon: env.icon,
				socketPath: env.socketPath,
				connectionType: env.connectionType || 'socket',
				// For standard mode, use live-fetched version; for edge mode, use stored version
				hawserVersion: hawserVersion || env.hawserVersion,
				highlightChanges: env.highlightChanges
			}
		};

		return json(hostInfo);
	} catch (error) {
		console.error('Failed to get host info:', (error as Error)?.message ?? error);
		return json({ error: 'Failed to get host info' }, { status: 500 });
	}
};
