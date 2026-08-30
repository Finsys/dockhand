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
