/**
 * Tests for runDeployLogReconcileJob() itself -- the database/filesystem-touching glue
 * around planReconcile() (see deploy-log-reconcile.test.ts for the pure decision core).
 *
 * $lib/server/db transitively loads better-sqlite3 (ERR_DLOPEN_FAILED under Bun), so it
 * has to be faked via ../helpers/db-fake (registerDbFake), same as
 * tests/deploy-endpoints.test.ts -- NOT via a separate mock.module('$lib/server/db', ...)
 * call here, see that helper's doc comment for why a second direct call collides.
 *
 * The two deploy-log-store calls are INJECTED (runDeployLogReconcileJob's `deps` param)
 * rather than mock.module()'d. An earlier version did mock the module, reasoning that no
 * other test file claimed it -- but the collision that matters is with SOURCE modules, not
 * test files: mock.module() freezes the export shape process-wide, and deploy-run-record.ts
 * imports appendRunLog/runLogFileName/SizeBudgetTracker from the same specifier. Whether it
 * blew up depended on the order bun walks tests/, so it was green locally and red in CI.
 * Injection has no process-wide effect at all.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { registerDbFake } from './helpers/db-fake';

// -- $lib/server/db: an in-memory schedule_executions fake -----------------

let nextExecId: number;
let executions: Map<number, any>;
let stackDeployRecords: Array<{ id: number; status: string; details: any }>;
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

let fileIds: string[];
let deletedFiles: string[];
let throwOnDelete: Set<string>;

function resetFsState() {
	fileIds = [];
	deletedFiles = [];
	throwOnDelete = new Set();
}
resetFsState();

const storeDeps = {
	listRunLogIds: async () => fileIds,
	deleteRunLog: async (fileId: string) => {
		if (throwOnDelete.has(fileId)) throw new Error(`delete failed for ${fileId}`);
		deletedFiles.push(fileId);
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
		// All three are orphans: no stack_deploy record exists for any of them.
		fileIds = ['a', 'b', 'c'];
		throwOnDelete = new Set(['b']);

		await runDeployLogReconcileJob('manual', storeDeps);

		// The one AFTER the failing element must still have been reached.
		expect(deletedFiles).toEqual(['a', 'c']);

		const exec = ownExecution();
		// Real outcome (2), not the planned one (3) -- the point of Befund 2.
		expect(exec.details.deletedFiles).toBe(2);
		expect(exec.details.failed).toBe(1);
		// A run that hit a per-element failure is not indistinguishable from a clean one.
		expect(exec.status).toBe('warning');
	});

	test('one failing mark does not stop later records from being marked logMissing', async () => {
		// No files on disk at all -- every record below is missing its file.
		fileIds = [];
		stackDeployRecords = [
			{ id: 10, status: 'success', details: null },
			{ id: 11, status: 'success', details: null },
			{ id: 12, status: 'success', details: null }
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
		fileIds = ['a'];
		stackDeployRecords = [{ id: 20, status: 'success', details: null }];
		executions.set(20, { id: 20, status: 'success', details: null });

		await runDeployLogReconcileJob('manual', storeDeps);

		const exec = ownExecution();
		expect(exec.status).toBe('success');
		expect(exec.details.failed).toBe(0);
		// 'a' has no record and gets deleted; the id-20 record has no file and gets marked.
		expect(exec.details.deletedFiles).toBe(1);
		expect(exec.details.markedRecords).toBe(1);
	});
});
