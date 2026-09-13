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
import * as http from 'node:http';
import { resolve } from 'node:path';
import { isSelfInspectCandidate } from './host-path-core';

// Cache the host data dir to avoid repeated API calls
let cachedHostDataDir: string | null = null;
let detectionAttempted = false;

// Cache ALL mounts for path translation (not just DATA_DIR)
let cachedMounts: Array<{ source: string; destination: string }> | null = null;

// Cache Dockhand's own Docker access method (detected from container inspect).
// cachedOwnDockerHost holds ONLY a DOCKER_HOST the user set on Dockhand's own
// container. The scanner reads it to replicate how Dockhand reaches Docker, so it
// must stay exactly what 1.0.39 exposed: null unless the user set DOCKER_HOST.
let cachedOwnDockerHost: string | null = null;
// cachedAutoTcpHost holds a tcp:// address DISCOVERED via a DB env (#1203, socket-
// proxy with no docker.sock and no DOCKER_HOST). It's for self-update ONLY - the
// scanner must NOT follow it, or it flips into TCP-mode and joins the wrong network
// on split-network hosts (#1204). Kept separate from cachedOwnDockerHost for that.
let cachedAutoTcpHost: string | null = null;
let cachedOwnNetworkMode: string | null = null;
let cachedOwnAllNetworks: string[] | null = null;
let cachedOwnExtraHosts: string[] | null = null;

/**
 * Get our own container ID
 */
