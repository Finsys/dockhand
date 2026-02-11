/**
 * Host Path Resolution Module
 *
 * Dockhand runs inside a Docker container where paths differ from the host.
 * This module detects the host paths for ALL container mounts, enabling proper
 * volume path resolution for compose stacks (both internal and adopted/external).
 *
 * Problem:
 * - Dockhand container has /app/data mounted from host (e.g., -v dockhand_data:/app/data)
 * - User may also mount external directories (e.g., -v /host/stacks:/external-stacks)
 * - Compose file says: ./ca.pem:/ca.pem (relative path)
 * - docker-compose resolves this to container path (e.g., /external-stacks/.../ca.pem)
 * - Docker daemon on HOST receives this path, but /external-stacks doesn't exist on host!
 * - Docker creates a directory instead of mounting the file
 *
 * Solution:
 * - Query Docker API to find ALL host source paths for our container mounts
 * - Rewrite relative paths in compose files to use the correct host path
 * - Works for both internal stacks (DATA_DIR) and adopted stacks (external mounts)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Cache the host data dir to avoid repeated API calls
let cachedHostDataDir: string | null = null;
let detectionAttempted = false;

// Cache ALL mounts for path translation (not just DATA_DIR)
let cachedMounts: Array<{ source: string; destination: string }> | null = null;

/**
 * Get our own container ID
 */
function getOwnContainerId(): string | null {
	// Method 1: From cgroup (works in most cases)
	try {
		const cgroup = readFileSync('/proc/self/cgroup', 'utf-8');
		// Look for docker container ID (64 hex chars)
		const match = cgroup.match(/[a-f0-9]{64}/);
		if (match) {
			return match[0];
		}
	} catch {
		// Can't read cgroup
	}

	// Method 2: From mountinfo
	try {
		const mountinfo = readFileSync('/proc/self/mountinfo', 'utf-8');
		const match = mountinfo.match(/\/docker\/containers\/([a-f0-9]{64})/);
		if (match) {
			return match[1];
		}
	} catch {
		// Can't read mountinfo
	}

	// Method 3: HOSTNAME might be container ID (short form)
	const hostname = process.env.HOSTNAME;
	if (hostname && /^[a-f0-9]{12}$/.test(hostname)) {
		return hostname;
	}

	return null;
}

/**
 * Get the host path for our DATA_DIR mount by inspecting our own container
 */
export async function detectHostDataDir(): Promise<string | null> {
	// Return cached value if already detected
	if (detectionAttempted) {
		return cachedHostDataDir;
	}
	detectionAttempted = true;

	// Check if user explicitly set HOST_DATA_DIR
	if (process.env.HOST_DATA_DIR) {
		cachedHostDataDir = process.env.HOST_DATA_DIR;
		console.log(`[HostPath] Using HOST_DATA_DIR from environment: ${cachedHostDataDir}`);
		return cachedHostDataDir;
	}

	const containerId = getOwnContainerId();
	if (!containerId) {
		console.warn('[HostPath] Running in Docker but could not detect container ID');
		return null;
	}

	console.log(`[HostPath] Detected container ID: ${containerId.substring(0, 12)}`);

	// Get DATA_DIR (inside container)
	const dataDir = resolve(process.env.DATA_DIR || '/app/data');

	try {
		// Query Docker API to inspect our own container
		const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

		// Use fetch with unix socket
		const response = await fetch(`http://localhost/containers/${containerId}/json`, {
			// @ts-ignore - Bun supports unix sockets
			unix: socketPath
		});

		if (!response.ok) {
			console.warn(`[HostPath] Failed to inspect container: ${response.status}`);
			return null;
		}

		const containerInfo = await response.json() as {
			Mounts?: Array<{
				Type: string;
				Source: string;
				Destination: string;
			}>;
		};

		// Cache ALL mounts for later path translation (used by rewriteComposeVolumePaths)
		cachedMounts = (containerInfo.Mounts || []).map(m => ({
			source: m.Source,
			destination: m.Destination
		}));
		console.log(`[HostPath] Cached ${cachedMounts.length} mount(s)`);

		// Find the mount for our DATA_DIR
		const dataMount = containerInfo.Mounts?.find(m => m.Destination === dataDir);

		if (dataMount) {
			cachedHostDataDir = dataMount.Source;
			console.log(`[HostPath] Detected host path for ${dataDir}: ${cachedHostDataDir}`);
			return cachedHostDataDir;
		}

		// Check if DATA_DIR is a subdirectory of a mount
		for (const mount of containerInfo.Mounts || []) {
			if (dataDir.startsWith(mount.Destination + '/') || dataDir === mount.Destination) {
				const relativePath = dataDir.substring(mount.Destination.length);
				cachedHostDataDir = mount.Source + relativePath;
				console.log(`[HostPath] Detected host path for ${dataDir} via parent mount: ${cachedHostDataDir}`);
				return cachedHostDataDir;
			}
		}

		console.warn(`[HostPath] Could not find mount for ${dataDir} in container mounts`);
		return null;
	} catch (err) {
		console.warn(`[HostPath] Failed to query Docker API: ${err}`);
		return null;
	}
}

