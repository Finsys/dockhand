import { describe, test, expect } from 'bun:test';
import { edgeCpuPercent, edgeMemoryPercent, type RawEdgeMetrics } from '../src/lib/server/edge-metrics-core';

describe('edgeCpuPercent - host CPU is normalized exactly once', () => {
	test('passes the agent percentage through unchanged (no second division by cores)', () => {
		// The agent reports whole-host utilization 0-100 from the aggregate /proc/stat line;
		// the value must survive as-is regardless of core count.
		expect(edgeCpuPercent({ cpuUsage: 4.8 })).toBe(4.8);
	});

	test('a fully-loaded host stays 100, not 100/cores', () => {
		expect(edgeCpuPercent({ cpuUsage: 100 })).toBe(100);
	});

	test('cpuCores does not affect the result (its value is irrelevant to CPU percent)', () => {
		// A mismatching cpuCores must not divide the already-normalized usage.
		expect(edgeCpuPercent({ cpuUsage: 37.5, cpuCores: 8 } as RawEdgeMetrics)).toBe(37.5);
	});

	test('zero stays zero', () => {
		expect(edgeCpuPercent({ cpuUsage: 0 })).toBe(0);
	});
});

describe('edgeMemoryPercent', () => {
	test('used over total as a percentage', () => {
		expect(edgeMemoryPercent({ memoryUsed: 29213425664, memoryTotal: 39906430976 })).toBeCloseTo(73.2, 1);
	});

	test('zero total yields zero, not NaN or Infinity', () => {
		expect(edgeMemoryPercent({ memoryUsed: 100, memoryTotal: 0 })).toBe(0);
	});
});
