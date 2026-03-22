/**
 * In-Memory Metrics Ring Buffer
 *
 * Replaces SQLite/PostgreSQL host_metrics storage with a fixed-size
 * in-memory circular buffer per environment. Uses pre-allocated arrays
 * with head/count indices to avoid splice()-based eviction which causes
 * V8 to repeatedly reallocate backing arrays.
 *
 * Memory: 16 envs × 360 slots × ~100 bytes ≈ 576 KB
 */

export interface MetricPoint {
	id: number;
	cpuPercent: number;
	memoryPercent: number;
	memoryUsed: number;
	memoryTotal: number;
	environmentId: number | null;
	timestamp: string;
}

const MAX_POINTS_PER_ENV = 360; // 1 hour at 10s interval, 3 hours at 30s

interface RingBuffer {
	data: (MetricPoint | null)[];
	head: number;  // next write position
	count: number; // number of valid entries (≤ MAX_POINTS_PER_ENV)
}

// envId → RingBuffer
const store = new Map<number, RingBuffer>();

let nextId = 1;

/**
 * Push a new metric data point for an environment.
 * Overwrites oldest entry when buffer is full (no array reallocation).
 */
export function pushMetric(
	envId: number,
	cpuPercent: number,
	memoryPercent: number,
	memoryUsed: number,
	memoryTotal: number
): void {
	let ring = store.get(envId);
	if (!ring) {
		ring = { data: new Array(MAX_POINTS_PER_ENV).fill(null), head: 0, count: 0 };
		store.set(envId, ring);
	}

	ring.data[ring.head] = {
		id: nextId++,
		cpuPercent,
		memoryPercent,
		memoryUsed,
		memoryTotal,
		environmentId: envId,
		timestamp: new Date().toISOString()
	};
	ring.head = (ring.head + 1) % MAX_POINTS_PER_ENV;
	if (ring.count < MAX_POINTS_PER_ENV) ring.count++;
}

/**
 * Read entries from a ring buffer in oldest-first order.
 */
function readRing(ring: RingBuffer, limit: number): MetricPoint[] {
	const count = Math.min(ring.count, limit);
	if (count === 0) return [];

	const result: MetricPoint[] = new Array(count);
	// Start reading from the oldest entry
	const start = (ring.head - ring.count + MAX_POINTS_PER_ENV) % MAX_POINTS_PER_ENV;
	const skip = ring.count - count;
	const readFrom = (start + skip) % MAX_POINTS_PER_ENV;

	for (let i = 0; i < count; i++) {
		result[i] = ring.data[(readFrom + i) % MAX_POINTS_PER_ENV]!;
	}
	return result;
}

/**
 * Get the most recent metric for an environment.
 */
export function getLatestMetric(envId: number): MetricPoint | null {
	const ring = store.get(envId);
	if (!ring || ring.count === 0) return null;
	// head points to next write position, so latest is head - 1
	const idx = (ring.head - 1 + MAX_POINTS_PER_ENV) % MAX_POINTS_PER_ENV;
	return ring.data[idx];
}

/**
 * Get metrics history for an environment, oldest first.
 */
export function getMetricsHistory(envId: number, limit = 60): MetricPoint[] {
	const ring = store.get(envId);
	if (!ring || ring.count === 0) return [];
	return readRing(ring, limit);
}

/**
 * Get all metrics (across all environments), newest first, with optional limit.
 * Used by the global getHostMetrics() fallback when no envId is specified.
 */
export function getAllMetrics(limit = 60): MetricPoint[] {
	const all: MetricPoint[] = [];
	for (const ring of store.values()) {
		const points = readRing(ring, ring.count);
		all.push(...points);
	}
	// Sort newest first (matching old DB query behavior)
	all.sort((a, b) => b.id - a.id);
	return all.slice(0, limit);
}

/**
 * Clear all metrics for an environment (e.g., when environment is deleted).
 */
export function clearEnvironmentMetrics(envId: number): void {
	store.delete(envId);
}
