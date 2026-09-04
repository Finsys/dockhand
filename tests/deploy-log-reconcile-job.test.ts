/**
 * Tests for runDeployLogReconcileJob() itself -- the database/filesystem-touching glue
 * around planReconcile() (see deploy-log-reconcile.test.ts for the pure decision core).
 *
 * $lib/server/db transitively loads better-sqlite3 (ERR_DLOPEN_FAILED under Bun), so it
 * has to be faked via ../helpers/db-fake (registerDbFake), same as
 * tests/deploy-endpoints.test.ts -- NOT via a separate mock.module('$lib/server/db', ...)
 * call here, see that helper's doc comment for why a second direct call collides.
 *
 * The three deploy-log-store calls are INJECTED (runDeployLogReconcileJob's `deps` param)
 * rather than mock.module()'d. An earlier version did mock the module, reasoning that no
 * other test file claimed it -- but the collision that matters is with SOURCE modules, not
 * test files: mock.module() freezes the export shape process-wide, and deploy-run-record.ts
 * imports appendRunLog/runLogFileName/SizeBudgetTracker from the same specifier. Whether it
 * blew up depended on the order bun walks tests/, so it was green locally and red in CI.
 * Injection has no process-wide effect at all.
 *
 * F5 fix: the fake filesystem layer below is keyed PER ENVIRONMENT (envDirName(envId) ->
 * fileIds[]), mirroring deploy-log-store.ts's real per-environment directories -- this is
 * what lets the tests below prove the reconcile job never mixes one environment's files
 * with another's, even when two environments happen to hold a file with the exact same
 * numeric run id (envDirName/parseEnvDirName are imported for real -- pure functions, no
 * filesystem -- purely to build the fake's keys the same way production code would).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { registerDbFake } from './helpers/db-fake';
import { envDirName } from '../src/lib/server/deploy-log-store';

// -- $lib/server/db: an in-memory schedule_executions fake -----------------

let nextExecId: number;
let executions: Map<number, any>;
let stackDeployRecords: Array<{ id: number; status: string; details: any; environmentId: number | null }>;
let throwOnUpdate: Set<number>;

function resetDbState() {
	nextExecId = 1;
	executions = new Map();
	stackDeployRecords = [];
	throwOnUpdate = new Set();
}
resetDbState();

registerDbFake('getDeployLogReconcileEnabled', async () => true);
registerDbFake('getScheduleExecutionIdsByType', async (scheduleType: string) =>
	scheduleType === 'stack_deploy' ? stackDeployRecords : []
);
registerDbFake('createScheduleExecution', async (data: any) => {
	const id = nextExecId++;
	const row = { id, ...data, details: data.details ?? null };
	executions.set(id, row);
	return row;
});
registerDbFake('updateScheduleExecution', async (id: number, data: any) => {
	if (throwOnUpdate.has(id)) throw new Error(`update failed for record ${id}`);
	const row = executions.get(id) ?? { id };
	const updated = { ...row, ...data };
	executions.set(id, updated);
	return updated;
});
registerDbFake('appendScheduleExecutionLog', async () => {});

// -- $lib/server/deploy-log-store: fully replaced (no other file mocks it) -
//
// Keyed by envDirName(envId) -> fileIds[], the same per-environment shape
// deploy-log-store.ts's real listRunLogIds()/deleteRunLog() work against (F5 fix).

let filesByEnvKey: Map<string, string[]>;
let deletedFiles: Array<{ envId: number | null; id: string }>;
let throwOnDeleteKeys: Set<string>; // `${envDirName(envId)}:${fileId}`

function resetFsState() {
	filesByEnvKey = new Map();
	deletedFiles = [];
	throwOnDeleteKeys = new Set();
}
resetFsState();

const storeDeps = {
	listEnvDirNames: async () => [...filesByEnvKey.keys()],
	listRunLogIds: async (envId: number | null) => filesByEnvKey.get(envDirName(envId)) ?? [],
	deleteRunLog: async (envId: number | null, fileId: string) => {
		const key = `${envDirName(envId)}:${fileId}`;
		if (throwOnDeleteKeys.has(key)) throw new Error(`delete failed for ${key}`);
		deletedFiles.push({ envId, id: fileId });
	}
};

// runDeployLogReconcileJob is imported AFTER both mocks are registered above, so its own
// import of '../../db' / '../../deploy-log-store' resolves to the faked module records.
const { runDeployLogReconcileJob } = await import('../src/lib/server/scheduler/tasks/deploy-log-reconcile');

beforeEach(() => {
	resetDbState();
	resetFsState();
});

/** The reconcile job's own execution row -- the one created inside runDeployLogReconcileJob. */
function ownExecution(): any {
	return [...executions.values()].find((e) => e.scheduleType === 'deploy_log_reconcile');
}

