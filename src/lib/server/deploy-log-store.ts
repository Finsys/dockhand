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

/**
 * F5 fix: the directory name (under deploy-logs/) that holds ONE environment's OWN
 * run log files and counts against ONE environment's OWN size budget.
 *
 * Before this existed, every environment shared a SINGLE deploy-logs/ directory and a
 * single BUDGET_BYTES total (see SizeBudgetTracker below). A user with deploy rights
 * in ONE environment could fill that shared budget with a noisy deploy, which then
 * silently truncated the deploy logs and summaries of every OTHER environment -- a
 * multi-tenant audit-trail integrity violation, since a deploy log is exactly the
 * evidence an operator reaches for after something goes wrong. Scoping the directory
 * (and therefore the budget, since usedBytes()/usedBytesExcluding() only ever look
 * inside ONE environment's directory) per environment is the entire fix.
 *
 * `environmentId` always comes from a database column (`number | null`, see
 * ScheduleExecutionData in db.ts) -- never attacker-controlled free text reaching
 * this function directly. This still asserts the shape rather than trusting it
 * blindly, the same posture runLogFileName's ID regex takes for runId: a value that
 * is not a plain integer or null is a bug, and should throw rather than quietly
 * resolve to some unexpected directory name.
 *
 * The `null` case (an install with no environments / a run not attributed to one --
 * see createRunRecorder's `envId: number | null` input) gets the literal directory
 * name "null", not an omitted segment. `String(null) === 'null'` in JS already reads
 * exactly this way, so this is not inventing a new convention -- it is naming the one
 * `String(envId)` would already produce, so the special case is documented rather
 * than accidental.
 */
export function envDirName(envId: number | null): string {
	if (envId === null) return 'null';
	if (!Number.isInteger(envId)) {
		throw new Error(`invalid environment id: ${JSON.stringify(envId)}`);
	}
	return String(envId);
}

/**
 * The inverse of envDirName() -- turns a directory name discovered on disk (via
 * listEnvDirNames()) back into the environmentId it represents. Used by the
 * reconcile job, which learns which environments have files by LISTING
 * deploy-logs/, rather than being handed a set of ids up front.
 *
 * Throws on anything that is not one of envDirName()'s own outputs. listEnvDirNames()
 * already filters to directories only (excluding the pre-F5 flat-layout .log files --
 * see legacyFlatRunLogPath), so in practice this only ever sees "null" or a
 * non-negative integer string; the throw is a defensive backstop against a
 * hand-created or otherwise unexpected directory being silently misread as some
 * arbitrary environment id.
 */
export function parseEnvDirName(name: string): number | null {
	if (name === 'null') return null;
	if (!/^\d+$/.test(name)) {
		throw new Error(`not an environment directory name: ${JSON.stringify(name)}`);
	}
	return Number(name);
}

function deployLogsRoot(): string {
	return join(process.env.DATA_DIR || './data', 'deploy-logs');
}

/** One environment's OWN log directory: deploy-logs/<envDirName(envId)>/. */
function logDir(envId: number | null): string {
	return join(deployLogsRoot(), envDirName(envId));
}

export function runLogPath(envId: number | null, runId: string): string {
	return join(logDir(envId), runLogFileName(runId));
}

/**
 * The path a run's log file would have lived at BEFORE the F5 per-environment
 * scoping existed: deploy-logs/<runId>.log, no environment subdirectory. This branch
 * introduced deploy-log-store.ts in the first place -- there is no released version
 * of Dockhand that ever wrote logs in this flat layout, so there is no production
 * data to migrate, and appendRunLog()/deleteRunLog() never write here.
 *
 * readRunLog() still falls back to this path (see its doc comment) purely as a
 * robustness measure: a file placed here by hand -- a manual copy, a fixture, a
 * future migration script -- is still found instead of silently 404ing, rather than
 * this fix assuming its own directory layout is the only one that will ever exist on
 * disk. deleteRunLog() also clears it, so such a file cannot outlive the record that
 * pointed at it.
 */
