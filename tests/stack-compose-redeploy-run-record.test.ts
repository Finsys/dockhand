/**
 * Task 21: `PUT /api/stacks/[name]/compose` (Save & redeploy) must produce the same
 * stack_deploy schedule_executions row + log file the dedicated deploy endpoint
 * (deploy/+server.ts, Task 10 / deploy-run-record.ts) already produces.
 *
 * Before this task, restart:true saved the compose file and redeployed WITHOUT ever
 * building a run recorder: the deploy ran, but afterwards no row and no log file
 * existed. Found live against the running test instance (task-21-brief.md), not by a
 * failing test -- deploy-stack-online.test.ts's own doc comment already notes routes
 * silently ship without wiring like this, invisibly, because nothing fails when it's
 * missing.
 *
 * This calls the route's PUT handler DIRECTLY (composeRoute.PUT), never through any
 * router/dispatch layer -- so "this test accidentally exercises the deploy endpoint
 * instead" is structurally impossible; the object under test IS this file's export.
 * What every "row created" assertion is instead paired with is a restart:false
 * counterpart proving the SAME fakes yield ZERO rows when there is no deploy -- so a
 * spurious pass can't hide behind lenient fakes that always produce a row regardless
 * of what was actually requested.
 *
 * $lib/server/db and $lib/server/authorize are faked via the shared helpers -- see
 * their doc comments for why a second direct mock.module() call for either would
 * collide with tests/deploy-endpoints.test.ts, which already owns both specifiers for
 * this process (mock.module() replaces a module's exports WHOLESALE for the entire
 * test run, and Bun freezes the exported shape at first resolution).
 *
 * $lib/server/stacks is faked via tests/helpers/stacks-fake.ts, the same shared,
 * collision-safe registration point db-fake.ts/authorize-fake.ts already use for
 * their specifiers -- like db.ts it pulls in better-sqlite3 (ERR_DLOPEN_FAILED under
 * Bun), so it can't be imported for real here either. This used to be a direct
 * mock.module() call in this file; it moved into the shared helper once a second
 * file (tests/git-stack-deploy-run-record.test.ts) needed to fake $lib/server/stacks
 * too -- exactly the situation this doc comment originally predicted.
 *
 * The dedicated deploy endpoint (deploy/+server.ts) is deliberately NOT imported here
 * to double-check its own recording: it additionally pulls in $lib/server/audit ->
 * $lib/server/license -> $lib/server/notifications/index.ts, none of which this task
 * touches, and faking that whole chain just to re-prove an unrelated route wasn't
 * broken would be its own maintenance burden. The "still records exactly once, not
 * two" check for that route is done at the SOURCE level instead, at the bottom of this
 * file -- deploy/+server.ts is untouched by this task's diff, so a source-level guard
 * is sufficient evidence, not a shortcut.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerDbFake } from './helpers/db-fake';
import { registerAuthorizeFake } from './helpers/authorize-fake';
import { registerStacksFake } from './helpers/stacks-fake';

const here = dirname(fileURLToPath(import.meta.url));

// -- $lib/server/authorize: always permitted (auth disabled) ----------------

registerAuthorizeFake(async () => ({
	authEnabled: false,
	isAuthenticated: true,
	isEnterprise: false,
	can: async () => true,
	canAccessEnvironment: async () => true
}));

// -- $lib/server/db: an in-memory schedule_executions fake -------------------

let created: Array<Record<string, unknown>>;
let updates: Array<Record<string, unknown>>;
let nextId: number;

function resetDbState() {
	created = [];
	updates = [];
	nextId = 1;
}
resetDbState();

registerDbFake('createScheduleExecution', async (data: Record<string, unknown>) => {
	const row = {
		id: nextId++,
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
	created.push(row);
	return row;
});
registerDbFake('updateScheduleExecution', async (id: number, data: Record<string, unknown>) => {
	updates.push({ id, ...data });
	return { id, ...data };
});

/** The update() call that CLOSED the row (status !== 'running'), i.e. the one written
 *  by DeployRunRecorder.end() -- as opposed to createRunRecorder's own startedAt
 *  update. Same helper shape as tests/deploy-run-record.test.ts's endUpdate(). */
function endUpdate() {
	return updates.find((u) => u.status !== undefined);
}

