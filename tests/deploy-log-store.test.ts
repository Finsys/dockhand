import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	runLogFileName,
	envDirName,
	parseEnvDirName,
	SizeBudgetTracker,
	usedBytesExcluding
} from '../src/lib/server/deploy-log-store';

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

describe('envDirName / parseEnvDirName -- F5 per-environment directory naming', () => {
	test('a numeric environment id becomes its own string, an environment-less run becomes "null"', () => {
		expect(envDirName(1)).toBe('1');
		expect(envDirName(42)).toBe('42');
		expect(envDirName(null)).toBe('null');
	});

	test('rejects a non-integer environment id rather than silently stringifying it', () => {
		// environmentId always comes from a database column (number | null) -- this is a
		// defensive backstop, the same posture runLogFileName's ID regex takes for runId.
		expect(() => envDirName(1.5)).toThrow();
		expect(() => envDirName(NaN)).toThrow();
	});

	test('parseEnvDirName is the exact inverse of envDirName for every value envDirName can produce', () => {
		expect(parseEnvDirName(envDirName(1))).toBe(1);
		expect(parseEnvDirName(envDirName(42))).toBe(42);
		expect(parseEnvDirName(envDirName(null))).toBe(null);
	});

	test('parseEnvDirName rejects a directory name that is not one of envDirName\'s own outputs', () => {
		// listEnvDirNames() (deploy-log-store.ts) only returns directories, so this should
		// not normally see a stray file name -- but a hand-created or unexpected directory
		// must not be silently misread as some arbitrary environment id.
		expect(() => parseEnvDirName('not-an-env')).toThrow();
		expect(() => parseEnvDirName('-1')).toThrow();
		expect(() => parseEnvDirName('1.5')).toThrow();
	});
});

// ---------------------------------------------------------------------------
// SizeBudgetTracker -- see deploy-log-store.ts's doc comment on the class for
// the performance problem this replaces (a full directory re-scan on every
// appended line) and the concurrency trade-off it makes instead. The F5 fix
// (per-environment directory/budget scoping) is covered by its own describe
// block further down.
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

/** Writes N other-run log files of `sizeEach` bytes each directly into ONE
 *  environment's scratch deploy-logs/<envDirName>/ dir, bypassing appendRunLog so the
 *  byte count is exact and no SizeBudgetTracker is involved in creating the fixture. */
async function seedOtherRunFiles(envId: number | null, count: number, sizeEach: number): Promise<void> {
	const dir = join(scratchDir, 'deploy-logs', envDirName(envId));
	await mkdir(dir, { recursive: true });
	for (let i = 0; i < count; i++) {
		await writeFile(join(dir, `other-${i}.log`), 'x'.repeat(sizeEach));
	}
}