function legacyFlatRunLogPath(runId: string): string {
	return join(deployLogsRoot(), runLogFileName(runId));
}

/** Total bytes ONE environment's log directory may occupy before new writes are refused. */
const BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How many bytes of a run's OWN output SizeBudgetTracker lets accumulate against its
 * cached view of the rest of the directory before re-scanning that view. Bounds how
 * stale the cache can get for a single long-running deploy -- see SizeBudgetTracker's
 * doc comment for the concurrency trade-off this makes.
 */
const REFRESH_AFTER_OWN_BYTES = 1 * 1024 * 1024; // 1 MiB

export async function appendRunLog(envId: number | null, runId: string, chunk: string): Promise<void> {
	await mkdir(logDir(envId), { recursive: true });
	await appendFile(runLogPath(envId, runId), chunk);
}

/**
 * Reads a run's log text. Tries the run's OWN environment directory first -- the
 * only place appendRunLog() ever writes -- and falls back to the pre-F5 flat path
 * (legacyFlatRunLogPath) if no file exists there. See that function's doc comment
 * for why the fallback exists despite there being no production data in that layout.
 * A file that exists at NEITHER path returns null, exactly as before F5.
 */
export async function readRunLog(envId: number | null, runId: string): Promise<string | null> {
	try {
		return await readFile(runLogPath(envId, runId), 'utf8');
	} catch {
		try {
			return await readFile(legacyFlatRunLogPath(runId), 'utf8');
		} catch {
			return null;
		}
	}
}

/**
 * Removes a run's log file from its own environment directory AND from the pre-F5
 * flat legacy path (force: true -- a path that was never there is not an error), so
 * a run whose file happens to have been found via readRunLog()'s legacy fallback
 * does not survive its own deletion.
 */
export async function deleteRunLog(envId: number | null, runId: string): Promise<void> {
	await rm(runLogPath(envId, runId), { force: true });
	await rm(legacyFlatRunLogPath(runId), { force: true });
}

export async function listRunLogIds(envId: number | null): Promise<string[]> {
	try {
		const names = await readdir(logDir(envId));
		return names.filter((n) => n.endsWith('.log')).map((n) => n.slice(0, -4));
	} catch {
		return [];
	}
}

/**
 * Every environment directory name currently present under deploy-logs/. Used by the
 * reconcile job (deploy-log-reconcile.ts) to discover which environments have ANY
 * files on disk, without first needing to already know the full set of environment
 * ids from the database (an environment that was later deleted, but still has
 * orphaned log files, would otherwise never be reconciled).
 *
 * Filters to directories only via readdir's withFileTypes -- a stray FILE directly
 * under deploy-logs/ is the pre-F5 flat legacy layout (legacyFlatRunLogPath), not an
 * environment directory, and is intentionally excluded: F5 is a fresh, unreleased
 * feature with no production data in that layout to reconcile (see that function's
 * doc comment).
 */
