// tests/deploy-run-record.test.ts
/**
 * Exercises the database-touching half of the stack_deploy run record
 * (deploy-run-record.ts) against a faked $lib/server/db -- see
 * tests/helpers/db-fake.ts's doc comment for why a fake is unavoidable under Bun
 * (db.ts transitively loads better-sqlite3, ERR_DLOPEN_FAILED) and why it must be
 * registered through registerDbFake() rather than a second mock.module() call.
 *
 * Deliberately never calls recorder.line(): end() awaits `this.tail`, which is
 * `Promise.resolve()` when line() was never invoked, so these tests never touch
 * deploy-log-store.ts (no real filesystem needed).
 */
import { describe, test, expect } from 'bun:test';
import { registerDbFake } from './helpers/db-fake';

// -- $lib/server/db fake: an in-memory schedule_executions row ------------

let stored: {
	created?: Record<string, unknown>;
	updates: Array<Record<string, unknown>>;
};

function resetDbState() {
	stored = { created: undefined, updates: [] };
}
resetDbState();

registerDbFake('createScheduleExecution', async (data: Record<string, unknown>) => {
	stored.created = data;
	return {
		id: 1,
		...data,
		triggeredAt: new Date().toISOString(),
		startedAt: null,
		completedAt: null,
		duration: null,
		errorMessage: null,
		details: data.details ?? null,
		logs: null,
		createdAt: null
	};
});
registerDbFake('updateScheduleExecution', async (id: number, data: Record<string, unknown>) => {
	stored.updates.push(data);
	return { id, ...data };
});

// Imported AFTER the fakes are registered above -- same ordering constraint
// tests/deploy-endpoints.test.ts documents for $lib/server/db.
const { createRunRecorder } = await import('../src/lib/server/deploy-run-record');

/** The db-fake update() call that closed the row (status !== 'running'), i.e. the
 *  one written by end(), as opposed to createRunRecorder's own startedAt update. */
function endUpdate() {
	return stored.updates.find((u) => u.status !== undefined);
}

describe('DeployRunRecorder.end() -- secret redaction of the stored error text', () => {
	// A known, invented value that can't coincidentally appear in a timestamp or id.
	const SECRET = 'zzz-kanarienvogel-4711';

	test('a failed run whose error text carries a known secret does NOT store that secret', async () => {
		resetDbState();
		const recorder = await createRunRecorder({
			stackName: 'demo',
			envId: null,
			triggeredBy: 'manual',
			options: { pull: false, build: false, forceRecreate: false },
			composeHash: 'aaa',
			envHash: 'bbb',
			secrets: [SECRET]
		});

		await recorder.end(false, undefined, `compose up failed: DB_PASSWORD=${SECRET} rejected`);

		const update = endUpdate();
		expect(update?.status).toBe('failed');
		expect(String(update?.errorMessage)).not.toContain(SECRET);
		expect(JSON.stringify(update?.details)).not.toContain(SECRET);
	});


	test('status is "failed" and NOT the redacted-line placeholder itself', async () => {
		resetDbState();
		const recorder = await createRunRecorder({
			stackName: 'demo',
			envId: null,
			triggeredBy: 'manual',
			options: { pull: false, build: false, forceRecreate: false },
			composeHash: 'aaa',
			envHash: 'bbb',
			secrets: [SECRET]
		});

		await recorder.end(false, undefined, `boom: ${SECRET}`);

		const update = endUpdate();
		expect(update?.status).toBe('failed');
		// Asserting presence of the placeholder alone would stay green even if no
		// secret had ever been in the line (test-coverage-pflicht.md's warning about
		// "enthaelt ***" tests) -- so this only checks the redacted text is safe to
		// store, not that a placeholder specifically appears.
		expect(String(update?.errorMessage)).toContain('***');
	});

	test('a successful run stores errorMessage: null regardless of secrets', async () => {
		resetDbState();
		const recorder = await createRunRecorder({
			stackName: 'demo',
			envId: null,
			triggeredBy: 'manual',
			options: { pull: false, build: false, forceRecreate: false },
			composeHash: 'aaa',
			envHash: 'bbb',
			secrets: [SECRET]
		});

		await recorder.end(true);

		const update = endUpdate();
		expect(update?.status).toBe('success');
		expect(update?.errorMessage).toBeNull();
	});

	// redactLine() withholds the WHOLE line (returns null) when a too-short secret
	// value appears, rather than risk replacing an unrelated substring. The run must
	// still close as "failed" -- a run stuck as "running" forever is worse than a
	// run with a generic message.
	test('when redaction withholds the whole line, the run still ends "failed" with a safe, non-null message', async () => {
		resetDbState();
		const shortSecret = 'ab12cd'; // < MIN_REPLACEABLE_LENGTH (8) in secret-redaction.ts
		const recorder = await createRunRecorder({
			stackName: 'demo',
			envId: null,
			triggeredBy: 'manual',
			options: { pull: false, build: false, forceRecreate: false },
			composeHash: 'aaa',
			envHash: 'bbb',
			secrets: [shortSecret]
		});

		await recorder.end(false, undefined, `token ${shortSecret} invalid`);

		const update = endUpdate();
		expect(update?.status).toBe('failed');
		expect(update?.errorMessage).not.toBeNull();
		expect(String(update?.errorMessage)).not.toContain(shortSecret);
	});

	test('an error with no secrets configured is stored unchanged (no false positives)', async () => {
		resetDbState();
		const recorder = await createRunRecorder({
			stackName: 'demo',
			envId: null,
			triggeredBy: 'manual',
			options: { pull: false, build: false, forceRecreate: false },
			composeHash: 'aaa',
			envHash: 'bbb',
			secrets: []
		});

		await recorder.end(false, undefined, 'exit code 1');

		const update = endUpdate();
		expect(update?.errorMessage).toBe('exit code 1');
	});
});