describe('SizeBudgetTracker', () => {
	test('does NOT flag a run that stays well under the budget', async () => {
		await seedOtherRunFiles(null, 5, 1000); // 5 KB of "other" runs already on disk
		const tracker = new SizeBudgetTracker(null, 'run-under', 1_000_000); // 1 MB budget
		let exceeded = false;
		for (let i = 0; i < 20; i++) {
			exceeded = await tracker.recordAppend(100); // 20 * 100 B = 2 KB of own output
		}
		expect(exceeded).toBe(false);
	});

	test('flags a run once its own output plus the rest of the directory crosses the budget', async () => {
		await seedOtherRunFiles(null, 3, 300); // 900 B of "other" runs already on disk
		const tracker = new SizeBudgetTracker(null, 'run-over', 1000); // 1000 B budget
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
		await seedOtherRunFiles(null, 2, 600); // 1200 B of "other" runs, already over a 1000 B budget
		const tracker = new SizeBudgetTracker(null, 'run-preexisting', 1000);
		const exceeded = await tracker.recordAppend(1); // first byte this run ever writes
		expect(exceeded).toBe(true);
	});

	test('re-scans the directory on the FIRST call, then NOT again until the refresh threshold is crossed', async () => {
		await seedOtherRunFiles(null, 500, 10); // matches the reviewer's 500-file benchmark shape
		let scans = 0;
		const countingMeasure = async (envId: number | null, excludeRunId: string) => {
			scans++;
			return usedBytesExcluding(envId, excludeRunId);
		};
		// Refresh threshold set to 1000 B of own output for this test, independent of
		// the 1 MiB production constant -- REFRESH_AFTER_OWN_BYTES is not exported, so
		// this drives the same code path (loaded flag + threshold check) at a size
		// this test can actually cross without allocating a real MiB of strings.
		const tracker = new SizeBudgetTracker(null, 'run-scan-count', 10_000_000, countingMeasure);

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
		await seedOtherRunFiles(null, 5, 10);
		let scans = 0;
		const countingMeasure = async (envId: number | null, excludeRunId: string) => {
			scans++;
			return usedBytesExcluding(envId, excludeRunId);
		};
		// A tiny budget just to construct the tracker; refresh cadence is driven by
		// the module-private REFRESH_AFTER_OWN_BYTES (1 MiB in production), not by
		// this budget value.
		const tracker = new SizeBudgetTracker(null, 'run-refresh', 100_000_000, countingMeasure);

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
		const trackerA = new SizeBudgetTracker(null, 'run-a', 10_000_000);

		await trackerA.recordAppend(100); // A's baseline measured now: directory is empty

		// B writes 50 KB of real output AFTER A's baseline was taken, into the SAME
		// environment (null) as A -- this test is about same-environment concurrency,
		// not cross-environment isolation (see the F5 describe block below for that).
		const bDir = join(scratchDir, 'deploy-logs', envDirName(null));
		await mkdir(bDir, { recursive: true });
		await writeFile(join(bDir, 'run-b.log'), 'y'.repeat(50_000));

		// A has not crossed its own refresh threshold (well under 1 MiB of its own
		// output), so its cached view of "everything else" still does not include
		// B's 50 KB -- that is the documented gap, reproduced here.
		const stillBlind = await trackerA.recordAppend(100);
		expect(stillBlind).toBe(false);

		// A fresh tracker (or a refreshed one) DOES see it -- the gap is temporary,
		// not a permanent miss.
		const freshView = await usedBytesExcluding(null, 'run-a');
		expect(freshView).toBeGreaterThanOrEqual(50_000);
	});
});

// ---------------------------------------------------------------------------
// F5 fix: per-environment directory/budget scoping. THE key regression test --
// see F5-REPORT.md for the counter-test run against this block with the fix
// reverted (envDirName() collapsed to a single shared directory).
// ---------------------------------------------------------------------------

describe('SizeBudgetTracker -- per-environment scoping (F5)', () => {
	test('filling environment A\'s budget does not truncate environment B\'s run (separate directories) -- THE key F5 regression test', async () => {
		// Environment A already has 950 B of ANOTHER run's output on disk -- right up
		// against a 1000 B budget, entirely on its own, before environment A's own
		// run under test has written a single byte. This is deliberately close to the
		// budget by itself: under the pre-fix shared directory, these 950 B would be
		// visible to EVERY environment's tracker, not just environment A's own.
		await seedOtherRunFiles(1, 1, 950);
		const trackerA = new SizeBudgetTracker(1, 'run-a', 1000);
		// Environment A's own run pushes ITS OWN environment over budget, as expected.
		const exceededA = await trackerA.recordAppend(100); // 950 + 100 = 1050 > 1000
		expect(exceededA).toBe(true);

		// Environment B has NOTHING of its own on disk and the SAME 1000 B budget.
		// Its run writes a small, unrelated 100 B chunk -- nowhere near 1000 B on its
		// own. Against the pre-fix SHARED directory/budget, environment A's 950 B
		// fixture above would land in the exact same directory environment B's
		// tracker scans, so B's tiny write would ALSO read as over budget (950 + 100
		// = 1050 > 1000) even though environment B's run never came close to writing
		// 1000 B itself -- exactly the silent cross-tenant truncation F5 fixes.
		const trackerB = new SizeBudgetTracker(2, 'run-b', 1000);
		const exceededB = await trackerB.recordAppend(100);
		expect(exceededB).toBe(false);
	});

	test('two environments\' own files never appear in each other\'s usedBytesExcluding() total', async () => {
		await seedOtherRunFiles(1, 3, 1000); // 3 KB in environment 1
		await seedOtherRunFiles(2, 1, 50); // 50 B in environment 2

		const totalForEnv1 = await usedBytesExcluding(1, 'irrelevant-run-id');
		const totalForEnv2 = await usedBytesExcluding(2, 'irrelevant-run-id');

		expect(totalForEnv1).toBe(3000);
		expect(totalForEnv2).toBe(50);
	});

	test('a run\'s own log file lives under its own environment\'s directory, and NOT under a different environment\'s directory with the same run id', async () => {
		const { appendRunLog, runLogPath } = await import('../src/lib/server/deploy-log-store');
		await appendRunLog(1, 'shared-id', 'env-1 output\n');
		await appendRunLog(2, 'shared-id', 'env-2 output\n');

		const { readFile } = await import('node:fs/promises');
		expect(await readFile(runLogPath(1, 'shared-id'), 'utf8')).toBe('env-1 output\n');
		expect(await readFile(runLogPath(2, 'shared-id'), 'utf8')).toBe('env-2 output\n');
		expect(runLogPath(1, 'shared-id')).not.toBe(runLogPath(2, 'shared-id'));
	});
});