export function getOwnContainerId(): string | null {
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

/** Docker container inspect fields we read to populate the caches. */
interface OwnContainerInfo {
	Mounts?: Array<{ Type?: string; Source: string; Destination: string }>;
	Config?: { Env?: string[] };
	HostConfig?: { ExtraHosts?: string[] };
	NetworkSettings?: { Networks?: Record<string, unknown> };
}

/**
 * Populate the mounts / DOCKER_HOST / network / ExtraHosts caches from a
 * container inspect result. Shared by the socket self-inspect and the DB-env
 * fallback so both paths cache identically. `ownDockerHostOverride` sets
 * cachedAutoTcpHost (self-update ONLY) when the inspect was reached over a DB env
 * TCP route; the socket path instead reads a real DOCKER_HOST from the container's
 * own env vars into cachedOwnDockerHost (which the scanner honors).
 */
function populateCachesFromInspect(info: OwnContainerInfo, ownDockerHostOverride?: string): void {
	cachedMounts = (info.Mounts || []).map(m => ({ source: m.Source, destination: m.Destination }));
	console.log(`[HostPath] Cached ${cachedMounts.length} mount(s)`);

	if (ownDockerHostOverride) {
		// Discovered via a DB env (#1203). Self-update may use it, but the scanner
		// must NOT (it would flip to TCP-mode and hit the wrong net, #1204), so this
		// goes to the self-update-only cache, never cachedOwnDockerHost.
		cachedAutoTcpHost = ownDockerHostOverride;
	} else {
		// Read DOCKER_HOST from Dockhand's own env vars (how it was configured).
		for (const v of info.Config?.Env || []) {
			if (v.startsWith('DOCKER_HOST=')) {
				cachedOwnDockerHost = v.substring('DOCKER_HOST='.length);
				console.log(`[HostPath] Detected own DOCKER_HOST: ${cachedOwnDockerHost}`);
				break;
			}
		}
	}

	// Networks: primary (custom net first, else bridge) + full list, so callers
	// can warn on fragile split-network setups (#1011).
	const networks = info.NetworkSettings?.Networks;
	if (networks) {
		const custom = Object.keys(networks).filter(n => n !== 'bridge' && n !== 'none' && n !== 'host');
		cachedOwnNetworkMode = custom.length > 0 ? custom[0] : networks.bridge ? 'bridge' : null;
		cachedOwnAllNetworks = Object.keys(networks);
		if (cachedOwnNetworkMode) {
			console.log(`[HostPath] Detected own network: ${cachedOwnNetworkMode} (all: ${cachedOwnAllNetworks.join(', ')})`);
		}
	}

	cachedOwnExtraHosts = info.HostConfig?.ExtraHosts?.length ? [...info.HostConfig.ExtraHosts] : null;
	if (cachedOwnExtraHosts) {
		console.log(`[HostPath] Detected own ExtraHosts: ${cachedOwnExtraHosts.join(', ')}`);
	}
}

/**
 * Resolve the host path for DATA_DIR from a container inspect result: honor an
 * explicit HOST_DATA_DIR override, else match the DATA_DIR mount (or a parent
 * mount). Sets and returns cachedHostDataDir, or null if no mount matches.
 */
function resolveDataDirFromInspect(info: OwnContainerInfo, dataDir: string): string | null {
	if (cachedHostDataDir) return cachedHostDataDir;

	const dataMount = info.Mounts?.find(m => m.Destination === dataDir);
	if (dataMount) {
		cachedHostDataDir = dataMount.Source;
		console.log(`[HostPath] Detected host path for ${dataDir}: ${cachedHostDataDir}`);
		return cachedHostDataDir;
	}
	for (const mount of info.Mounts || []) {
		if (dataDir.startsWith(mount.Destination + '/') || dataDir === mount.Destination) {
			cachedHostDataDir = mount.Source + dataDir.substring(mount.Destination.length);
			console.log(`[HostPath] Detected host path for ${dataDir} via parent mount: ${cachedHostDataDir}`);
			return cachedHostDataDir;
		}
	}
	console.warn(`[HostPath] Could not find mount for ${dataDir} in container mounts`);
	return null;
}

/**
 * Fallback for socket-proxy deployments (#1203/#1204): no docker.sock mounted and
 * no DOCKER_HOST set, so the socket self-inspect above failed. Reach Docker
 * through a DB-configured plain-http `direct` environment whose daemon actually
 * hosts THIS container (a genuinely remote daemon 404s on our id and is skipped),
 * and cache its tcp:// address + network so scanner/self-update sidecars work.
 * Returns the resolved DATA_DIR host path, or null if no env hosts us.
 */
async function inspectOwnContainerViaDbEnv(containerId: string, dataDir: string): Promise<string | null> {
	// Lazy import: keep host-path.ts light at module load so it stays importable
	// in unit tests without pulling in the DB/docker layers (better-sqlite3).
	const { getEnvironments } = await import('./db');
	const { dockerFetch } = await import('./docker');

	let envs;
	try {
		envs = await getEnvironments();
	} catch {
		return null;
	}
	const candidates = envs.filter(isSelfInspectCandidate);
	for (const env of candidates) {
		try {
			const res = await dockerFetch(`/containers/${containerId}/json`, {}, env.id);
			if (!res.ok) {
				await res.body?.cancel().catch(() => {});
				continue;
			}
			const info = await res.json() as OwnContainerInfo;
			const tcpHost = `tcp://${env.host}:${env.port}`;
			populateCachesFromInspect(info, tcpHost);
			console.log(`[HostPath] Reached own container via direct env "${env.name}"; own DOCKER_HOST=${tcpHost}`);
			return resolveDataDirFromInspect(info, dataDir);
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * Reset host detection so the next detectHostDataDir() re-inspects. Called when
 * environments change (create/update), so a socket-proxy deployment that had no
 * `direct` env at boot picks one up without a restart (#1203).
 */
export function resetHostDetection(): void {
	detectionAttempted = false;
	cachedHostDataDir = null;
	cachedMounts = null;
	cachedOwnDockerHost = null;
	cachedAutoTcpHost = null;
	cachedOwnNetworkMode = null;
	cachedOwnAllNetworks = null;
	cachedOwnExtraHosts = null;
}

/** Test-only: seed the container-mount table so mount-dependent path translation
 *  (translateContainerPathViaMount / rewriteComposeVolumePaths) can be unit-tested. */
export function __setCachedMountsForTest(
	mounts: Array<{ source: string; destination: string }> | null
): void {
	cachedMounts = mounts;
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
	}

	const containerId = getOwnContainerId();
	if (!containerId) {
		console.warn('[HostPath] Running in Docker but could not detect container ID; ExtraHosts will not be mirrored to sidecars');
		return null;
	}

	console.log(`[HostPath] Detected container ID: ${containerId.substring(0, 12)}`);

	// Get DATA_DIR (inside container)
	const dataDir = resolve(process.env.DATA_DIR || '/app/data');

	try {
		// Query Docker API to inspect our own container
		// Try unix socket first, fall back to TCP if DOCKER_HOST is set
		const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
		const dockerHost = process.env.DOCKER_HOST;

		const containerInfo = await new Promise<any>((resolvePromise, reject) => {
			const reqOptions: http.RequestOptions = dockerHost?.startsWith('tcp://')
				? (() => {
					const u = new URL(dockerHost.replace('tcp://', 'http://'));
					return { hostname: u.hostname, port: u.port, path: `/containers/${containerId}/json`, method: 'GET' };
				})()
				: { socketPath, path: `/containers/${containerId}/json`, method: 'GET' };

			const req = http.request(reqOptions, (res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					if (res.statusCode === 200) {
						try {
							resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
						} catch {
							reject(new Error('Failed to parse container inspect response'));
						}
					} else {
						reject(new Error(`Container inspect failed: ${res.statusCode}`));
					}
				});
				res.on('error', reject);
			});
			req.on('error', reject);
			req.end();
		}) as {
			Mounts?: Array<{
				Type: string;
				Source: string;
				Destination: string;
			}>;
			Config?: {
				Env?: string[];
			};
			HostConfig?: {
				ExtraHosts?: string[];
			};
			NetworkSettings?: {
				Networks?: Record<string, unknown>;
			};
		};

		// Populate mounts/DOCKER_HOST/network/ExtraHosts caches (from the container's
		// own env vars, since this path reached Docker over socket/DOCKER_HOST).
		populateCachesFromInspect(containerInfo);
		return resolveDataDirFromInspect(containerInfo, dataDir);
	} catch (err) {
		console.warn(`[HostPath] Failed to query Docker API via socket/DOCKER_HOST: ${err}`);
		// Socket-proxy fallback (#1203/#1204): no docker.sock and no DOCKER_HOST, so
		// reach Docker through a configured plain-http direct env. Guarded on no
		// DOCKER_HOST so a user who set an (unreachable) DOCKER_HOST is never rerouted.
		if (!process.env.DOCKER_HOST) {
			const viaEnv = await inspectOwnContainerViaDbEnv(containerId, dataDir);
			if (viaEnv) return viaEnv;
		}
		// Nothing found. Do NOT keep detectionAttempted latched: a direct env added
		// AFTER startup should heal on the next detect without a restart. Only a
		// successful detection (above / socket path) leaves the caches populated.
		detectionAttempted = false;
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
 * Get DOCKER_HOST from Dockhand's own container config (if set).
 * Returns the TCP address (e.g., "tcp://socket-proxy:2375") or null.
 * Populated by detectHostDataDir() at startup.
 */
export function getOwnDockerHost(): string | null {
	return cachedOwnDockerHost;
}

/**
 * TCP address discovered via a DB env when Dockhand has no docker.sock and no
 * DOCKER_HOST (#1203 socket-proxy). For self-update ONLY - the scanner deliberately
 * does not read this, so it keeps using the host socket like 1.0.39 did (#1204).
 */
export function getAutoDetectedDockerHost(): string | null {
	return cachedAutoTcpHost;
}

/**
 * Get the Docker network Dockhand is attached to.
 * Used to place scanner containers on the same network so they can reach
 * TCP-based Docker endpoints (e.g., socket proxy).
 * Populated by detectHostDataDir() at startup.
 */
export function getOwnNetworkMode(): string | null {
	return cachedOwnNetworkMode;
}

/**
 * All Docker networks Dockhand itself is attached to. The scanner uses
 * this to detect split-network setups and warn that socket-proxy may not
 * be reachable from the network it actually joins (#1011).
 */
export function getOwnAllNetworks(): string[] {
	return cachedOwnAllNetworks ? [...cachedOwnAllNetworks] : [];
}

/**
 * Get the ExtraHosts entries configured on Dockhand itself.
 * Used to mirror host aliases into sibling sidecar containers.
 * Populated by detectHostDataDir() at startup.
 */
export function getOwnExtraHosts(): string[] | null {
	return cachedOwnExtraHosts ? [...cachedOwnExtraHosts] : null;
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
 * The container mounts cached at startup (empty when Dockhand runs on bare metal,
 * or before detectHostDataDir has run). Callers use this to tell "Dockhand is
 * containerized and this path is not under any bind" from "no mount info at all".
 */
export function getCachedContainerMounts(): Array<{ source: string; destination: string }> {
	return cachedMounts ? [...cachedMounts] : [];
}

/**
 * True when a container mount destination STRICTLY DEEPER than DATA_DIR covers
 * `containerPath` (e.g. DATA_DIR=/app/data with a separate bind at /app/data/stacks).
 * In that topology translateToHostPath() is WRONG - it resolves the path against
 * DATA_DIR's host root (the outer volume), but the files physically live under the
 * more-specific bind. translateContainerPathViaMount() has the right answer, so the
 * caller must prefer it. Pure over the passed-in mount list for unit testing (#1533).
 */
export function pathOverriddenBySubMount(
	containerPath: string,
	dataDir: string,
	mounts: Array<{ source: string; destination: string }>
): boolean {
	const norm = (p: string) => p.replace(/\/+$/, '');
	const dd = norm(dataDir);
	const cp = norm(containerPath);
	return mounts.some((m) => {
		const dest = norm(m.destination);
		// Deeper than DATA_DIR...
		if (!(dest.startsWith(dd + '/') && dest.length > dd.length)) return false;
		// ...and it covers the path.
		return cp === dest || cp.startsWith(dest + '/');
	});
}

/**
 * Warn when a custom stack compose path won't survive a Dockhand recreate (#1524).
 * A path Dockhand writes to that is NOT under any of its container mounts lands on the
 * container's throwaway layer - it looks saved, then vanishes when the container is
 * recreated (an update/restart), leaving the stack's compose "blank". Returns a
 * human-readable warning, or null when the path is fine.
 *
 * Pure over the passed-in mount list so it unit-tests without a live container. Only
 * fires when Dockhand is containerized (mounts non-empty) and the path is absolute and
 * not under any mount destination; bare-metal (no mounts) and default in-DATA_DIR paths
 * return null.
 */
export function unpersistedComposePathWarning(
	composePath: string | null | undefined,
	mounts: Array<{ source: string; destination: string }>
): string | null {
	if (!composePath || mounts.length === 0) return null;
	// Only a path Dockhand itself resolves inside its container can be orphaned; a
	// relative path is resolved against DATA_DIR elsewhere, so only guard absolute paths.
	if (!composePath.startsWith('/')) return null;
	const underMount = [...mounts]
		.sort((a, b) => b.destination.length - a.destination.length)
		.some((m) => composePath === m.destination || composePath.startsWith(m.destination + '/'));
	if (underMount) return null;
	return `The compose file path "${composePath}" is not inside any of Dockhand's mounted volumes, so it is written inside the Dockhand container and will be LOST when the container is recreated (an update or restart). Use a path under a mounted volume (e.g. the default location, or add a bind mount for this path to Dockhand's own compose), then re-save.`;
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

	// Parse compose content line by line to find and rewrite volume mounts.
	// We look for patterns like:
	//   - ./something:/container/path
	//   - ../something:/container/path
	//   - "./something:/container/path"
	//   - '../something:/container/path'
	const lines = composeContent.split('\n');
	const modifiedLines: string[] = [];

	for (const line of lines) {
		// Match volume mount patterns with relative paths.
		// Handles ./path and ../path, optionally quoted with single or double quotes.
		const volumeMatch = line.match(/^(\s*-\s*)(['"]?)(\.\.?\/[^'":\s]+)(\2)(:.+)$/);

		if (volumeMatch) {
			const [, prefix, quote, relativeSrc, , destPart] = volumeMatch;
			// Resolve to an absolute container path, then translate to a host
			// path via any known mount. Each line is translated independently so
			// `../foo` can escape workingDir into a sibling that may map to a
			// different mount than workingDir itself.
			const absoluteContainerPath = resolve(workingDir, relativeSrc);
			const absoluteHostPath = translateContainerPathViaMount(absoluteContainerPath);

			if (absoluteHostPath && absoluteHostPath !== absoluteContainerPath) {
				const newLine = `${prefix}${absoluteHostPath}${destPart}`;
				modifiedLines.push(newLine);
				changes.push(`  ${relativeSrc} -> ${absoluteHostPath}`);
			} else {
				// Either untranslatable, OR a 1:1 mount where the host path equals the
				// container path (#1514): rewriting `./x` to the identical absolute path
				// is pointless and forces stdin deploy (`-f -`), which loses the real
				// com.docker.compose.project.config_files label. Leave the relative bind
				// so the deploy can pass the compose file by path; compose resolves `./x`
				// against the file's dir to the same host location. If it was simply
				// untranslatable, compose still resolves it against its cwd - a wrong path
				// there fails the deploy loudly, better than a misleading host path.
				modifiedLines.push(line);
			}
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

/**
 * Find relative bind-mount sources (`./X`, `../X`) in a compose file.
 *
 * Used to detect the cross-env deployment trap: when DOCKER_HOST points at a
 * remote daemon, docker compose expands `./X` against the CLIENT cwd (the
 * Dockhand container's filesystem) and asks the REMOTE daemon to bind that
 * path. The remote daemon's filesystem doesn't contain Dockhand's
 * `/app/data/stacks/...`, so the daemon auto-creates an empty directory and
 * the service starts with NO data. The deploy reports success while
 * silently losing the bind-mounted contents.
 *
 * Returns the matched source paths so the caller can refuse the deploy with
 * an actionable error message.
 */
export function findRelativeBindSources(composeContent: string): string[] {
	const found: string[] = [];
	for (const line of composeContent.split('\n')) {
		// Same regex as rewriteComposeVolumePaths above, plus ../ support.
		const m = line.match(/^\s*-\s*['"]?(\.{1,2}\/[^'":\s]+)['"]?:/);
		if (m) found.push(m[1]);
	}
	return found;
}
