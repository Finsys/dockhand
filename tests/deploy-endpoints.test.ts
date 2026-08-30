/**
 * Authorization + data-shape tests for the three deploy-run routes under
 * api/stacks/[name]/deploys/. These do NOT inherit the no-auth model of
 * GET/DELETE /api/jobs/{id} (unguessable UUID, ten-minute in-memory job) --
 * every route here checks stacks:view/stacks:edit for itself, against a
 * small sequential integer id that persists forever in schedule_executions.
 *
 * $lib/server/db transitively loads better-sqlite3 (ERR_DLOPEN_FAILED under
 * Bun), so it has to be faked before the route modules are imported -- same
 * problem tests/backups/route-guards.test.ts already solved. Fakes for it are
 * registered via ../helpers/db-fake (registerDbFake), NOT via a separate
 * mock.module('$lib/server/db', ...) call here -- see that helper's doc
 * comment for why a second direct call collides with route-guards.test.ts's
 * (mock.module() replaces the whole module for the whole process; whichever
 * of the two files registers last wins for BOTH, deterministically, and the
 * loser's import throws "Export named 'X' not found").
 *
 * $lib/server/authorize is faked via tests/helpers/authorize-fake.ts (same
 * collision reason as the db fake above -- see that helper's doc comment), driven
 * by a per-test `authState`. $lib/server/deploy-log-store is NOT mocked: it only
 * touches node:fs/promises, so real file operations against a throwaway DATA_DIR
 * exercise the actual read/delete paths.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDbFake } from './helpers/db-fake';
import { registerAuthorizeFake } from './helpers/authorize-fake';

// -- $lib/server/authorize: fully replaced, driven by `authState` ----------

let authState: {
	authEnabled: boolean;
	isAuthenticated: boolean;
	isEnterprise: boolean;
	can: boolean;
	accessibleEnvs: number[] | 'all';
};

function resetAuthState() {
	authState = { authEnabled: true, isAuthenticated: true, isEnterprise: false, can: true, accessibleEnvs: 'all' };
}
resetAuthState();

registerAuthorizeFake(async () => ({
	authEnabled: authState.authEnabled,
	isAuthenticated: authState.isAuthenticated,
	isEnterprise: authState.isEnterprise,
	can: async () => authState.can,
	canAccessEnvironment: async (id: number) =>
		authState.accessibleEnvs === 'all' || authState.accessibleEnvs.includes(id)
}));

// -- $lib/server/db: an in-memory schedule_executions fake -----------------

let execStore: Map<number, any>;
let deletedIds: number[];
let lastListFilters: any;

function resetDbState() {
	execStore = new Map();
	deletedIds = [];
	lastListFilters = undefined;
}
resetDbState();

registerDbFake('getScheduleExecution', async (id: number) => execStore.get(id));
registerDbFake('deleteScheduleExecution', async (id: number) => {
	deletedIds.push(id);
	execStore.delete(id);
});
registerDbFake('getScheduleExecutions', async (filters: any) => {
	lastListFilters = filters;
	const all = [...execStore.values()].filter(
		(e) =>
			(filters.scheduleType === undefined || e.scheduleType === filters.scheduleType) &&
			(filters.entityName === undefined || e.entityName === filters.entityName) &&
			(filters.environmentId === undefined || e.environmentId === filters.environmentId)
	);
	return { executions: all, total: all.length, limit: filters.limit ?? 50, offset: 0 };
});

// -- Real deploy-log-store against a throwaway DATA_DIR ---------------------
//
// DATA_DIR is process-global and read at call time by every other test file
// too (belatedly discovered the hard way for exactly this variable in
// tests/fs-guard.test.ts / tests/selfhst-icons.test.ts -- a file that sets it
// and never restores it can break an unrelated, later-running file). Save and
// restore the prior value so this file leaves no trace once its tests finish.

const previousDataDir = process.env.DATA_DIR;
let dataDir: string;
beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'dv-t12-deploy-logs-'));
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

const { appendRunLog, readRunLog, deleteRunLog } = await import('../src/lib/server/deploy-log-store');

// -- Routes under test, imported AFTER all the fakes above are registered ---

const listRoute = await import('../src/routes/api/stacks/[name]/deploys/+server');
const runRoute = await import('../src/routes/api/stacks/[name]/deploys/[runId]/+server');
const logRoute = await import('../src/routes/api/stacks/[name]/deploys/[runId]/log/+server');

// -- Fixtures ----------------------------------------------------------------

const STACK = 'demo-stack';

const RUN = {
	id: 1,
	scheduleType: 'stack_deploy',
	scheduleId: 0,
	environmentId: null,
	entityName: STACK,
	triggeredBy: 'manual',
	triggeredAt: '2026-01-01T00:00:00.000Z',
	startedAt: null,
	completedAt: null,
	duration: 4200,
	status: 'success',
	errorMessage: null,
	details: { summary: 'ok' },
	logs: null,
	createdAt: null
};

function makeEvent(over: { params?: Record<string, string>; url?: string } = {}) {
	return {
		params: { name: STACK, runId: '1', ...over.params },
		url: new URL(over.url ?? 'http://x/'),
		cookies: { get: () => undefined } as any
	} as any;
}

beforeEach(async () => {
	resetAuthState();
	resetDbState();
	// Every test defaults to runId '1' -- clear its log file so tests don't
	// leak content into each other via the shared DATA_DIR.
	await deleteRunLog('1');
});

// =============================================================================
// GET /api/stacks/[name]/deploys (list)
// =============================================================================

describe('GET /api/stacks/[name]/deploys (list)', () => {
	test('no session -> 401 at the permission check, not a later error', async () => {
		authState.isAuthenticated = false;
		const res = await listRoute.GET(makeEvent());
		expect(res.status).toBe(401);
		expect((await res.json()).error).toBe('Authentication required');
	});

	test('missing env -> 400 (a stack name alone does not identify one environment)', async () => {
		const res = await listRoute.GET(makeEvent());
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('env query parameter is required');
	});

	test('non-numeric env -> the SAME 400 as missing env', async () => {
		const res = await listRoute.GET(makeEvent({ url: 'http://x/?env=abc' }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('env query parameter is required');
	});

	test('cross-environment leak: omitting env must NOT surface a run from an environment the caller cannot access', async () => {
		authState.isEnterprise = true;
		authState.accessibleEnvs = [1]; // caller can access env 1 only
		execStore.set(1, { ...RUN, environmentId: 1 });
		execStore.set(2, { ...RUN, id: 2, environmentId: 9 }); // foreign env, same stack name
		const res = await listRoute.GET(makeEvent()); // no ?env=
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).not.toHaveProperty('runs');
		expect(JSON.stringify(body)).not.toContain('"environmentId":9');
	});

	test('authenticated but lacking permission -> 403', async () => {
		authState.can = false;
		const res = await listRoute.GET(makeEvent({ url: 'http://x/?env=1' }));
		expect(res.status).toBe(403);
		expect((await res.json()).error).toBe('Permission denied');
	});

	test('lists only runs for THIS stack, without log text', async () => {
		execStore.set(1, { ...RUN, environmentId: 1 });
		execStore.set(2, { ...RUN, id: 2, environmentId: 1, entityName: 'other-stack' });
		const res = await listRoute.GET(makeEvent({ url: 'http://x/?env=1' }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.runs).toHaveLength(1);
		expect(body.runs[0].id).toBe(1);
		expect(body.runs[0]).not.toHaveProperty('logs');
		expect(lastListFilters.scheduleType).toBe('stack_deploy');
		expect(lastListFilters.entityName).toBe(STACK);
		expect(lastListFilters.environmentId).toBe(1);
	});

	test('skips a non-deploy schedule execution that happens to share the entity name', async () => {
		execStore.set(1, { ...RUN, environmentId: 1, scheduleType: 'backup' });
		const res = await listRoute.GET(makeEvent({ url: 'http://x/?env=1' }));
		const body = await res.json();
		expect(body.runs).toHaveLength(0);
	});
});

// =============================================================================
// GET /api/stacks/[name]/deploys/[runId] (single)
// =============================================================================

describe('GET /api/stacks/[name]/deploys/[runId] (single)', () => {
	test('no session -> 401 at the permission check, not a later error', async () => {
		authState.isAuthenticated = false;
		const res = await runRoute.GET(makeEvent());
		expect(res.status).toBe(401);
		expect((await res.json()).error).toBe('Authentication required');
	});

	test('authenticated but lacking permission -> 403', async () => {
		authState.can = false;
		const res = await runRoute.GET(makeEvent());
		expect(res.status).toBe(403);
		expect((await res.json()).error).toBe('Permission denied');
	});

	test('nonexistent run -> 404', async () => {
		const res = await runRoute.GET(makeEvent({ params: { runId: '999' } }));
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe('Deploy run not found');
	});

	test('run belonging to a DIFFERENT stack -> the SAME 404 as nonexistent', async () => {
		execStore.set(1, { ...RUN, entityName: 'other-stack' });
		const res = await runRoute.GET(makeEvent());
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe('Deploy run not found');
	});

	test('non-numeric run id -> 400', async () => {
		const res = await runRoute.GET(makeEvent({ params: { runId: 'abc' } }));
		expect(res.status).toBe(400);
	});

	test('cross-environment bypass: a caller-accessible env does not grant access to a DIFFERENT run env', async () => {
		authState.isEnterprise = true;
		authState.accessibleEnvs = [1]; // caller can access env 1
		execStore.set(1, { ...RUN, environmentId: 9 }); // but this run belongs to env 9
		const res = await runRoute.GET(makeEvent());
		expect(res.status).toBe(403);
	});

	test('accessible run -> 200 with metadata, no log text', async () => {
		execStore.set(1, RUN);
		const res = await runRoute.GET(makeEvent());
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe(1);
		expect(body.duration).toBe(4200);
		expect(body).not.toHaveProperty('logs');
	});
});

// =============================================================================
// DELETE /api/stacks/[name]/deploys/[runId]
// =============================================================================

describe('DELETE /api/stacks/[name]/deploys/[runId]', () => {
	test('no session -> 401 at the permission check, not a later error', async () => {
		authState.isAuthenticated = false;
		const res = await runRoute.DELETE(makeEvent());
		expect(res.status).toBe(401);
		expect((await res.json()).error).toBe('Authentication required');
	});

	test('authenticated but lacking permission -> 403', async () => {
		authState.can = false;
		const res = await runRoute.DELETE(makeEvent());
		expect(res.status).toBe(403);
		expect((await res.json()).error).toBe('Permission denied');
	});

	test('run belonging to a DIFFERENT stack -> 404, nothing deleted', async () => {
		execStore.set(1, { ...RUN, entityName: 'other-stack' });
		const res = await runRoute.DELETE(makeEvent());
		expect(res.status).toBe(404);
		expect(deletedIds).toEqual([]);
		expect(execStore.has(1)).toBe(true);
	});

	test('deletes the DB record AND the log file', async () => {
		execStore.set(1, RUN);
		await appendRunLog('1', 'some deploy output');
		expect(await readRunLog('1')).toBe('some deploy output');

		const res = await runRoute.DELETE(makeEvent());
		expect(res.status).toBe(200);
		expect((await res.json()).success).toBe(true);
		expect(deletedIds).toEqual([1]);
		expect(execStore.has(1)).toBe(false);
		expect(await readRunLog('1')).toBeNull();
	});
});

// =============================================================================
// GET /api/stacks/[name]/deploys/[runId]/log
// =============================================================================

describe('GET /api/stacks/[name]/deploys/[runId]/log', () => {
	test('no session -> 401 at the permission check, not a later error', async () => {
		authState.isAuthenticated = false;
		const res = await logRoute.GET(makeEvent());
		expect(res.status).toBe(401);
		expect((await res.json()).error).toBe('Authentication required');
	});

	test('authenticated but lacking permission -> 403', async () => {
		authState.can = false;
		const res = await logRoute.GET(makeEvent());
		expect(res.status).toBe(403);
		expect((await res.json()).error).toBe('Permission denied');
	});

	test('run belonging to a DIFFERENT stack -> 404, log file never touched', async () => {
		execStore.set(1, { ...RUN, entityName: 'other-stack' });
		await appendRunLog('1', 'secret content for the other stack');
		const res = await logRoute.GET(makeEvent());
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe('Deploy run not found');
	});

	test('run exists but the log file does not -> 404, does not wrongly look safe', async () => {
		execStore.set(1, RUN);
		const res = await logRoute.GET(makeEvent());
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe('Log not found');
	});

	test('cross-environment bypass applies here too', async () => {
		authState.isEnterprise = true;
		authState.accessibleEnvs = [1];
		execStore.set(1, { ...RUN, environmentId: 9 });
		await appendRunLog('1', 'should not be reachable');
		const res = await logRoute.GET(makeEvent());
		expect(res.status).toBe(403);
	});

	test('returns the log text as text/plain', async () => {
		execStore.set(1, RUN);
		await appendRunLog('1', 'line one\nline two');
		const res = await logRoute.GET(makeEvent());
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/plain');
		expect(await res.text()).toBe('line one\nline two');
	});
});