/**
 * Get the cached host data dir (call detectHostDataDir first during startup)
 */
export function getHostDataDir(): string | null {
	return cachedHostDataDir;
}

/**
 * Translate a container path to host path
 *
 * @param containerPath - Path inside the container (e.g., /app/data/stacks/mystack/file.txt)
 * @returns Host path if translation is needed, or original path if not
 */
export function translateToHostPath(containerPath: string): string {
	const hostDataDir = getHostDataDir();
	if (!hostDataDir) {
		return containerPath;
	}

	const dataDir = resolve(process.env.DATA_DIR || '/app/data');

	// Check if the path is under DATA_DIR
	if (containerPath.startsWith(dataDir + '/') || containerPath === dataDir) {
		const relativePath = containerPath.substring(dataDir.length);
		return hostDataDir + relativePath;
	}

	return containerPath;
}

/**
 * Translate any container path to host path using ALL cached mounts.
 * This is more general than translateToHostPath() which only handles DATA_DIR.
 *
 * @param containerPath - Path inside the container (e.g., /external-stacks/mystack)
 * @returns Host path if a matching mount is found, or null if no translation possible
 */
export function translateContainerPathViaMount(containerPath: string): string | null {
	if (!cachedMounts || cachedMounts.length === 0) {
		return null;
	}

	// Sort mounts by destination length (longest first) to match most specific mount
	const sortedMounts = [...cachedMounts].sort(
		(a, b) => b.destination.length - a.destination.length
	);

	for (const mount of sortedMounts) {
		if (containerPath.startsWith(mount.destination + '/') ||
			containerPath === mount.destination) {
			const relativePath = containerPath.substring(mount.destination.length);
			return mount.source + relativePath;
		}
	}

	return null;
}

/**
 * Get the host path for the Docker socket mount.
 * This is needed for sibling containers (e.g., scanners) that need socket access.
 *
 * When Dockhand runs in Docker with a non-standard socket mount like:
 *   -v /var/run/user/1000/docker.sock:/var/run/docker.sock
 *
 * We need to detect the HOST path (/var/run/user/1000/docker.sock) so that
 * scanner containers can bind-mount the correct path.
 *
 * @returns The host path to Docker socket, or '/var/run/docker.sock' as default
 */
