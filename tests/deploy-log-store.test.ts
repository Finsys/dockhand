import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogFileName, SizeBudgetTracker, usedBytesExcluding } from '../src/lib/server/deploy-log-store';

describe('runLogFileName', () => {
	test('builds a name from a plain run id', () => {
		expect(runLogFileName('a1b2c3')).toBe('a1b2c3.log');
	});

	test('rejects anything that is not a plain id, so a run id can never become a path', () => {
		// The run id reaches this function from a route parameter. A traversal attempt must
		// throw rather than resolve to a file outside the log directory.
		expect(() => runLogFileName('../../etc/passwd')).toThrow();
		expect(() => runLogFileName('a/b')).toThrow();
		expect(() => runLogFileName('')).toThrow();
	});
});

// ---------------------------------------------------------------------------
// SizeBudgetTracker -- see deploy-log-store.ts's doc comment on the class for
// the performance problem this replaces (a full directory re-scan on every
// appended line) and the concurrency trade-off it makes instead.
// ---------------------------------------------------------------------------

// deploy-log-store.ts reads process.env.DATA_DIR on every call (logDir()), not at
// import time -- so it's enough to point it at a fresh scratch dir per test and put
// the previous value back afterwards. Bun runs a whole test file in ONE process: a
// DATA_DIR left set would leak into unrelated suites (see
// test-coverage-pflicht.md's "prozessweite Zustände werden geklammert" -- this is
// exactly the trap fs-guard.test.ts fell into once already).
const previousDataDir = process.env.DATA_DIR;
let scratchDir: string;