// F4 fix: deployStack() resolves a bound secret provider's values (Bitwarden/
// 1Password/etc. bulk pulls or inline refs) INTERNALLY, strictly after a caller
// (a route, or deployGitStack in git.ts) already built its recorder from the
// DB-only vars it had at construction time. addSecrets() is how the caller feeds
// those later-known values in before end() redacts the stored error text.
describe('DeployRunRecorder.addSecrets() -- provider-resolved secrets added AFTER construction', () => {
	const LATE_SECRET = 'zzz-spaetzuendung-9000';

	test('a secret added via addSecrets() after construction (with an EMPTY construction-time list) is still redacted from the stored error', async () => {
		resetDbState();
		const recorder = await createRunRecorder({
			stackName: 'demo',
			envId: null,
			triggeredBy: 'manual',
			options: { pull: false, build: false, forceRecreate: false },
			composeHash: 'aaa',
			envHash: 'bbb',
			// Mirrors the route's construction-time list BEFORE deployStack() resolves
			// provider secrets -- this is the F4 bug's exact starting condition.
			secrets: []
		});

		recorder.addSecrets([LATE_SECRET]);

		await recorder.end(false, undefined, `compose up failed: PROVIDER_TOKEN=${LATE_SECRET} rejected`);

		const update = endUpdate();
		expect(update?.status).toBe('failed');
		expect(String(update?.errorMessage)).not.toContain(LATE_SECRET);
		expect(String(update?.errorMessage)).toContain('***');
	});

	test('addSecrets() ADDS to, rather than replaces, secrets already known at construction', async () => {
		resetDbState();
		const CONSTRUCTION_SECRET = 'yyy-bekannt-von-anfang-an';
		const recorder = await createRunRecorder({
			stackName: 'demo',
			envId: null,
			triggeredBy: 'manual',
			options: { pull: false, build: false, forceRecreate: false },
			composeHash: 'aaa',
			envHash: 'bbb',
			secrets: [CONSTRUCTION_SECRET]
		});

		recorder.addSecrets([LATE_SECRET]);

		await recorder.end(
			false,
			undefined,
			`compose up failed: A=${CONSTRUCTION_SECRET} B=${LATE_SECRET} rejected`
		);

		const update = endUpdate();
		expect(String(update?.errorMessage)).not.toContain(CONSTRUCTION_SECRET);
		expect(String(update?.errorMessage)).not.toContain(LATE_SECRET);
	});

	test('calling addSecrets() with an empty array changes nothing (the common case: deployStack() failed before resolving any provider secrets)', async () => {
		resetDbState();
		const recorder = await createRunRecorder({
			stackName: 'demo',
			envId: null,
			triggeredBy: 'manual',
			options: { pull: false, build: false, forceRecreate: false },
			composeHash: 'aaa',
			envHash: 'bbb',
			secrets: []
		});

		recorder.addSecrets([]);

		await recorder.end(false, undefined, 'exit code 1');

		const update = endUpdate();
		expect(update?.errorMessage).toBe('exit code 1');
	});
});