// -- Real deploy-log-store against a throwaway DATA_DIR ----------------------
//
// DATA_DIR is process-global and read at call time by every other test file too
// (tests/fs-guard.test.ts's doc comment, referenced by tests/deploy-endpoints.test.ts)
// -- save and restore the prior value so this file leaves no trace once it finishes.

const previousDataDir = process.env.DATA_DIR;
let dataDir: string;
beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'dv-t21-deploy-logs-'));
	process.env.DATA_DIR = dataDir;
});
afterAll(async () => {
	await rm(dataDir, { recursive: true, force: true });
	if (previousDataDir === undefined) {
		delete process.env.DATA_DIR;
	} else {
		process.env.DATA_DIR = previousDataDir;
	}
});

const { readRunLog, deleteRunLog } = await import('../src/lib/server/deploy-log-store');
const { hashComposeContent, hashEnvFingerprint } = await import('../src/lib/server/deploy-run-record-core');

// -- $lib/server/stacks: mocked WHOLESALE ------------------------------------

let saveCalls: Array<{ name: string; content: string; envId: number | null | undefined }>;
let requireComposeResult: Record<string, unknown>;
let deployStackCalls: Array<{ onLine?: (line: string) => void }>;
let deployStackResult: { success: boolean; output?: string; error?: string };
let deployStackOnLines: string[];

function resetStacksState() {
	saveCalls = [];
	deployStackCalls = [];
	deployStackResult = { success: true, output: 'deployed' };
	deployStackOnLines = ['Container demo-stack-app-1  Started'];
	requireComposeResult = {
		success: true,
		content: 'services:\n  app:\n    image: demo:1\n',
		nonSecretVars: { PUBLIC_VAR: 'v1' },
		secretVars: { DB_PASSWORD: 's3cr3t-value' },
		stackDir: '/tmp/demo-stack',
		composePath: '/tmp/demo-stack/compose.yaml',
		envPath: '/tmp/demo-stack/.env',
		sourceType: 'internal'
	};
}
resetStacksState();

registerStacksFake('getStackComposeFile', async () => {
	throw new Error('getStackComposeFile: not exercised here -- only the GET handler uses it, this suite only calls PUT');
});
registerStacksFake('saveStackComposeFile', async (name: string, content: string, _create: boolean, envId?: number | null) => {
	saveCalls.push({ name, content, envId });
	return { success: true };
});
registerStacksFake('requireComposeFile', async (_name: string, _envId?: number | null) => requireComposeResult);
registerStacksFake('deployStack', async (options: { onLine?: (line: string) => void }) => {
	deployStackCalls.push(options);
	for (const line of deployStackOnLines) options.onLine?.(line);
	return deployStackResult;
});

// -- Route under test, imported AFTER all the fakes above are registered ----

const composeRoute = await import('../src/routes/api/stacks/[name]/compose/+server');

// -- Fixtures ------------------------------------------------------------------

const STACK = 'demo-stack';

/** `Accept: application/json` forces createJobResponse's synchronous JSON path
 *  (sse-parser.ts prefersJSON()), so the returned Response only resolves once the
 *  whole operation -- deploy AND recorder.end() -- has actually finished. Without it
 *  the "fire and forget" path would return {jobId} before the row closes, and every
 *  assertion below would race the background completion. */
function makeComposeEvent(body: Record<string, unknown>) {
	const request = new Request('http://x/', {
		method: 'PUT',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(body)
	});
	return {
		params: { name: STACK },
		request,
		url: new URL('http://x/'),
		cookies: { get: () => undefined } as any
	} as any;
}

beforeEach(async () => {
	resetDbState();
	resetStacksState();
	// nextId always restarts at 1 above, so every test's (at most one) row reuses
	// runId '1' -- clear its log file so tests don't leak content into each other via
	// the shared DATA_DIR (same precaution tests/deploy-endpoints.test.ts documents).
	await deleteRunLog('1');
});

