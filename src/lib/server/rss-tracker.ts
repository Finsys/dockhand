/**
 * RSS Tracker — Per-operation native memory delta tracking
 *
 * Measures process.memoryUsage().rss before and after instrumented operations
 * to identify which background operation is responsible for native memory growth.
 *
 * All functions are no-ops when MEMORY_MONITOR !== 'true'.
 */

import v8 from 'node:v8';
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CategoryStats {
	count: number;
	totalDelta: number;
	maxDelta: number;
	// Lifetime cumulative (never reset)
	lifetimeCount: number;
	lifetimeTotalDelta: number;
}

interface RssSnapshot {
	filename: string;
	timestamp: string;
	uptimeMin: number;
	rssMB: number;
	sizeMB: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const enabled = process.env.MEMORY_MONITOR === 'true';

const categories = new Map<string, CategoryStats>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let snapshotIntervalHandle: ReturnType<typeof setInterval> | null = null;
let periodNumber = 0;
let periodStartRss = 0;
const startupTime = Date.now();
const startupRss = enabled ? process.memoryUsage().rss : 0;

// Snapshot settings
const SNAPSHOT_WARMUP_MS = 5 * 60 * 1000; // 5 min before first snapshot
const SNAPSHOT_INTERVAL_MS = parseInt(process.env.SNAPSHOT_INTERVAL || '60', 10) * 60 * 1000;
const MAX_SNAPSHOTS = 48;

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Capture RSS before an operation. Returns the RSS value.
 * No-op (returns 0) when MEMORY_MONITOR is not set.
 */
export function rssBeforeOp(): number {
	if (!enabled) return 0;
	return process.memoryUsage().rss;
}

/**
 * Record RSS delta after an operation.
 * No-op when MEMORY_MONITOR is not set.
 */
export function rssAfterOp(category: string, before: number): void {
	if (!enabled || before === 0) return;

	const after = process.memoryUsage().rss;
	const delta = after - before;

	let stats = categories.get(category);
	if (!stats) {
		stats = { count: 0, totalDelta: 0, maxDelta: 0, lifetimeCount: 0, lifetimeTotalDelta: 0 };
		categories.set(category, stats);
	}

	stats.count++;
	stats.totalDelta += delta;
	if (Math.abs(delta) > Math.abs(stats.maxDelta)) stats.maxDelta = delta;

	stats.lifetimeCount++;
	stats.lifetimeTotalDelta += delta;
}

/**
 * Get current stats summary.
 */
export function getRssStats() {
	if (!enabled) return null;

	const mem = process.memoryUsage();
	const uptimeMs = Date.now() - startupTime;
	const uptimeHours = uptimeMs / (1000 * 60 * 60);
	const rssGrowth = mem.rss - startupRss;

	const perCategory: Record<string, {
		count: number;
		avgDelta: string;
		maxDelta: string;
		totalDelta: string;
		lifetimeCount: number;
		lifetimeTotalDelta: string;
	}> = {};

	for (const [cat, stats] of categories) {
		perCategory[cat] = {
			count: stats.count,
			avgDelta: stats.count > 0 ? fmtBytes(Math.round(stats.totalDelta / stats.count)) : '0',
			maxDelta: fmtBytes(stats.maxDelta),
			totalDelta: fmtBytes(stats.totalDelta),
			lifetimeCount: stats.lifetimeCount,
			lifetimeTotalDelta: fmtBytes(stats.lifetimeTotalDelta),
		};
	}

	return {
		enabled: true,
		periodNumber,
		rssMB: fmtMB(mem.rss),
		rssGrowthTotal: fmtBytes(rssGrowth),
		rssGrowthPerHour: fmtBytes(uptimeHours > 0.01 ? rssGrowth / uptimeHours : 0),
		uptimeHours: Math.round(uptimeHours * 100) / 100,
		categories: perCategory,
	};
}

// ---------------------------------------------------------------------------
// Periodic logging
// ---------------------------------------------------------------------------

function logPeriodSummary(): void {
	periodNumber++;
	const mem = process.memoryUsage();
	const rssDelta = mem.rss - periodStartRss;
	const uptimeMs = Date.now() - startupTime;
	const uptimeHours = uptimeMs / (1000 * 60 * 60);
	const rssGrowthTotal = mem.rss - startupRss;
	const rssPerHour = uptimeHours > 0.01 ? rssGrowthTotal / uptimeHours : 0;

	let summary = `[RSS] #${periodNumber} rss=${fmtMB(mem.rss)}(${fmtDelta(rssDelta)}) total=${fmtDelta(rssGrowthTotal)} rate=${fmtBytes(Math.round(rssPerHour))}/h`;

	// Sort categories by absolute totalDelta descending
	const sorted = [...categories.entries()]
		.filter(([, s]) => s.count > 0)
		.sort((a, b) => Math.abs(b[1].totalDelta) - Math.abs(a[1].totalDelta));

	let accountedDelta = 0;
	for (const [cat, stats] of sorted) {
		const avg = stats.count > 0 ? Math.round(stats.totalDelta / stats.count) : 0;
		summary += `\n  ${cat.padEnd(14)} n=${String(stats.count).padStart(4)}  avg=${fmtDelta(avg).padStart(7)}  max=${fmtDelta(stats.maxDelta).padStart(7)}  total=${fmtDelta(stats.totalDelta).padStart(7)}`;
		accountedDelta += stats.totalDelta;
	}

	const unaccounted = rssDelta - accountedDelta;
	if (sorted.length > 0) {
		summary += `\n  ${'unaccounted'.padEnd(14)} ${fmtDelta(unaccounted).padStart(7)}`;
	}

	console.log(summary);

	// Reset per-period counters (keep lifetime)
	for (const stats of categories.values()) {
		stats.count = 0;
		stats.totalDelta = 0;
		stats.maxDelta = 0;
	}
	periodStartRss = mem.rss;
}

// ---------------------------------------------------------------------------
// Heap snapshots
// ---------------------------------------------------------------------------

function getSnapshotDir(): string {
	const dataDir = process.env.DATA_DIR || './data';
	return join(dataDir, 'snapshots');
}

function ensureSnapshotDir(): string {
	const dir = getSnapshotDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function cleanupOldSnapshots(dir: string): void {
	try {
		const files = readdirSync(dir)
			.filter(f => f.endsWith('.heapsnapshot'))
			.map(f => ({ name: f, time: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => a.time - b.time);

		while (files.length > MAX_SNAPSHOTS) {
			const oldest = files.shift()!;
			try {
				unlinkSync(join(dir, oldest.name));
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

/**
 * Dump a V8 heap snapshot to disk. Returns the filename.
 */
export function dumpHeapSnapshot(): string | null {
	if (!enabled) return null;

	const dir = ensureSnapshotDir();
	cleanupOldSnapshots(dir);

	const mem = process.memoryUsage();
	const uptimeMin = Math.round((Date.now() - startupTime) / 60000);
	const rssMB = Math.round(mem.rss / (1024 * 1024));
	const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').substring(0, 19);
	const filename = `heap-${ts}-${uptimeMin}m-${rssMB}mb.heapsnapshot`;
	const filepath = join(dir, filename);

	try {
		v8.writeHeapSnapshot(filepath);
		console.log(`[RSS] Heap snapshot saved: ${filepath}`);
		return filename;
	} catch (err) {
		console.error(`[RSS] Failed to write heap snapshot:`, err instanceof Error ? err.message : String(err));
		return null;
	}
}

/**
 * List saved heap snapshots.
 */
export function listHeapSnapshots(): RssSnapshot[] {
	const dir = getSnapshotDir();
	if (!existsSync(dir)) return [];

	try {
		return readdirSync(dir)
			.filter(f => f.endsWith('.heapsnapshot'))
			.map(f => {
				const stat = statSync(join(dir, f));
				// Parse filename: heap-YYYY-MM-DD-HH-MM-SS-{uptime}m-{rss}mb.heapsnapshot
				const match = f.match(/heap-(.+?)-(\d+)m-(\d+)mb\.heapsnapshot/);
				return {
					filename: f,
					timestamp: stat.mtime.toISOString(),
					uptimeMin: match ? parseInt(match[2]) : 0,
					rssMB: match ? parseInt(match[3]) : 0,
					sizeMB: Math.round(stat.size / (1024 * 1024) * 10) / 10,
				};
			})
			.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	} catch {
		return [];
	}
}

function startAutoSnapshots(): void {
	// First snapshot after warmup
	setTimeout(() => {
		dumpHeapSnapshot();

		// Then every SNAPSHOT_INTERVAL_MS
		snapshotIntervalHandle = setInterval(() => {
			dumpHeapSnapshot();
		}, SNAPSHOT_INTERVAL_MS);
	}, SNAPSHOT_WARMUP_MS);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the RSS tracker. Call once on startup.
 */
export function startRssTracker(): void {
	if (!enabled) return;

	periodStartRss = process.memoryUsage().rss;
	console.log(`[RSS] Tracker started. Initial RSS: ${fmtMB(periodStartRss)}. Logging every 60s.`);

	intervalHandle = setInterval(logPeriodSummary, 60_000);

	startAutoSnapshots();
}

/**
 * Stop the RSS tracker.
 */
export function stopRssTracker(): void {
	if (intervalHandle) {
		clearInterval(intervalHandle);
		intervalHandle = null;
	}
	if (snapshotIntervalHandle) {
		clearInterval(snapshotIntervalHandle);
		snapshotIntervalHandle = null;
	}
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtMB(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function fmtBytes(bytes: number): string {
	const abs = Math.abs(bytes);
	const sign = bytes < 0 ? '-' : '+';
	if (abs < 1024) return `${sign}${abs}B`;
	if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}K`;
	return `${sign}${(abs / (1024 * 1024)).toFixed(1)}M`;
}

function fmtDelta(bytes: number): string {
	return fmtBytes(bytes);
}