// ---------------------------------------------------------------------------
// DeployRunRecorder.line() -- the size-budget path (SizeBudgetTracker,
// deploy-log-store.ts). Unlike every test above, THIS block deliberately DOES
// call line() and DOES touch the real filesystem (via appendRunLog) -- it is
// the exception to this file's opening doc comment, and exists specifically
// to prove the budget still triggers truncation after replacing the old
// per-line full-directory-scan with SizeBudgetTracker's cached/incremental
// check. A tiny injected SizeBudgetTracker (see DeployRunRecorder's
// constructor) stands in for BUDGET_BYTES (2 GiB in production) -- nothing
// here writes gigabytes of data to prove the same code path.
// ---------------------------------------------------------------------------
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach } from 'bun:test';
import { SizeBudgetTracker } from '../src/lib/server/deploy-log-store';

const previousDataDirForLineTests = process.env.DATA_DIR;
let lineTestsScratchDir: string;

beforeEach(async () => {
	lineTestsScratchDir = await mkdtemp(join(tmpdir(), 'deploy-run-record-'));
	process.env.DATA_DIR = lineTestsScratchDir;
});
afterEach(async () => {
	if (previousDataDirForLineTests === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = previousDataDirForLineTests;
	await rm(lineTestsScratchDir, { recursive: true, force: true });
});

describe('DeployRunRecorder.line() -- size-budget truncation', () => {
	test('a run whose output crosses a tiny injected budget ends up truncated: true', async () => {
		resetDbState();
		const { DeployRunRecorder } = await import('../src/lib/server/deploy-run-record');
		// 50 B budget -- five ~11 B lines ("line-N\n") cross it comfortably without
		// waiting on anything close to the real 2 GiB BUDGET_BYTES.
		const tinyBudget = new SizeBudgetTracker(null, '1', 50);
		const recorder = new DeployRunRecorder(
			1,
			Date.now(),
			{
				options: { pull: false, build: false, forceRecreate: false },
				composeHash: 'aaa',
				envHash: 'bbb',
				secrets: [],
				envId: null
			},
			tinyBudget
		);

		for (let i = 0; i < 10; i++) {
			recorder.line(`line-${i}`);
		}
		await recorder.end(true);

		const update = endUpdate();
		expect((update?.details as Record<string, unknown> | undefined)?.truncated).toBe(true);
	});

	// Gegenversuch counterpart to the test above, and the "doesn't trigger too
	// early" half of the requirement: a run whose total output stays under the
	// budget must NOT be marked truncated.
	test('a run whose output stays under the injected budget ends up truncated: false', async () => {
		resetDbState();
		const { DeployRunRecorder } = await import('../src/lib/server/deploy-run-record');
		const generousBudget = new SizeBudgetTracker(null, '2', 1_000_000);
		const recorder = new DeployRunRecorder(
			2,
			Date.now(),
			{
				options: { pull: false, build: false, forceRecreate: false },
				composeHash: 'aaa',
				envHash: 'bbb',
				secrets: [],
				envId: null
			},
			generousBudget
		);

		for (let i = 0; i < 10; i++) {
			recorder.line(`line-${i}`);
		}
		await recorder.end(true);

		const update = endUpdate();
		// buildRunDetails() only puts `truncated` in the object when it's true (see
		// deploy-run-record-core.ts) -- so "not truncated" is undefined, not false.
		expect((update?.details as Record<string, unknown> | undefined)?.truncated).toBeUndefined();
	});

	test('once truncated, further line() calls stop appending -- the truncation notice is the last thing written', async () => {
		resetDbState();
		const { readRunLog } = await import('../src/lib/server/deploy-log-store');
		const { DeployRunRecorder } = await import('../src/lib/server/deploy-run-record');
		const tinyBudget = new SizeBudgetTracker(null, '3', 20); // crosses after ~2 lines
		const recorder = new DeployRunRecorder(
			3,
			Date.now(),
			{
				options: { pull: false, build: false, forceRecreate: false },
				composeHash: 'aaa',
				envHash: 'bbb',
				secrets: [],
				envId: null
			},
			tinyBudget
		);

		for (let i = 0; i < 20; i++) {
			recorder.line(`this-line-should-not-all-land-${i}`);
		}
		await recorder.end(true);

		const log = await readRunLog(null, '3');
		expect(log).not.toBeNull();
		expect(log).toContain('[deploy log truncated: size budget exceeded]');
		// Not every one of the 20 lines can have landed -- otherwise truncation
		// never actually stopped anything, it just decorated a full log.
		expect((log ?? '').split('\n').length).toBeLessThan(22);
	});
});

// ---------------------------------------------------------------------------
// F5 fix: DeployRunRecorder threads its envId through to BOTH the log file's
// on-disk path AND its SizeBudgetTracker's default construction -- proven
// end to end here, without injecting a custom SizeBudgetTracker (so this
// exercises DeployRunRecorder's OWN `new SizeBudgetTracker(this.envId, ...)`
// default, not a test double standing in for it).
// ---------------------------------------------------------------------------

describe('DeployRunRecorder -- envId threading to the log file path (F5)', () => {
	test('two runs in DIFFERENT environments write to two DIFFERENT log files, never colliding even with the same executionId space', async () => {
		resetDbState();
		const { readRunLog, runLogPath } = await import('../src/lib/server/deploy-log-store');
		const { DeployRunRecorder } = await import('../src/lib/server/deploy-run-record');

		const recorderA = new DeployRunRecorder(4001, Date.now(), {
			options: { pull: false, build: false, forceRecreate: false },
			composeHash: 'aaa',
			envHash: 'bbb',
			secrets: [],
			envId: 1
		});
		const recorderB = new DeployRunRecorder(4002, Date.now(), {
			options: { pull: false, build: false, forceRecreate: false },
			composeHash: 'aaa',
			envHash: 'bbb',
			secrets: [],
			envId: 2
		});

		recorderA.line('environment 1 output');
		recorderB.line('environment 2 output');
		await recorderA.end(true);
		await recorderB.end(true);

		expect(await readRunLog(1, '4001')).toContain('environment 1 output');
		expect(await readRunLog(2, '4002')).toContain('environment 2 output');
		// Not merely different content -- genuinely different files on disk.
		expect(runLogPath(1, '4001')).not.toBe(runLogPath(2, '4002'));
	});

	// THE end-to-end counterpart to the pure SizeBudgetTracker-level regression
	// test in deploy-log-store.test.ts: environment A's run is deliberately
	// pushed PAST its own size budget and truncated. Environment B's run, with
	// the SAME budget and an unrelated one-line output, must NOT be affected --
	// proving DeployRunRecorder.line()'s real truncation path (appendRunLog +
	// SizeBudgetTracker.recordAppend together, not either in isolation) is
	// scoped per environment, exactly as task-lead described: "filling A's
	// budget does NOT truncate B's run".
	test('truncating environment A\'s run does not truncate environment B\'s unrelated run, even with the same tiny budget', async () => {
		resetDbState();
		const { readRunLog } = await import('../src/lib/server/deploy-log-store');
		const { DeployRunRecorder } = await import('../src/lib/server/deploy-run-record');

		const budgetA = new SizeBudgetTracker(1, '4101', 50);
		const budgetB = new SizeBudgetTracker(2, '4102', 50);

		const recorderA = new DeployRunRecorder(
			4101,
			Date.now(),
			{
				options: { pull: false, build: false, forceRecreate: false },
				composeHash: 'aaa',
				envHash: 'bbb',
				secrets: [],
				envId: 1
			},
			budgetA
		);
		const recorderB = new DeployRunRecorder(
			4102,
			Date.now(),
			{
				options: { pull: false, build: false, forceRecreate: false },
				composeHash: 'aaa',
				envHash: 'bbb',
				secrets: [],
				envId: 2
			},
			budgetB
		);

		// Environment A runs to completion FIRST and fully lands on disk (including
		// its truncation notice) before environment B writes a single byte -- this
		// removes any ambiguity about interleaving between the two recorders'
		// independent async append chains, so a failure below can only mean B's
		// directory scan actually saw A's bytes, not a timing accident.
		for (let i = 0; i < 10; i++) {
			recorderA.line(`line-${i}`);
		}
		await recorderA.end(true);

		// Environment B: ONE short line, nowhere near 50 B on its own, written
		// strictly AFTER environment A has already exceeded its own budget.
		recorderB.line('untouched');
		await recorderB.end(true);

		const logA = await readRunLog(1, '4101');
		const logB = await readRunLog(2, '4102');

		expect(logA).toContain('[deploy log truncated: size budget exceeded]');
		// Environment B's single line survives completely, with no truncation
		// notice -- it was never anywhere near ITS OWN 50 B budget, and
		// environment A's bytes (in a DIFFERENT directory) never counted
		// against it.
		expect(logB).toBe('untouched\n');
	});
});