describe('runDeployLogReconcileJob', () => {
	test('one failing delete does not stop later orphan files from being removed', async () => {
		// All three are orphans: no stack_deploy record exists for any of them, all
		// in the SAME (null) environment.
		filesByEnvKey.set(envDirName(null), ['a', 'b', 'c']);
		throwOnDeleteKeys = new Set([`${envDirName(null)}:b`]);

		await runDeployLogReconcileJob('manual', storeDeps);

		// The one AFTER the failing element must still have been reached.
		expect(deletedFiles).toEqual([
			{ envId: null, id: 'a' },
			{ envId: null, id: 'c' }
		]);

		const exec = ownExecution();
		// Real outcome (2), not the planned one (3) -- the point of Befund 2.
		expect(exec.details.deletedFiles).toBe(2);
		expect(exec.details.failed).toBe(1);
		// A run that hit a per-element failure is not indistinguishable from a clean one.
		expect(exec.status).toBe('warning');
	});

	test('one failing mark does not stop later records from being marked logMissing', async () => {
		// No files on disk at all -- every record below is missing its file.
		stackDeployRecords = [
			{ id: 10, status: 'success', details: null, environmentId: null },
			{ id: 11, status: 'success', details: null, environmentId: null },
			{ id: 12, status: 'success', details: null, environmentId: null }
		];
		for (const r of stackDeployRecords) executions.set(r.id, { ...r });
		throwOnUpdate = new Set([11]);

		await runDeployLogReconcileJob('manual', storeDeps);

		expect(executions.get(10).details.logMissing).toBe(true);
		expect(executions.get(12).details.logMissing).toBe(true);
		// The failing record's details were never reached, so they stay as seeded.
		expect(executions.get(11).details).toBe(null);

		const exec = ownExecution();
		expect(exec.details.markedRecords).toBe(2);
		expect(exec.details.failed).toBe(1);
		expect(exec.status).toBe('warning');
	});

	test('a clean run with nothing to fail is reported as success, not warning', async () => {
		filesByEnvKey.set(envDirName(null), ['a']);
		stackDeployRecords = [{ id: 20, status: 'success', details: null, environmentId: null }];
		executions.set(20, { id: 20, status: 'success', details: null });

		await runDeployLogReconcileJob('manual', storeDeps);

		const exec = ownExecution();
		expect(exec.status).toBe('success');
		expect(exec.details.failed).toBe(0);
		// 'a' has no record and gets deleted; the id-20 record has no file and gets marked.
		expect(exec.details.deletedFiles).toBe(1);
		expect(exec.details.markedRecords).toBe(1);
	});

	// -------------------------------------------------------------------------
	// F5 fix: per-environment reconciliation. THE cross-environment isolation
	// tests -- every id below is deliberately reused ACROSS environments to
	// prove the reconcile job never confuses one environment's file/record with
	// another's just because they share a run id.
	// -------------------------------------------------------------------------

	test("env A's orphan cleanup never deletes env B's file, even when they share a run id and env B's file legitimately belongs to a record", async () => {
		filesByEnvKey.set(envDirName(1), ['42']); // orphan in env 1: no record anywhere for id 42 in env 1
		filesByEnvKey.set(envDirName(2), ['42']); // env 2's OWN file for its OWN record with the same numeric id
		stackDeployRecords = [{ id: 42, status: 'success', details: null, environmentId: 2 }];
		executions.set(42, { id: 42, status: 'success', details: null });

		await runDeployLogReconcileJob('manual', storeDeps);

		// Env 1's orphan is deleted...
		expect(deletedFiles).toEqual([{ envId: 1, id: '42' }]);
		// ...but env 2's file, which legitimately belongs to record 42, is NOT
		// treated as missing (it has a matching file in ITS OWN environment) and
		// is never touched by the delete pass either.
		expect(executions.get(42).details).toBeNull();
	});

	test('an orphan file living under one environment is never confused with a DIFFERENT environment holding the same run id', async () => {
		// Both environments have a file with the SAME id and NEITHER has any record
		// at all -- both are genuinely orphans, each in its own right.
		filesByEnvKey.set(envDirName(1), ['shared-id']);
		filesByEnvKey.set(envDirName(2), ['shared-id']);
		stackDeployRecords = [];

		await runDeployLogReconcileJob('manual', storeDeps);

		expect(deletedFiles).toContainEqual({ envId: 1, id: 'shared-id' });
		expect(deletedFiles).toContainEqual({ envId: 2, id: 'shared-id' });
		expect(deletedFiles).toHaveLength(2);
	});

	test("a record's own file, missing from its OWN environment, is correctly marked logMissing even when an unrelated environment holds a same-numbered file", async () => {
		// Record id 501 deliberately avoids id 1 -- this fake's createScheduleExecution
		// always assigns the reconcile job's OWN execution row id 1 first (nextExecId
		// starts at 1 every test), which would otherwise clobber a manually seeded
		// `executions.set(1, ...)` entry for an unrelated stack_deploy record.
		filesByEnvKey.set(envDirName(2), ['501']); // orphan file living in env 2, wrong environment for record id 501
		stackDeployRecords = [{ id: 501, status: 'success', details: null, environmentId: 1 }];
		executions.set(501, { id: 501, status: 'success', details: null });

		await runDeployLogReconcileJob('manual', storeDeps);

		// The record belongs to env 1, which has NO file -- correctly marked
		// missing, not "found" via env 2's unrelated same-numbered file.
		expect(executions.get(501).details.logMissing).toBe(true);
		// Env 2's file has no record in env 2 either -- it is correctly deleted as
		// its OWN environment's orphan, not because it was mistaken for record 501's.
		expect(deletedFiles).toEqual([{ envId: 2, id: '501' }]);
	});

	test('a still-running record in one environment is not marked missing, while a DIFFERENT environment\'s terminal record with the same id correctly is', async () => {
		// No files anywhere -- both records are "missing their file" by definition,
		// but only the terminal one should actually be marked.
		stackDeployRecords = [
			{ id: 5, status: 'running', details: null, environmentId: 1 },
			{ id: 5, status: 'success', details: null, environmentId: 2 }
		];
		executions.set(5, { id: 5, status: 'running', details: null }); // last-write-wins in this fake, matches env 2's terminal status for the assertion below

		await runDeployLogReconcileJob('manual', storeDeps);

		const exec = ownExecution();
		// One skipped (still running, env 1), one marked (terminal, env 2).
		expect(exec.details.skippedInProgress).toBe(1);
		expect(exec.details.markedRecords).toBe(1);
	});

	test('an environment that only has a directory on disk (no records at all, e.g. a deleted environment) still has its orphan files reconciled', async () => {
		filesByEnvKey.set(envDirName(7), ['old-run']);
		stackDeployRecords = []; // environment 7 has no records in the database at all

		await runDeployLogReconcileJob('manual', storeDeps);

		expect(deletedFiles).toEqual([{ envId: 7, id: 'old-run' }]);
	});

	test('an environment that only has a record (no directory on disk yet) still gets that record considered for markMissing', async () => {
		// listEnvDirNames() would never discover environment 3 on its own -- it has
		// no directory at all -- so the record-side union is what makes this work.
		stackDeployRecords = [{ id: 99, status: 'success', details: null, environmentId: 3 }];
		executions.set(99, { id: 99, status: 'success', details: null });

		await runDeployLogReconcileJob('manual', storeDeps);

		expect(executions.get(99).details.logMissing).toBe(true);
	});
});