describe('listEnvDirNames -- F5 environment discovery for the reconcile job', () => {
	test('lists every environment directory currently on disk, and nothing else', async () => {
		const { listEnvDirNames } = await import('../src/lib/server/deploy-log-store');
		await seedOtherRunFiles(1, 1, 10);
		await seedOtherRunFiles(2, 1, 10);
		await seedOtherRunFiles(null, 1, 10);

		const names = (await listEnvDirNames()).sort();
		expect(names).toEqual(['1', '2', 'null']);
	});

	test('excludes a stray FILE directly under deploy-logs/ (the pre-F5 flat legacy layout)', async () => {
		const { listEnvDirNames } = await import('../src/lib/server/deploy-log-store');
		const dir = join(scratchDir, 'deploy-logs');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'legacy-run.log'), 'old flat-layout content');
		await seedOtherRunFiles(1, 1, 10);

		const names = await listEnvDirNames();
		expect(names).toEqual(['1']);
	});

	test('returns an empty list when deploy-logs/ does not exist yet', async () => {
		const { listEnvDirNames } = await import('../src/lib/server/deploy-log-store');
		expect(await listEnvDirNames()).toEqual([]);
	});
});

describe('readRunLog -- F5 back-compat fallback to the pre-F5 flat legacy path', () => {
	test('finds a file at the new per-environment path first', async () => {
		const { appendRunLog, readRunLog } = await import('../src/lib/server/deploy-log-store');
		await appendRunLog(1, 'r1', 'new layout content');
		expect(await readRunLog(1, 'r1')).toBe('new layout content');
	});

	test('falls back to the pre-F5 flat path when no per-environment file exists', async () => {
		const { readRunLog } = await import('../src/lib/server/deploy-log-store');
		const dir = join(scratchDir, 'deploy-logs');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'legacy.log'), 'old flat layout content');

		expect(await readRunLog(1, 'legacy')).toBe('old flat layout content');
	});

	test('a run with a file at NEITHER the per-environment nor the legacy path returns null', async () => {
		const { readRunLog } = await import('../src/lib/server/deploy-log-store');
		expect(await readRunLog(1, 'nowhere')).toBeNull();
	});
});

describe('deleteRunLog -- F5 clears both the per-environment AND the legacy flat path', () => {
	test('removes a file at the new per-environment path', async () => {
		const { appendRunLog, readRunLog, deleteRunLog } = await import('../src/lib/server/deploy-log-store');
		await appendRunLog(1, 'r1', 'content');
		await deleteRunLog(1, 'r1');
		expect(await readRunLog(1, 'r1')).toBeNull();
	});

	test('also removes a leftover legacy flat-path file for the same run id, so it cannot outlive its own deletion', async () => {
		const { readRunLog, deleteRunLog } = await import('../src/lib/server/deploy-log-store');
		const dir = join(scratchDir, 'deploy-logs');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'legacy.log'), 'stale legacy content');

		await deleteRunLog(1, 'legacy');

		expect(await readRunLog(1, 'legacy')).toBeNull();
	});

	test('deleting a nonexistent run\'s log is a no-op, not an error', async () => {
		const { deleteRunLog } = await import('../src/lib/server/deploy-log-store');
		await expect(deleteRunLog(1, 'never-existed')).resolves.toBeUndefined();
	});
});
