/**
 * Pure Docker-stats math, shared by every container-stats endpoint so the CPU /
 * memory / IO calculation lives in ONE place (it used to be copy-pasted across the
 * per-container, container-list and dashboard stream routes). No imports, unit-tested.
 *
 * Windows vs Unix: the Docker stats payload differs by daemon OS. Unix reports
 * `cpu_stats.system_cpu_usage` and `memory_stats.usage`; Windows reports neither -
 * it carries `memory_stats.privateworkingset` and needs a wall-clock CPU formula
 * (num_procs * elapsed). Detected per-payload by the presence of `privateworkingset`
 * (matches how the Docker CLI / Portainer distinguish them). Without this, a Windows
 * container shows 0% CPU and 0 B memory (#1574).
 */

/** The subset of a Docker `/containers/{id}/stats` payload this module reads. */
export interface DockerStatsPayload {
	read?: string;
	preread?: string;
	num_procs?: number;
	cpu_stats?: {
		cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
		system_cpu_usage?: number;
		online_cpus?: number;
	};
	precpu_stats?: {
		cpu_usage?: { total_usage?: number };
		system_cpu_usage?: number;
	};
	memory_stats?: {
		usage?: number;
		limit?: number;
		privateworkingset?: number;
		stats?: { inactive_file?: number; total_inactive_file?: number };
	};
	networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
	blkio_stats?: { io_service_bytes_recursive?: Array<{ op?: string; value?: number }> };
	// Windows daemons report block I/O here instead of blkio_stats.
	storage_stats?: { read_size_bytes?: number; write_size_bytes?: number };
}

/** True when the payload came from a Windows daemon (has `privateworkingset`). */
export function isWindowsStats(stats: DockerStatsPayload | null | undefined): boolean {
	return stats?.memory_stats?.privateworkingset !== undefined;
}

/**
 * Container CPU usage as a percentage. Unix uses the cpu-vs-system delta ratio;
 * Windows uses (cpu delta) / (num_procs * elapsed-ns), since it has no
 * system_cpu_usage. Returns 0 when the deltas are non-positive (first sample, idle).
 */
export function calculateCpuPercent(stats: DockerStatsPayload | null | undefined): number {
	if (!stats) return 0;
	const cur = stats.cpu_stats?.cpu_usage?.total_usage ?? 0;
	const prev = stats.precpu_stats?.cpu_usage?.total_usage ?? 0;
	const cpuDelta = cur - prev;

	if (isWindowsStats(stats)) {
		// Wall-clock formula (matches Docker CLI / Portainer for Windows containers):
		// possIntervals = num_procs * elapsed-milliseconds; cpu% = cpuDelta / (possIntervals * 100).
		// read/preread are RFC3339 timestamps. No system_cpu_usage exists on Windows.
		const readMs = stats.read ? new Date(stats.read).getTime() : Number.NaN;
		const prereadMs = stats.preread ? new Date(stats.preread).getTime() : Number.NaN;
		const possIntervals = (stats.num_procs ?? 0) * (readMs - prereadMs);
		if (Number.isFinite(possIntervals) && possIntervals > 0 && cpuDelta > 0) {
			return cpuDelta / (possIntervals * 100);
		}
		return 0;
	}

	const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
	const cpuCount = stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
	if (systemDelta > 0 && cpuDelta > 0) {
		return (cpuDelta / systemDelta) * cpuCount * 100;
	}
	return 0;
}

/**
 * Memory usage the way the Docker CLI shows it. Unix subtracts file cache
 * (inactive_file / total_inactive_file) from the raw usage; Windows reports the
 * already-cache-free `privateworkingset` and has no cache to subtract.
 * Returns { usage: shown value, raw: pre-subtraction, cache }.
 */
export function calculateMemoryUsage(
	memoryStats: DockerStatsPayload['memory_stats'] | null | undefined
): { usage: number; raw: number; cache: number } {
	if (memoryStats?.privateworkingset !== undefined) {
		const raw = memoryStats.privateworkingset || 0;
		return { usage: raw, raw, cache: 0 };
	}
	const raw = memoryStats?.usage || 0;
	const stats = memoryStats?.stats || {};
	// cgroup v2 uses 'inactive_file', cgroup v1 uses 'total_inactive_file'
	const cache = stats.inactive_file ?? stats.total_inactive_file ?? 0;
	const usage = (cache > 0 && cache < raw) ? raw - cache : raw;
	return { usage, raw, cache };
}

/** Sum rx/tx bytes across all container network interfaces. */
export function calculateNetworkIO(stats: DockerStatsPayload | null | undefined): { rx: number; tx: number } {
	let rx = 0;
	let tx = 0;
	if (stats?.networks) {
		for (const iface of Object.values(stats.networks)) {
			rx += iface.rx_bytes || 0;
			tx += iface.tx_bytes || 0;
		}
	}
	return { rx, tx };
}

/**
 * Read/write bytes. Unix sums blkio_stats.io_service_bytes_recursive (lower- or
 * upper-case op); Windows leaves that empty and reports the totals in storage_stats.
 */
export function calculateBlockIO(stats: DockerStatsPayload | null | undefined): { read: number; write: number } {
	let read = 0;
	let write = 0;
	const ioStats = stats?.blkio_stats?.io_service_bytes_recursive;
	if (Array.isArray(ioStats)) {
		for (const entry of ioStats) {
			const op = entry.op;
			if (op === 'read' || op === 'Read') read += entry.value || 0;
			else if (op === 'write' || op === 'Write') write += entry.value || 0;
		}
	}
	if (read === 0 && write === 0 && stats?.storage_stats) {
		read = stats.storage_stats.read_size_bytes || 0;
		write = stats.storage_stats.write_size_bytes || 0;
	}
	return { read, write };
}

/**
 * Memory limit denominator, or 0 when there is none to show. A Windows daemon does
 * not report a usable `memory_stats.limit` (0/absent unless the container was started
 * with an explicit --memory cap), so 0 is returned there and the UI shows "unlimited"
 * instead of a bogus 1-byte limit.
 */
export function calculateMemoryLimit(stats: DockerStatsPayload | null | undefined): number {
	const limit = stats?.memory_stats?.limit || 0;
	if (isWindowsStats(stats)) {
		// A Windows limit is only meaningful when a real cap was set; otherwise 0.
		return limit > 1 ? limit : 0;
	}
	return limit;
}
