import { describe, test, expect } from 'bun:test';
import {
	isWindowsStats,
	calculateCpuPercent,
	calculateMemoryUsage,
	calculateNetworkIO,
	calculateBlockIO,
	calculateMemoryLimit,
} from '../src/lib/server/stats-calc-core';

// A representative Unix (Linux) stats payload.
const unixStats = {
	read: '2026-09-15T10:00:01Z',
	preread: '2026-09-15T10:00:00Z',
	cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 20_000_000_000, online_cpus: 4 },
	precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 18_000_000_000 },
	memory_stats: { usage: 200 * 1024 * 1024, limit: 1024 * 1024 * 1024, stats: { inactive_file: 50 * 1024 * 1024 } },
	networks: { eth0: { rx_bytes: 1000, tx_bytes: 2000 } },
	blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 4096 }, { op: 'Write', value: 8192 }] },
};

// A representative Windows stats payload: no system_cpu_usage, no memory usage/stats;
// carries privateworkingset + num_procs, and CPU is wall-clock derived.
const windowsStats = {
	read: '2026-09-15T10:00:01.0000000Z',
	preread: '2026-09-15T10:00:00.0000000Z', // 1000 ms elapsed
	num_procs: 2,
	cpu_stats: { cpu_usage: { total_usage: 500_000_000 } }, // 100ns units
	precpu_stats: { cpu_usage: { total_usage: 400_000_000 } }, // delta = 100_000_000
	memory_stats: { privateworkingset: 128 * 1024 * 1024, limit: 2 * 1024 * 1024 * 1024 },
	networks: { 'Ethernet': { rx_bytes: 500, tx_bytes: 700 } },
};

describe('isWindowsStats', () => {
	test('true when privateworkingset is present', () => {
		expect(isWindowsStats(windowsStats)).toBe(true);
	});
	test('false for a Unix payload', () => {
		expect(isWindowsStats(unixStats)).toBe(false);
	});
	test('false for null/undefined', () => {
		expect(isWindowsStats(null)).toBe(false);
		expect(isWindowsStats(undefined)).toBe(false);
	});
});

describe('calculateCpuPercent', () => {
	test('Unix: (cpuDelta/systemDelta)*cpuCount*100', () => {
		// cpuDelta=1e9, systemDelta=2e9, cpuCount=4 -> 0.5*4*100 = 200
		expect(calculateCpuPercent(unixStats)).toBeCloseTo(200, 5);
	});
	test('Unix: 0 when deltas are non-positive (first sample / idle)', () => {
		const idle = { ...unixStats, precpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 20_000_000_000 } };
		expect(calculateCpuPercent(idle)).toBe(0);
	});
	test('Windows: cpuDelta / (num_procs * elapsedMs * 100) - matches Docker CLI / Portainer', () => {
		// cpuDelta=1e8, possIntervals=2*1000=2000 -> 1e8/(2000*100) = 500
		const v = calculateCpuPercent(windowsStats);
		expect(v).toBeGreaterThan(0);
		expect(v).toBeCloseTo(100_000_000 / (2 * 1000 * 100), 5);
		expect(v).toBeCloseTo(500, 5);
	});
	test('Windows: 0 when elapsed is zero (read == preread)', () => {
		const same = { ...windowsStats, preread: windowsStats.read };
		expect(calculateCpuPercent(same)).toBe(0);
	});
	test('Windows: does NOT fall through to the Unix branch (no system_cpu_usage present)', () => {
		// If it wrongly used the Unix path, systemDelta would be 0-0 -> 0. So a positive
		// result proves the Windows branch ran.
		expect(calculateCpuPercent(windowsStats)).toBeGreaterThan(0);
	});
	test('null -> 0', () => {
		expect(calculateCpuPercent(null)).toBe(0);
	});
});

describe('calculateMemoryUsage', () => {
	test('Unix: subtracts inactive_file cache', () => {
		const r = calculateMemoryUsage(unixStats.memory_stats);
		expect(r.raw).toBe(200 * 1024 * 1024);
		expect(r.cache).toBe(50 * 1024 * 1024);
		expect(r.usage).toBe(150 * 1024 * 1024);
	});
	test('Windows: uses privateworkingset, no cache', () => {
		const r = calculateMemoryUsage(windowsStats.memory_stats);
		expect(r.usage).toBe(128 * 1024 * 1024);
		expect(r.raw).toBe(128 * 1024 * 1024);
		expect(r.cache).toBe(0);
	});
	test('Windows: NOT reported as 0 (the #1574 symptom)', () => {
		expect(calculateMemoryUsage(windowsStats.memory_stats).usage).toBeGreaterThan(0);
	});
	test('cgroup v1 total_inactive_file fallback', () => {
		const r = calculateMemoryUsage({ usage: 100, stats: { total_inactive_file: 30 } });
		expect(r.usage).toBe(70);
	});
	test('cache >= raw is not subtracted (sanity guard)', () => {
		const r = calculateMemoryUsage({ usage: 100, stats: { inactive_file: 100 } });
		expect(r.usage).toBe(100);
	});
	test('missing memory_stats -> 0', () => {
		expect(calculateMemoryUsage(undefined).usage).toBe(0);
	});
});

describe('calculateNetworkIO', () => {
	test('sums rx/tx across interfaces', () => {
		expect(calculateNetworkIO(unixStats)).toEqual({ rx: 1000, tx: 2000 });
	});
	test('windows single interface', () => {
		expect(calculateNetworkIO(windowsStats)).toEqual({ rx: 500, tx: 700 });
	});
	test('no networks -> zero', () => {
		expect(calculateNetworkIO({})).toEqual({ rx: 0, tx: 0 });
	});
});

describe('calculateBlockIO', () => {
	test('sums read/write, case-insensitive op', () => {
		expect(calculateBlockIO(unixStats)).toEqual({ read: 4096, write: 8192 });
	});
	test('windows: reads storage_stats when blkio is empty', () => {
		const win = { ...windowsStats, storage_stats: { read_size_bytes: 5000, write_size_bytes: 9000 } };
		expect(calculateBlockIO(win)).toEqual({ read: 5000, write: 9000 });
	});
	test('windows without storage_stats -> zero', () => {
		expect(calculateBlockIO(windowsStats)).toEqual({ read: 0, write: 0 });
	});
	test('unix blkio wins over any storage_stats', () => {
		const both = { ...unixStats, storage_stats: { read_size_bytes: 1, write_size_bytes: 1 } };
		expect(calculateBlockIO(both)).toEqual({ read: 4096, write: 8192 });
	});
});

describe('calculateMemoryLimit', () => {
	test('unix: returns memory_stats.limit', () => {
		expect(calculateMemoryLimit(unixStats)).toBe(1024 * 1024 * 1024);
	});
	test('windows with a real cap: returns the limit', () => {
		expect(calculateMemoryLimit(windowsStats)).toBe(2 * 1024 * 1024 * 1024);
	});
	test('windows with no cap (limit 0/absent): returns 0 for "unlimited"', () => {
		const noCap = { memory_stats: { privateworkingset: 100 } };
		expect(calculateMemoryLimit(noCap)).toBe(0);
	});
	test('windows with the bogus 1-byte limit: returns 0', () => {
		const bogus = { memory_stats: { privateworkingset: 100, limit: 1 } };
		expect(calculateMemoryLimit(bogus)).toBe(0);
	});
	test('null/undefined -> 0', () => {
		expect(calculateMemoryLimit(null)).toBe(0);
		expect(calculateMemoryLimit(undefined)).toBe(0);
	});
});