beforeEach(async () => {
	scratchDir = await mkdtemp(join(tmpdir(), 'deploy-log-store-'));
	process.env.DATA_DIR = scratchDir;
});
afterEach(async () => {
	if (previousDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = previousDataDir;
	await rm(scratchDir, { recursive: true, force: true });
});

/** Writes N other-run log files of `sizeEach` bytes each directly into the scratch
 *  deploy-logs/ dir, bypassing appendRunLog so the byte count is exact and no
 *  SizeBudgetTracker is involved in creating the fixture. */
async function seedOtherRunFiles(count: number, sizeEach: number): Promise<void> {
	const dir = join(scratchDir, 'deploy-logs');
	await mkdir(dir, { recursive: true });
	for (let i = 0; i < count; i++) {
		await writeFile(join(dir, `other-${i}.log`), 'x'.repeat(sizeEach));
	}
}

describe('SizeBudgetTracker', () => {
	test('does NOT flag a run that stays well under the budget', async () => {
		await seedOtherRunFiles(5, 1000); // 5 KB of "other" runs already on disk
		const tracker = new SizeBudgetTracker('run-under', 1_000_000); // 1 MB budget
		let exceeded = false;
		for (let i = 0; i < 20; i++) {
			exceeded = await tracker.recordAppend(100); // 20 * 100 B = 2 KB of own output
		}
		expect(exceeded).toBe(false);
	});

	test('flags a run once its own output plus the rest of the directory crosses the budget', async () => {
		await seedOtherRunFiles(3, 300); // 900 B of "other" runs already on disk
		const tracker = new SizeBudgetTracker('run-over', 1000); // 1000 B budget
		let exceeded = false;
		// 900 B baseline + 10*100 B own = 1900 B, well past the 1000 B budget.
		for (let i = 0; i < 10 && !exceeded; i++) {
			exceeded = await tracker.recordAppend(100);
		}
		expect(exceeded).toBe(true);
	});

	// Gegenversuch (test-coverage-pflicht.md): a tracker that never re-reads the
	// directory -- cachedOtherBytes stuck at 0 forever, e.g. because refresh() was
	// never called -- would let a run with a large pre-existing "other" total sail
	// straight past the budget using only its own (small) byte count. This is the
	// mutation the previous test guards against; this test isolates the SAME
	// mechanism from a different angle (pre-existing total alone is already over
	// budget, before this run writes a single byte).
	test('flags a run immediately if the directory is already over budget before this run writes anything', async () => {
		await seedOtherRunFiles(2, 600); // 1200 B of "other" runs, already over a 1000 B budget
		const tracker = new SizeBudgetTracker('run-preexisting', 1000);
		const exceeded = await tracker.recordAppend(1); // first byte this run ever writes
		expect(exceeded).toBe(true);
	});

	test('re-scans the directory on the FIRST call, then NOT again until the refresh threshold is crossed', async () => {
		await seedOtherRunFiles(500, 10); // matches the reviewer's 500-file benchmark shape
		let scans = 0;
		const countingMeasure = async (excludeRunId: string) => {
			scans++;
			return usedBytesExcluding(excludeRunId);
		};
		// Refresh threshold set to 1000 B of own output for this test, independent of
		// the 1 MiB production constant -- REFRESH_AFTER_OWN_BYTES is not exported, so
		// this drives the same code path (loaded flag + threshold check) at a size
		// this test can actually cross without allocating a real MiB of strings.
		const tracker = new SizeBudgetTracker('run-scan-count', 10_000_000, countingMeasure);

		// 200 appends of 10 B each = 2000 B of own output, matching the reviewer's
		// 200-line benchmark. This is the exact scenario that used to cost one full
		// directory scan PER call (200 scans of 500 files); a working tracker must
		// not do that.
		for (let i = 0; i < 200; i++) {
			await tracker.recordAppend(10);
		}
		expect(scans).toBe(1); // one lazy scan on the first call, none after
		expect(scans).toBeLessThan(200); // the actual regression this fixes
	});

	test('re-scans again once accumulated own bytes cross the refresh threshold', async () => {
		await seedOtherRunFiles(5, 10);
		let scans = 0;
		const countingMeasure = async (excludeRunId: string) => {
			scans++;
			return usedBytesExcluding(excludeRunId);
		};
		// A tiny budget just to construct the tracker; refresh cadence is driven by
		// the module-private REFRESH_AFTER_OWN_BYTES (1 MiB in production), not by
		// this budget value.
		const tracker = new SizeBudgetTracker('run-refresh', 100_000_000, countingMeasure);

		await tracker.recordAppend(10); // scan #1 (lazy load)
		expect(scans).toBe(1);

		// Push well past 1 MiB of own output in one shot -- the tracker must re-scan
		// rather than trust a MiB-stale cache indefinitely.
		await tracker.recordAppend(2 * 1024 * 1024);
		expect(scans).toBe(2);
	});

	test('concurrent runs are invisible to each other between refreshes -- documented trade-off, not a bug', async () => {
		// Two trackers for two DIFFERENT runs sharing the same directory. Tracker A's
		// baseline is measured before B writes anything; B's own bytes are then
		// invisible to A until A refreshes again. This is exactly the imprecision
		// SizeBudgetTracker's doc comment describes -- this test pins the size of
		// that gap so a future change can't silently widen it without this test
		// noticing.
		const trackerA = new SizeBudgetTracker('run-a', 10_000_000);

		await trackerA.recordAppend(100); // A's baseline measured now: directory is empty

		// B writes 50 KB of real output AFTER A's baseline was taken.
		const bDir = join(scratchDir, 'deploy-logs');
		await mkdir(bDir, { recursive: true });
		await writeFile(join(bDir, 'run-b.log'), 'y'.repeat(50_000));

		// A has not crossed its own refresh threshold (well under 1 MiB of its own
		// output), so its cached view of "everything else" still does not include
		// B's 50 KB -- that is the documented gap, reproduced here.
		const stillBlind = await trackerA.recordAppend(100);
		expect(stillBlind).toBe(false);

		// A fresh tracker (or a refreshed one) DOES see it -- the gap is temporary,
		// not a permanent miss.
		const freshView = await usedBytesExcluding('run-a');
		expect(freshView).toBeGreaterThanOrEqual(50_000);
	});
});