export function getHostDockerSocket(): string {
	// Priority 1: Explicit environment variable override
	if (process.env.HOST_DOCKER_SOCKET) {
		console.log(`[HostPath] Using HOST_DOCKER_SOCKET from env: ${process.env.HOST_DOCKER_SOCKET}`);
		return process.env.HOST_DOCKER_SOCKET;
	}

	// Priority 2: Look up from cached mounts (populated by detectHostDataDir on startup)
	if (cachedMounts && cachedMounts.length > 0) {
		console.log(`[HostPath] Searching ${cachedMounts.length} cached mount(s) for Docker socket`);

		// Find mount where destination is docker.sock
		const socketMount = cachedMounts.find(m =>
			m.destination === '/var/run/docker.sock' ||
			m.destination === '/run/docker.sock' ||
			m.destination.endsWith('/docker.sock')
		);

		if (socketMount) {
			console.log(`[HostPath] Found Docker socket mount: ${socketMount.source} -> ${socketMount.destination}`);
			return socketMount.source;
		}

		// Log available mounts for debugging
		console.log(`[HostPath] No Docker socket mount found. Available mounts:`);
		for (const m of cachedMounts) {
			console.log(`[HostPath]   ${m.source} -> ${m.destination}`);
		}
	} else {
		console.log(`[HostPath] No cached mounts available (not running in Docker or detectHostDataDir not called)`);
	}

	// Priority 3: Default fallback (works for standard Docker setups)
	console.log(`[HostPath] Using default Docker socket: /var/run/docker.sock`);
	return '/var/run/docker.sock';
}

/**
 * Extract UID from a user-specific Docker socket path.
 * User-specific sockets are at /run/user/<uid>/docker.sock
 *
 * @param socketPath - The host Docker socket path
 * @returns The UID as a string (e.g., "1000"), or null if not a user-specific path
 */
export function extractUidFromSocketPath(socketPath: string): string | null {
	// Match patterns like /run/user/1000/docker.sock or /var/run/user/1000/docker.sock
	const match = socketPath.match(/\/user\/(\d+)\/docker\.sock$/);
	if (match) {
		console.log(`[HostPath] Extracted UID ${match[1]} from socket path: ${socketPath}`);
		return match[1];
	}
	return null;
}

/**
 * Rewrite relative volume paths in a compose file to use absolute host paths.
 * This is necessary when Dockhand runs inside Docker with a mounted data volume.
 *
 * Transforms:
 *   ./config.toml:/config.toml  ->  /host/path/to/stack/config.toml:/config.toml
 *
 * @param composeContent - The compose file content
 * @param workingDir - The working directory (container path) where the compose file is located
 * @returns Modified compose content with absolute host paths, or original if no translation needed
 */
export function rewriteComposeVolumePaths(composeContent: string, workingDir: string): { content: string; modified: boolean; changes: string[] } {
	const changes: string[] = [];

	// Try to translate workingDir to host path using ANY cached mount
	// This handles both DATA_DIR mounts and external mounts (e.g., /external-stacks)
	const hostWorkingDir = translateContainerPathViaMount(workingDir);

	if (!hostWorkingDir) {
		// Can't translate - workingDir is not under any known mount
		return { content: composeContent, modified: false, changes };
	}

	// Parse compose content line by line to find and rewrite volume mounts
	// We look for patterns like:
	//   - ./something:/container/path
	//   - "./something:/container/path"
	//   - './something:/container/path'
	const lines = composeContent.split('\n');
	const modifiedLines: string[] = [];

	for (const line of lines) {
		// Match volume mount patterns with relative paths
		// Handles: - ./path:/dest, - "./path:/dest", - './path:/dest'
		const volumeMatch = line.match(/^(\s*-\s*)(['"]?)(\.\/[^'":\s]+)(\2)(:.+)$/);

		if (volumeMatch) {
			const [, prefix, quote, relativeSrc, , destPart] = volumeMatch;
			// Convert relative path to absolute host path
			const absoluteHostPath = hostWorkingDir + '/' + relativeSrc.substring(2); // Remove ./

			const newLine = `${prefix}${absoluteHostPath}${destPart}`;
			modifiedLines.push(newLine);
			changes.push(`  ${relativeSrc} -> ${absoluteHostPath}`);
		} else {
			modifiedLines.push(line);
		}
	}

	return {
		content: modifiedLines.join('\n'),
		modified: changes.length > 0,
		changes
	};
}
