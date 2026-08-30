import { appendFile, mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ID = /^[A-Za-z0-9_-]+$/;

/**
 * A run id comes from a route parameter, so it is validated rather than sanitised:
 * a value that is not a plain id is a bug or an attack, and neither should quietly
 * resolve to some other file.
 */
export function runLogFileName(runId: string): string {
	if (!ID.test(runId)) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
	return `${runId}.log`;
}

function logDir(): string {
	return join(process.env.DATA_DIR || './data', 'deploy-logs');
}

export function runLogPath(runId: string): string {
	return join(logDir(), runLogFileName(runId));
}

/** Total bytes the log directory may occupy before new writes are refused. */
const BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How many bytes of a run's OWN output SizeBudgetTracker lets accumulate against its
 * cached view of the rest of the directory before re-scanning that view. Bounds how
 * stale the cache can get for a single long-running deploy -- see SizeBudgetTracker's
 * doc comment for the concurrency trade-off this makes.
 */
const REFRESH_AFTER_OWN_BYTES = 1 * 1024 * 1024; // 1 MiB

export async function appendRunLog(runId: string, chunk: string): Promise<void> {
	await mkdir(logDir(), { recursive: true });
	await appendFile(runLogPath(runId), chunk);
}

export async function readRunLog(runId: string): Promise<string | null> {
	try {
		return await readFile(runLogPath(runId), 'utf8');
	} catch {
		return null;
	}
}

export async function deleteRunLog(runId: string): Promise<void> {
	await rm(runLogPath(runId), { force: true });
}

export async function listRunLogIds(): Promise<string[]> {
	try {
		const names = await readdir(logDir());
		return names.filter((n) => n.endsWith('.log')).map((n) => n.slice(0, -4));
	} catch {
		return [];
	}
}

export async function usedBytes(): Promise<number> {
	let total = 0;
	for (const id of await listRunLogIds()) {
		try {
			total += (await stat(runLogPath(id))).size;
		} catch {
			/* raced with cleanup */
		}
	}
	return total;
}

/**
 * Same as usedBytes(), but leaves excludeRunId's own file out of the sum. Used by
 * SizeBudgetTracker to get the size of "everything ELSE", so it can add this run's
 * own bytes on top from an in-memory counter instead of re-stat'ing its own file.
 */
export async function usedBytesExcluding(excludeRunId: string): Promise<number> {
	let total = 0;
	for (const id of await listRunLogIds()) {
		if (id === excludeRunId) continue;
		try {
			total += (await stat(runLogPath(id))).size;
		} catch {
			/* raced with cleanup */
		}
	}
	return total;
}

export async function budgetExceeded(): Promise<boolean> {
	return (await usedBytes()) > BUDGET_BYTES;
}

/**
 * Tracks whether ONE run's output has pushed deploy-logs/ over BUDGET_BYTES, without
 * doing a full directory scan (readdir + stat every file) on every appended line.
 *
 * Before this existed, deploy-run-record.ts's line() called budgetExceeded() -- a full
 * usedBytes() scan -- after EVERY line, so a deploy with N output lines against a log
 * directory holding M past runs' files cost O(N*M) stat calls. Measured on this
 * machine: 200 lines against 500 existing log files took ~16.2s (~81ms/line); the same
 * 200 lines with the directory scan removed entirely took ~49ms total. That scan is
 * needed to stay honest about the directory's actual size, so it can't just be
 * dropped -- it can only be done less often.
 *
 * How: the directory total EXCLUDING this run's own file (usedBytesExcluding) is
 * measured once, lazily, on the first recordAppend() call, and cached. Each
 * recordAppend() after that just adds the byte length the caller reports (bytes it
 * just wrote to ITS OWN file -- no stat() involved) to that cached total in memory.
 * The cache is re-measured every REFRESH_AFTER_OWN_BYTES bytes of this run's own
 * output, so a long deploy's view of "everything else" can't drift arbitrarily far
 * from reality -- at most REFRESH_AFTER_OWN_BYTES stale before the next refresh
 * catches up.
 *
 * Concurrency: OTHER runs writing at the same time are invisible between this
 * tracker's refreshes. A second run that starts writing right after this one's
 * baseline was measured can add up to its own full output before the next refresh
 * reflects it, so the total this tracker checks against can undercount the real
 * directory size by that much in the meantime. This is an intentional trade-off:
 * BUDGET_BYTES (2 GiB, deliberately generous) exists to catch a filled disk, not to
 * enforce an exact quota -- the design doc calls for aborting "at the end of writing,
 * not truncating mid-line", never for a precise cutoff. The OLD per-line full rescan
 * did not close this gap either: budgetExceeded() reads the directory at the moment
 * it's called, with no locking against another run's concurrent appendRunLog() --
 * the old code just paid for that same imprecision on every single line instead of
 * once per MiB.
 */
export class SizeBudgetTracker {
	/** "Everything else" (every OTHER run's file), last measured by refresh(). NEVER
	 *  includes this run's own file -- see usedBytesExcluding(). */
	private cachedOtherBytes = 0;
	/** Every byte THIS run has appended so far, summed in memory as recordAppend()
	 *  is called. This is the run's true own total and is never reset -- it does not
	 *  need a re-scan to stay accurate, because the caller already knows exactly what
	 *  it just wrote. */
	private ownBytesTotal = 0;
	/** Own bytes appended since the LAST refresh() -- reset to 0 on every refresh.
	 *  Only exists to decide WHEN to refresh; the budget check itself always uses
	 *  ownBytesTotal, not this. */
	private ownBytesSinceLastScan = 0;
	private loaded = false;

	constructor(
		private readonly runId: string,
		private readonly budgetBytes: number = BUDGET_BYTES,
		/** Test-only seam: lets tests count/replace the directory scan without
		 *  writing real files. Production code never passes this -- it always gets
		 *  the real usedBytesExcluding. */
		private readonly measureOthers: (excludeRunId: string) => Promise<number> = usedBytesExcluding
	) {}

	private async refresh(): Promise<void> {
		this.cachedOtherBytes = await this.measureOthers(this.runId);
		this.ownBytesSinceLastScan = 0;
		this.loaded = true;
	}

	/**
	 * Call once per chunk appended to this run's own log file, with the number of
	 * UTF-8 bytes just written (Buffer.byteLength(chunk, 'utf8') -- NOT chunk.length,
	 * which counts UTF-16 code units and undercounts multi-byte characters). Returns
	 * whether the directory total, including this run's own bytes so far, currently
	 * exceeds the budget.
	 *
	 * ownBytesTotal is updated BEFORE the refresh decision, on purpose: a single
	 * chunk large enough to cross REFRESH_AFTER_OWN_BYTES on its own must trigger its
	 * refresh in this same call, not the next one -- otherwise a caller that stops
	 * appending right after such a chunk would leave the tracker's view of
	 * "everything else" stale for the rest of the run.
	 */
	async recordAppend(byteLength: number): Promise<boolean> {
		this.ownBytesTotal += byteLength;
		this.ownBytesSinceLastScan += byteLength;
		if (!this.loaded || this.ownBytesSinceLastScan >= REFRESH_AFTER_OWN_BYTES) {
			await this.refresh();
		}
		return this.cachedOtherBytes + this.ownBytesTotal > this.budgetBytes;
	}
}