export async function listEnvDirNames(): Promise<string[]> {
	try {
		const entries = await readdir(deployLogsRoot(), { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

export async function usedBytes(envId: number | null): Promise<number> {
	let total = 0;
	for (const id of await listRunLogIds(envId)) {
		try {
			total += (await stat(runLogPath(envId, id))).size;
		} catch {
			/* raced with cleanup */
		}
	}
	return total;
}

/**
 * Same as usedBytes(), but leaves excludeRunId's own file out of the sum. Used by
 * SizeBudgetTracker to get the size of "everything ELSE IN THIS ENVIRONMENT", so it
 * can add this run's own bytes on top from an in-memory counter instead of
 * re-stat'ing its own file.
 */
export async function usedBytesExcluding(envId: number | null, excludeRunId: string): Promise<number> {
	let total = 0;
	for (const id of await listRunLogIds(envId)) {
		if (id === excludeRunId) continue;
		try {
			total += (await stat(runLogPath(envId, id))).size;
		} catch {
			/* raced with cleanup */
		}
	}
	return total;
}

export async function budgetExceeded(envId: number | null): Promise<boolean> {
	return (await usedBytes(envId)) > BUDGET_BYTES;
}

/**
 * Tracks whether ONE run's output has pushed ITS OWN ENVIRONMENT's deploy-logs/<env>/
 * over BUDGET_BYTES, without doing a full directory scan (readdir + stat every file)
 * on every appended line.
 *
 * Before the scan-avoidance existed, deploy-run-record.ts's line() called
 * budgetExceeded() -- a full usedBytes() scan -- after EVERY line, so a deploy with N
 * output lines against a log directory holding M past runs' files cost O(N*M) stat
 * calls. Measured on this machine: 200 lines against 500 existing log files took
 * ~16.2s (~81ms/line); the same 200 lines with the directory scan removed entirely
 * took ~49ms total. That scan is needed to stay honest about the directory's actual
 * size, so it can't just be dropped -- it can only be done less often.
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
 * F5 fix, ENVIRONMENT scoping: `envId` is threaded into the constructor and passed to
 * every measureOthers() call, so "everything else" means everything else IN THIS
 * RUN'S OWN ENVIRONMENT's directory -- never another environment's files. Before this,
 * `envId` did not exist here at all: every tracker (regardless of which environment
 * its run belonged to) measured the SAME shared deploy-logs/ directory against the
 * SAME BUDGET_BYTES total, so a noisy deploy in one environment could push every other
 * environment's tracker over budget too, truncating runs that never wrote anywhere
 * near BUDGET_BYTES themselves. See deploy-run-record.ts's module doc comment (F5
 * fix) and DeployRunRecorder's envId field for how this is wired end to end.
 *
 * Concurrency: OTHER runs in the SAME environment writing at the same time are
 * invisible between this tracker's refreshes. A second run in the same environment
 * that starts writing right after this one's baseline was measured can add up to its
 * own full output before the next refresh reflects it, so the total this tracker
 * checks against can undercount the real directory size by that much in the
 * meantime. This is an intentional trade-off: BUDGET_BYTES (2 GiB, deliberately
 * generous) exists to catch a filled disk, not to enforce an exact quota -- the
 * design doc calls for aborting "at the end of writing, not truncating mid-line",
 * never for a precise cutoff. The OLD per-line full rescan did not close this gap
 * either: budgetExceeded() reads the directory at the moment it's called, with no
 * locking against another run's concurrent appendRunLog() -- the old code just paid
 * for that same imprecision on every single line instead of once per MiB. This
 * concurrency trade-off is entirely orthogonal to the F5 environment-scoping fix
 * above: it was true before F5 (within the single shared directory) and remains true
 * after F5 (within one environment's own directory) -- F5 changes WHICH directory is
 * measured, not how fresh that measurement is.
 */
export class SizeBudgetTracker {
	/** "Everything else" (every OTHER run's file IN THIS RUN'S OWN ENVIRONMENT), last
	 *  measured by refresh(). NEVER includes this run's own file -- see
	 *  usedBytesExcluding() -- and NEVER includes another environment's files, since
	 *  usedBytesExcluding() only ever reads inside logDir(this.envId). */
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
		/** F5 fix: which environment's directory/budget this tracker measures against.
		 *  Passed straight through to measureOthers() on every refresh() -- see the
		 *  class doc comment. */
		private readonly envId: number | null,
		private readonly runId: string,
		private readonly budgetBytes: number = BUDGET_BYTES,
		/** Test-only seam: lets tests count/replace the directory scan without
		 *  writing real files. Production code never passes this -- it always gets
		 *  the real usedBytesExcluding. */
		private readonly measureOthers: (
			envId: number | null,
			excludeRunId: string
		) => Promise<number> = usedBytesExcluding
	) {}

	private async refresh(): Promise<void> {
		this.cachedOtherBytes = await this.measureOthers(this.envId, this.runId);
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
