/**
 * Memory Debug Endpoint
 *
 * Returns Node.js memory stats for monitoring.
 * Only available when MEMORY_MONITOR=true environment variable is set.
 *
 * GET /api/debug/memory        - Memory stats (with optional ?gc=true to force GC first)
 * GET /api/debug/memory?gc=true - Force garbage collection before reporting
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import v8 from 'node:v8';
import os from 'node:os';
import { getRssStats, dumpHeapSnapshot, listHeapSnapshots } from '$lib/server/rss-tracker';

// Track startup time and initial RSS for growth rate calculation
const startupTime = Date.now();
const startupRss = process.memoryUsage().rss;

export const GET: RequestHandler = async ({ url }) => {
	if (process.env.MEMORY_MONITOR !== 'true') {
		return json({ error: 'Memory monitor not enabled. Set MEMORY_MONITOR=true.' }, { status: 403 });
	}

	// Trigger manual heap snapshot
	if (url.searchParams.has('snapshot')) {
		const filename = dumpHeapSnapshot();
		return json({
			snapshot: filename ? { filename, message: 'Heap snapshot saved' } : { error: 'Failed to save snapshot' }
		});
	}

	// List saved snapshots
	if (url.searchParams.has('snapshots')) {
		return json({ snapshots: listHeapSnapshots() });
	}

	// Force GC if requested and available
	const forceGc = url.searchParams.get('gc') === 'true';
	if (forceGc && typeof globalThis.gc === 'function') {
		globalThis.gc();
	}

	const mem = process.memoryUsage();
	const heap = v8.getHeapStatistics();
	const uptimeMs = Date.now() - startupTime;
	const uptimeHours = uptimeMs / (1000 * 60 * 60);
	const rssGrowth = mem.rss - startupRss;
	const rssGrowthPerHour = uptimeHours > 0.01 ? rssGrowth / uptimeHours : 0;

	return json({
		timestamp: new Date().toISOString(),
		uptime: {
			ms: uptimeMs,
			hours: Math.round(uptimeHours * 100) / 100,
			human: formatUptime(uptimeMs),
		},
		gcForced: forceGc && typeof globalThis.gc === 'function',
		gcAvailable: typeof globalThis.gc === 'function',
		process: {
			rss: formatBytes(mem.rss),
			heapTotal: formatBytes(mem.heapTotal),
			heapUsed: formatBytes(mem.heapUsed),
			external: formatBytes(mem.external),
			arrayBuffers: formatBytes(mem.arrayBuffers),
			rssRaw: mem.rss,
			heapTotalRaw: mem.heapTotal,
			heapUsedRaw: mem.heapUsed,
			externalRaw: mem.external,
			arrayBuffersRaw: mem.arrayBuffers,
		},
		growth: {
			rssSinceStartup: formatBytes(rssGrowth),
			rssPerHour: formatBytes(Math.round(rssGrowthPerHour)),
			startupRss: formatBytes(startupRss),
		},
		v8Heap: {
			totalHeapSize: formatBytes(heap.total_heap_size),
			usedHeapSize: formatBytes(heap.used_heap_size),
			heapSizeLimit: formatBytes(heap.heap_size_limit),
			totalPhysicalSize: formatBytes(heap.total_physical_size),
			totalAvailableSize: formatBytes(heap.total_available_size),
			mallocedMemory: formatBytes(heap.malloced_memory),
			peakMallocedMemory: formatBytes(heap.peak_malloced_memory),
			externalMemory: formatBytes(heap.external_memory),
			numberOfNativeContexts: heap.number_of_native_contexts,
			numberOfDetachedContexts: heap.number_of_detached_contexts,
		},
		system: {
			totalMemory: formatBytes(os.totalmem()),
			freeMemory: formatBytes(os.freemem()),
			cpus: os.cpus().length,
			platform: os.platform(),
			arch: os.arch(),
			nodeVersion: process.version,
		},
		rssTracker: getRssStats(),
	});
};

function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const sign = bytes < 0 ? '-' : '';
	const abs = Math.abs(bytes);
	if (abs < 1024) return `${sign}${abs} B`;
	if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
	if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / (1024 * 1024)).toFixed(1)} MB`;
	return `${sign}${(abs / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}
