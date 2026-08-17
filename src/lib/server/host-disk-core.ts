/**
 * Pure disk-space helper. NO db / docker import, so unit-testable directly
 * (importing docker.ts pulls in Docker-socket detection and the whole
 * Docker-client layer — see host-path-core.ts for the same pattern).
 */
import { statfs } from 'node:fs/promises';

export interface HostDiskInfo {
	diskTotal: number;
	diskFree: number;
	diskAvailable: number;
}

/**
 * Disk space of a filesystem path, via Node's `fs.statfs` (available since
 * Node 18.15). Defaults to measuring `/` when `rootPath` is omitted or an
 * empty string.
 *
 * Callers should pass the Docker daemon's data-root (`DockerRootDir` from
 * Docker's `/info`) instead of relying on the `/` default whenever it's
 * known: on setups where `data-root` in daemon.json points at a separate
 * disk/mount, `/` and the actual data-root can report very different
 * capacity (#976) — measuring `/` alone doesn't tell you whether Docker
 * itself (images, containers, volumes) is about to run out of space.
 *
 * Returns null if the stat fails (e.g. platform without statfs support, or
 * an unreadable/nonexistent path) rather than throwing, since this is a
 * supplementary field on an otherwise-successful response.
 */
export async function getHostDiskInfo(rootPath?: string): Promise<HostDiskInfo | null> {
	const path = rootPath && rootPath.length > 0 ? rootPath : '/';
	try {
		const stats = await statfs(path);
		return {
			diskTotal: stats.blocks * stats.bsize,
			diskFree: stats.bfree * stats.bsize,
			// bavail excludes blocks reserved for the superuser - what's actually
			// usable, and what `df`'s "Avail" column shows.
			diskAvailable: stats.bavail * stats.bsize
		};
	} catch (error) {
		console.warn(`[Host] Failed to read disk stats for "${path}":`, error instanceof Error ? error.message : error);
		return null;
	}
}
