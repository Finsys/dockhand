// Runtime side of the exposure warning: ask the local Docker daemon whether this
// container has the socket mounted read-write. Pure decision logic is in
// exposure-warning-core.ts; this file does the I/O and returns null on any failure so
// the caller stays quiet when it cannot be sure.
import { unixSocketRequest } from './docker';
import { getOwnContainerId } from './host-path';
import { shouldWarnExposure } from './exposure-warning-core';
import { isAuthEnabled } from './auth';

function localSocketPath(): string {
	const dh = process.env.DOCKER_HOST;
	if (dh && dh.startsWith('unix://')) return dh.slice('unix://'.length);
	return process.env.DOCKER_SOCKET || '/var/run/docker.sock';
}

/**
 * Whether the Docker socket is mounted read-write in this container.
 * null when it cannot be determined (TCP daemon, self-inspect failed, not in a
 * container) - the caller treats null as "do not warn".
 */
export async function detectDockerSocketRW(): Promise<boolean | null> {
	// A TCP daemon has no RO/RW mount concept, and this warning is about a mounted
	// unix socket specifically, so leave it unknown.
	if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')) return null;

	const containerId = getOwnContainerId();
	if (!containerId) return null;

	try {
		const socketPath = localSocketPath();
		const resp = await unixSocketRequest(socketPath, `/containers/${containerId}/json`);
		if (!resp.ok) return null;
		const info = (await resp.json()) as {
			Mounts?: Array<{ Destination: string; RW: boolean }>;
		};
		const mount = info.Mounts?.find((m) => m.Destination === socketPath);
		if (!mount) return false;
		return mount.RW === true;
	} catch {
		return null;
	}
}

/** The one call the exposure-status endpoint makes: gather the facts and decide. */
export async function evaluateExposure(host: string): Promise<boolean> {
	const authEnabled = await isAuthEnabled();
	// Short-circuit the Docker round-trip when auth or host already clears it.
	if (authEnabled) return false;
	const dockerSocketRW = await detectDockerSocketRW();
	return shouldWarnExposure({ authEnabled, host, dockerSocketRW });
}