describe('PUT /api/stacks/[name]/compose -- restart:true (Save & redeploy)', () => {
	test('creates exactly one stack_deploy schedule_executions row, closed as success, with a readable log', async () => {
		const content = 'services:\n  app:\n    image: demo:2\n';

		const res = await composeRoute.PUT(makeComposeEvent({ content, restart: true }));
		expect(res.status).toBe(200);
		expect((await res.json()).success).toBe(true);

		expect(created).toHaveLength(1);
		expect(created[0].scheduleType).toBe('stack_deploy');
		expect(created[0].scheduleId).toBe(0);
		expect(created[0].entityName).toBe(STACK);
		expect(created[0].triggeredBy).toBe('manual');

		const update = endUpdate();
		expect(update?.status).toBe('success');
		expect(update?.errorMessage).toBeNull();

		const runId = String(created[0].id);
		const log = await readRunLog(runId);
		expect(log).toContain('Container demo-stack-app-1  Started');
	});

	test('composeHash is derived from the just-SUBMITTED content, not from requireComposeFile()\'s (possibly stale) content', async () => {
		const submitted = 'services:\n  app:\n    image: demo:3\n';
		// Deliberately different from `submitted` -- if the route ever hashed
		// composeInfo.content instead of the request body's `content`, this test
		// would catch it: the stored hash would match THIS string, not `submitted`.
		requireComposeResult = { ...requireComposeResult, content: 'STALE-CONTENT-NEVER-HASHED' };

		// Draining the body (.json()) is required, not cosmetic: createJobResponse's JSON
		// path only finishes recorder.end() inside the ReadableStream's start(), which
		// only runs to completion once the stream is actually consumed.
		await (await composeRoute.PUT(makeComposeEvent({ content: submitted, restart: true }))).json();

		const update = endUpdate();
		const details = update?.details as { composeHash: string };
		expect(details.composeHash).toBe(hashComposeContent(submitted));
		expect(details.composeHash).not.toBe(hashComposeContent('STALE-CONTENT-NEVER-HASHED'));
	});

	test('envHash covers the MERGE of non-secret and secret vars, same shape deploy/+server.ts already uses', async () => {
		await (await composeRoute.PUT(makeComposeEvent({ content: 'x', restart: true }))).json();

		const update = endUpdate();
		const details = update?.details as { envHash: string };
		const expected = hashEnvFingerprint({ PUBLIC_VAR: 'v1', DB_PASSWORD: 's3cr3t-value' });
		expect(details.envHash).toBe(expected);
	});

	test('a secret value in the deploy error text is redacted before it is stored (the envHash-covered vars double as the redaction list)', async () => {
		deployStackResult = { success: false, error: 'compose up failed: DB_PASSWORD=s3cr3t-value rejected' };
		deployStackOnLines = [];

		await (await composeRoute.PUT(makeComposeEvent({ content: 'x', restart: true }))).json();

		const update = endUpdate();
		expect(update?.status).toBe('failed');
		expect(String(update?.errorMessage)).not.toContain('s3cr3t-value');
	});

	test('a failed deploy still closes the row as "failed", never left "running"', async () => {
		deployStackResult = { success: false, error: 'exit code 1' };
		deployStackOnLines = [];

		await (await composeRoute.PUT(makeComposeEvent({ content: 'x', restart: true }))).json();

		expect(created).toHaveLength(1);
		const update = endUpdate();
		expect(update?.status).toBe('failed');
	});
});

describe('PUT /api/stacks/[name]/compose -- restart:false (save only, no deploy)', () => {
	test('creates NO schedule_executions row -- a save without a deploy must not become a run', async () => {
		const res = await composeRoute.PUT(makeComposeEvent({ content: 'x', restart: false }));
		expect(res.status).toBe(200);
		expect((await res.json()).success).toBe(true);

		expect(saveCalls).toHaveLength(1); // the save itself DID happen
		expect(deployStackCalls).toHaveLength(0); // but no deploy
		expect(created).toHaveLength(0); // and therefore no run record either
		expect(updates).toHaveLength(0);
	});

	test('omitting restart entirely (defaults to false) behaves identically', async () => {
		const res = await composeRoute.PUT(makeComposeEvent({ content: 'x' }));
		expect(res.status).toBe(200);
		expect(created).toHaveLength(0);
		expect(deployStackCalls).toHaveLength(0);
	});
});

describe('src/routes/api/stacks/[name]/deploy/+server.ts -- untouched by this task', () => {
	test('still calls createRunRecorder exactly once (source-level regression guard against double-recording)', async () => {
		const source = await readFile(
			join(here, '..', 'src', 'routes', 'api', 'stacks', '[name]', 'deploy', '+server.ts'),
			'utf8'
		);
		const matches = source.match(/createRunRecorder\(/g) ?? [];
		expect(matches).toHaveLength(1);
	});
});
