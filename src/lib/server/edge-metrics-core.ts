/**
 * Pure conversion of a Hawser edge agent's raw host metrics into the percentages
 * Dockhand stores. Kept separate from hawser.ts so it can be unit-tested without the
 * WebSocket/ring-buffer side effects.
 *
 * cpuUsage arrives as whole-host utilization 0-100 (the agent derives it from the
 * aggregate /proc/stat line, which is already normalized across every logical CPU), so
 * it is passed through unchanged. cpuCores is NOT divided in again - doing so normalizes
 * a second time and underreports host CPU by the core count.
 */
export interface RawEdgeMetrics {
	cpuUsage: number;
	cpuCores: number;
	memoryTotal: number;
	memoryUsed: number;
}

export function edgeCpuPercent(metrics: Pick<RawEdgeMetrics, 'cpuUsage'>): number {
	return metrics.cpuUsage;
}

export function edgeMemoryPercent(metrics: Pick<RawEdgeMetrics, 'memoryTotal' | 'memoryUsed'>): number {
	return metrics.memoryTotal > 0 ? (metrics.memoryUsed / metrics.memoryTotal) * 100 : 0;
}
