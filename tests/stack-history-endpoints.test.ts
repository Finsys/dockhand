/**
 * Endpoint tests for /api/stacks/[name]/history, /api/stacks/[name]/env/raw and
 * /api/stacks/[name]/compose (PR #1548 review points 3, 4, 7, 8, 9, 12, plus
 * route-level proof of point 1).
 *
 * These drive the REAL route handlers with fake DB/stack/pointer layers (the
 * $lib/server/db module transitively loads better-sqlite3, which is not
 * loadable under Bun) - same harness pattern as tests/deploy-endpoints.test.ts:
 *   - $lib/server/authorize  via tests/helpers/authorize-fake.ts
 *   - $lib/server/db         via tests/helpers/db-fake.ts (registerDbFake); the
 *     getSecretKeysToMask fake returns the COMPLETE set (DB isSecret keys from
 *     dbState.envVars UNION dbState.injectedKeys) while the getStackInjectedSecretKeys
 *     fake returns the NARROWER provider-only set - so a route that regressed to
 *     the legacy injected-only call would leak a DB-only secret and fail the P1 tests
 *   - $lib/server/stacks     via tests/helpers/stacks-fake.ts (registerStacksFake)
 *   - $lib/server/stack-source-pointers via tests/helpers/pointers-fake.ts
 *
 * What runs REAL (and is therefore asserted on disk): the route handlers
 * themselves, env-param validation (parseEnvParam), the traversal-safe
 * params.name handling, stack-versions core (listVersions / readHistoryFile /
 * saveVersion / atomicWriteFile), the stack-version-wiring orchestration
 * (saveStackVersion incl. the in-lock pointer read), and file I/O against a
 * throwaway stack dir under os.tmpdir().
 *
 * Covered review points:
 *   P4  no double-decode of params.name (encoded sequences stay literal)
 *   P7  .history/ co-located with the actual .env file for custom-envPath stacks
 *   P8  exactly one (in-lock, atomic) .env write on the versioned path; a
 *       record failure leaves NO partial file and fails the request
 *   P9  stacks:view / stacks:edit permission gates, enterprise
 *       canAccessEnvironment scoping, 400/403/404 paths
 *   P12 ?env=abc is treated as null (never NaN into access checks / stack dir)
 *   P1  recorded versions are masked against the COMPLETE secret set
 *       (DB isSecret UNION provider keys), not injected-keys-only
 */
import { json } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isInternalDefaultComposePath } from '../src/lib/server/stack-path-utils';
import { saveStackVersion } from '../src/lib/server/stack-version-wiring';
import { registerAuthorizeFake } from './helpers/authorize-fake';
import { registerDbFake } from './helpers/db-fake';
import { registerStacksFake } from './helpers/stacks-fake';
import { registerPointersFake } from './helpers/pointers-fake';

// -- $lib/server/authorize: driven by `authState` (pattern: deploy-endpoints) --

let authState: {
	authEnabled: boolean;
	isAuthenticated: boolean;
	isEnterprise: boolean;
	can: boolean;
	canByEnv?: (environmentId: number | undefined) => boolean;
	accessibleEnvs: number[] | 'all';
	// Record of (resource, action, environmentId) can() calls for assertions.
	canCalls: Array<{ resource: string; action: string; environmentId: number | undefined }>;
};

function resetAuthState() {
	authState = {
		authEnabled: true,
		isAuthenticated: true,
		isEnterprise: false,
		can: true,
		canByEnv: undefined,
		accessibleEnvs: 'all',
		canCalls: []
	};
}
resetAuthState();

registerAuthorizeFake(async () => ({
	authEnabled: authState.authEnabled,
	isAuthenticated: authState.isAuthenticated,
	isEnterprise: authState.isEnterprise,
	can: async (resource: string, action: string, environmentId?: number) => {
		authState.canCalls.push({ resource, action, environmentId });
		return authState.canByEnv ? authState.canByEnv(environmentId) : authState.can;
	},
	canAccessEnvironment: async (id: number) => authState.accessibleEnvs === 'all' || authState.accessibleEnvs.includes(id),
	// Mirror of the real authorize()::requireEnvAccess (the compose route calls it
	// after the can() gate): no-op when auth is disabled or no env is given;
	// otherwise an env-scoping 403 on denial. Left off the fake, the compose
	// route would crash on the undefined method.
	requireEnvAccess: async (environmentId: number | null | undefined) => {
		if (!authState.authEnabled) return null;
		if (environmentId === null || environmentId === undefined) return null;
		const ok = authState.accessibleEnvs === 'all' || authState.accessibleEnvs.includes(environmentId);
		return ok ? null : json({ error: 'Access denied to this environment' }, { status: 403 });
	}
}));

// -- $lib/server/db -----------------------------------------------------------

const STACK = 'hist-stack';

let dbState: {
	source: any;
	envVars: Array<{ key: string; value: string; isSecret: boolean }>;
	injectedKeys: string[];
	nonSecretRecord: Record<string, string>;
	setCalls: Array<{ stackName: string; vars: any[] }>;
};

function resetDbState() {
	dbState = {
		source: { id: 1, stackName: STACK, sourceType: 'internal', envPath: null, composePath: null },
		envVars: [],
		injectedKeys: [],
		nonSecretRecord: {},
		setCalls: []
	};
}
resetDbState();

registerDbFake('getStackEnvVars', async () => dbState.envVars);
// Models production delete-then-insert: a PUT /env persist becomes the current
// DB state, so a LATER getSecretKeysToMask (e.g. at raw-env-save time) sees the
// secret just persisted - exactly the P1 leak path.
registerDbFake('setStackEnvVars', async (stackName: string, _envId: any, vars: any[]) => {
	dbState.setCalls.push({ stackName, vars });
	dbState.envVars = vars;
});
registerDbFake('getStackSource', async (name: string) => (name === STACK ? dbState.source : null));
// The COMPLETE mask set (prod: db.ts::getSecretKeysToMask): DB isSecret keys
// (from the persisted envVars state) UNION the provider-injected keys.
registerDbFake('getSecretKeysToMask', async () => {
	const keys = new Set(dbState.injectedKeys);
	for (const v of dbState.envVars) if (v.isSecret) keys.add(v.key);
	return keys;
});
// The NARROWER legacy view (prod: db.ts::getStackInjectedSecretKeys): provider
// keys ONLY, deliberately DISTINCT from getSecretKeysToMask - a route that
// regressed to this call would leak a DB-only secret into a recorded version
// and fail the P1 assertions below. Also used by the /env GET display path.
registerDbFake('getStackInjectedSecretKeys', async () => new Set(dbState.injectedKeys));
registerDbFake('getSecretProviderById', async () => null);
registerDbFake('getNonSecretEnvVarsAsRecord', async () => dbState.nonSecretRecord);

// -- $lib/server/stacks --------------------------------------------------------

let stacksState: {
	stackRoot: string;
	findDir: (name: string) => string | null;
	getDir: (name: string) => string;
	containers: any[];
	revertImpl: (name: string, envId: any, type: string, versionId: string) => Promise<any>;
	composeSaveCalls: Array<{ name: string; content: string }>;
	composeSaveImpl: (
		name: string,
		content: string,
		create: boolean,
		envId: number | null | undefined,
		options?: { composePath?: string | null }
	) => Promise<{ success: boolean; error?: string; composePath?: string | null }>;
	rawEnvWriteCalls: Array<{ name: string; content: string }>;
	stackDirCalls: Array<{ fn: 'getStackDir' | 'findStackDir'; name: string; envId: number | null | undefined }>;
};

// Default saveStackComposeFile fake: records the call only (route-plumbing
// tests). The P3 block swaps in the production-shape mirror below.
const defaultComposeSaveRecorder = async (
	name: string,
	content: string,
	_create?: boolean,
	envId?: number | null,
	options?: { composePath?: string | null }
): Promise<{ success: boolean; error?: string; composePath?: string | null }> => {
	stacksState.composeSaveCalls.push({ name, content });
	return { success: true, composePath: null };
};

function resetStacksState(stackRoot: string) {
	stacksState = {
		stackRoot,
		findDir: (name) => (name === STACK ? join(stackRoot, 'Local', STACK) : null),
		getDir: (name) => join(stackRoot, 'Local', name),
		containers: [],
		revertImpl: async () => ({ success: true, timestamp: '2026-01-01T00:00:00.000Z' }),
		composeSaveCalls: [],
		composeSaveImpl: defaultComposeSaveRecorder,
		rawEnvWriteCalls: [],
		stackDirCalls: []
	};
}

registerStacksFake('getStackDir', async (name: string, envId: number | null | undefined) => {
	stacksState.stackDirCalls.push({ fn: 'getStackDir', name, envId: envId ?? null });
	return stacksState.getDir(name);
});
registerStacksFake('findStackDir', async (name: string, envId: number | null | undefined) => {
	stacksState.stackDirCalls.push({ fn: 'findStackDir', name, envId: envId ?? null });
	return stacksState.findDir(name);
});
registerStacksFake('getStackContainers', async () => stacksState.containers);
registerStacksFake('revertStackVersion', async (name: string, envId: any, type: string, versionId: string) =>
	stacksState.revertImpl(name, envId, type, versionId)
);
registerStacksFake(
	'saveStackComposeFile',
	async (name: string, content: string, create: boolean, envId: number | null | undefined, options?: { composePath?: string | null }) =>
		stacksState.composeSaveImpl(name, content, create, envId, options)
);
registerStacksFake('writeRawStackEnvFile', async (name: string, content: string) => {
	stacksState.rawEnvWriteCalls.push({ name, content });
});
// Real lock semantics are irrelevant in these single-threaded tests: pass
// straight through (the in-lock pointer read still executes in order).
registerStacksFake('withStackLock', async (_name: string, fn: () => Promise<unknown>) => fn());

// -- $lib/server/stack-source-pointers ----------------------------------------

let pointerState: {
	pointer: { lastSavedAt: string | null; lastDeployedAt: string | null };
	upsertImpl: (name: string, envId: any, values: any) => Promise<void>;
	upsertCalls: Array<{ name: string; values: any }>;
};

function resetPointerState() {
	pointerState = {
		pointer: { lastSavedAt: null, lastDeployedAt: null },
		upsertImpl: async () => undefined,
		upsertCalls: []
	};
}
resetPointerState();

registerPointersFake('readStackSourcePointer', async () => pointerState.pointer);
registerPointersFake('upsertStackSourcePointer', async (name: string, _envId: any, values: any) => {
	pointerState.upsertCalls.push({ name, values });
	await pointerState.upsertImpl(name, _envId, values);
});

// -- Route modules (import AFTER the fakes are registered) --------------------

const historyRoute = await import('../src/routes/api/stacks/[name]/history/+server');
const envRawRoute = await import('../src/routes/api/stacks/[name]/env/raw/+server');
const envRoute = await import('../src/routes/api/stacks/[name]/env/+server');
// Loadable with this harness's fakes: its import chain is $lib/server/stacks
// (faked), $lib/server/authorize (faked) and pure/sse/recorder modules only -
// no $lib/server/db/drizzle, no $lib/server/docker (contrast: the root
// api/stacks POST route drags both in and is covered source-level instead).
const composeRoute = await import('../src/routes/api/stacks/[name]/compose/+server');

// -- Fixture + event helpers ---------------------------------------------------

let stackRoot: string;
let stackDir: string;

beforeAll(() => {
	stackRoot = mkdtempSync(join(tmpdir(), 'sdv-history-ep-root-'));
	stackDir = join(stackRoot, 'Local', STACK);
	mkdirSync(join(stackDir, '.history'), { recursive: true });
});

afterAll(() => {
	rmSync(stackRoot, { recursive: true, force: true });
});

function clearHistoryDir() {
	const hist = join(stackDir, '.history');
	for (const f of readdirSync(hist)) rmSync(join(hist, f), { force: true });
}

function makeEvent(over: { params?: Record<string, string>; url?: string; body?: any } = {}) {
	const url = new URL(over.url ?? `http://x/api/stacks/${encodeURIComponent(STACK)}/history`);
	const request = over.body !== undefined
		? new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(over.body)
			})
		: undefined;
	return {
		params: { name: STACK, ...over.params },
		url,
		cookies: { get: () => undefined } as any,
		request
	} as any;
}

function makeComposeEvent(over: { params?: Record<string, string>; url?: string; body?: any } = {}) {
	const url = new URL(over.url ?? `http://x/api/stacks/${encodeURIComponent(STACK)}/compose`);
	const request = new Request(url, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(over.body ?? {})
	});
	return {
		params: { name: STACK, ...over.params },
		url,
		cookies: { get: () => undefined } as any,
		request
	} as any;
}

function makeRawEvent(over: { params?: Record<string, string>; url?: string; body?: any } = {}) {
	const url = new URL(over.url ?? `http://x/api/stacks/${encodeURIComponent(STACK)}/env/raw`);
	const request = new Request(url, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(over.body ?? {})
	});
	return {
		params: { name: STACK, ...over.params },
		url,
		cookies: { get: () => undefined } as any,
		request
	} as any;
}

beforeEach(() => {
	resetAuthState();
	resetDbState();
	resetStacksState(stackRoot);
	resetPointerState();
	clearHistoryDir();
	rmSync(join(stackDir, '.env'), { force: true });
});

async function readBody(res: Response): Promise<any> {
	return await res.json();
}

// =============================================================================
// P9: permission gates + validation paths on the history endpoint
// =============================================================================

describe('GET /api/stacks/[name]/history (P9 gates, P12 env validation, P4 traversal)', () => {
	test('auth disabled -> 200 with an empty version list (never a 404)', async () => {
		authState.authEnabled = false;
		const res = await historyRoute.GET(makeEvent());
		expect(res.status).toBe(200);
		const body = await readBody(res);
		expect(body.type).toBe('compose');
		expect(body.versions).toEqual([]);
		expect(body.lastSavedAt).toBeNull();
		expect(body.lastDeployedAt).toBeNull();
	});

	test('stacks:view denied -> 403 Permission denied', async () => {
		authState.can = false;
		const res = await historyRoute.GET(makeEvent());
		expect(res.status).toBe(403);
		expect((await readBody(res)).error).toBe('Permission denied');
	});

	test('enterprise: canAccessEnvironment denied -> 403 Access denied', async () => {
		authState.isEnterprise = true;
		authState.accessibleEnvs = [1];
		const res = await historyRoute.GET(makeEvent({ url: `http://x/api/stacks/${encodeURIComponent(STACK)}/history?env=5` }));
		expect(res.status).toBe(403);
		expect((await readBody(res)).error).toBe('Access denied to this environment');
	});

	test('enterprise: accessible environment passes the access check', async () => {
		authState.isEnterprise = true;
		authState.accessibleEnvs = [5];
		const res = await historyRoute.GET(makeEvent({ url: `http://x/api/stacks/${encodeURIComponent(STACK)}/history?env=5` }));
		expect(res.status).toBe(200);
	});

	test('invalid type -> 400', async () => {
		const res = await historyRoute.GET(makeEvent({ url: `http://x/api/stacks/${encodeURIComponent(STACK)}/history?type=bogus` }));
		expect(res.status).toBe(400);
		expect((await readBody(res)).error).toBe('Invalid type');
	});

	test('P12: ?env=abc is treated as null (no NaN reaches the checks or the stack dir)', async () => {
		const res = await historyRoute.GET(makeEvent({ url: `http://x/api/stacks/${encodeURIComponent(STACK)}/history?env=abc` }));
		expect(res.status).toBe(200);
		// can() was asked about the no-env case (undefined), never about NaN.
		const viewCall = authState.canCalls.find((c) => c.action === 'view');
		expect(viewCall).toBeDefined();
		expect(Number.isNaN(viewCall!.environmentId as any)).toBe(false);
		// The stack dir resolution received null, never NaN.
		const dirCall = stacksState.stackDirCalls.find((c) => c.fn === 'getStackDir');
		expect(dirCall).toBeDefined();
		expect(dirCall!.envId).toBeNull();
	});

	test('P12: ?env=5 passes the integer through to can() and the stack dir', async () => {
		const res = await historyRoute.GET(makeEvent({ url: `http://x/api/stacks/${encodeURIComponent(STACK)}/history?env=5` }));
		expect(res.status).toBe(200);
		const viewCall = authState.canCalls.find((c) => c.action === 'view');
		expect(viewCall!.environmentId).toBe(5);
	});

	test('P4: an encoded sequence in params.name is NOT decoded a second time', async () => {
		// SvelteKit hands the handler the ALREADY-decoded name; a second
		// decodeURIComponent would turn 'a/%2e%2e/b' into the traversal 'a/../b'.
		const res = await historyRoute.GET(makeEvent({ params: { name: 'a/%2e%2e/b' } }));
		expect(res.status).toBe(200);
		// The handler used the name verbatim (the fake getStackDir records it).
		const call = stacksState.stackDirCalls.find((c) => c.fn === 'getStackDir');
		expect(call!.name).toBe('a/%2e%2e/b');
	});

	test('P4: a decoded traversal name is inert (no file outside the stack roots is read)', async () => {
		// The name resolves to a path outside the fixture root that holds no
		// history file: the handler must answer 200 with an empty list, not a
		// 500 (and nothing escapes the read of a nonexistent path).
		const res = await historyRoute.GET(makeEvent({ params: { name: '../../etc' } }));
		expect(res.status).toBe(200);
		const body = await readBody(res);
		expect(body.versions).toEqual([]);
	});

	test('GET returns saved versions newest-first with pointers (functional P9)', async () => {
		// Seed two versions on disk through the REAL core (as a save would).
		const { saveVersion } = await import('../src/lib/server/stack-versions');
		saveVersion(stackDir, 'compose', 'v1\n', { timestamp: '2026-01-01T00:00:00.000Z' });
		saveVersion(stackDir, 'compose', 'v2\n', { timestamp: '2026-01-02T00:00:00.000Z' });
		pointerState.pointer = { lastSavedAt: '2026-01-02T00:00:00.000Z', lastDeployedAt: null };

		const res = await historyRoute.GET(makeEvent());
		expect(res.status).toBe(200);
		const body = await readBody(res);
		expect(body.versions).toHaveLength(2);
		expect(body.versions[0].timestamp).toBe('2026-01-02T00:00:00.000Z'); // newest first
		expect(body.lastSavedAt).toBe('2026-01-02T00:00:00.000Z');
		expect(body.lastDeployedAt).toBeNull();
	});
});

// =============================================================================
// P9: POST validation / permission / 404 paths
// =============================================================================

describe('POST /api/stacks/[name]/history (P9 gates, P12 env validation)', () => {
	test('stacks:edit denied -> 403 Permission denied', async () => {
		authState.can = false;
		const res = await historyRoute.POST(makeEvent({ url: 'http://x/api/stacks/hist-stack/history', body: { action: 'save', type: 'compose', content: 'x' } }));
		expect(res.status).toBe(403);
		expect((await readBody(res)).error).toBe('Permission denied');
	});

	test('invalid action -> 400', async () => {
		const res = await historyRoute.POST(makeEvent({ url: 'http://x/api/stacks/hist-stack/history', body: { action: 'bogus', type: 'compose', content: 'x' } }));
		expect(res.status).toBe(400);
		expect((await readBody(res)).error).toBe('Invalid action or type');
	});

	test('invalid type -> 400', async () => {
		const res = await historyRoute.POST(makeEvent({ url: 'http://x/api/stacks/hist-stack/history', body: { action: 'save', type: 'bogus', content: 'x' } }));
		expect(res.status).toBe(400);
	});

	test('save without content -> 400', async () => {
		const res = await historyRoute.POST(makeEvent({ url: 'http://x/api/stacks/hist-stack/history', body: { action: 'save', type: 'compose' } }));
		expect(res.status).toBe(400);
		expect((await readBody(res)).error).toBe('content is required for save');
	});

	test('revert without versionId -> 400', async () => {
		const res = await historyRoute.POST(makeEvent({ url: 'http://x/api/stacks/hist-stack/history', body: { action: 'revert', type: 'compose' } }));
		expect(res.status).toBe(400);
		expect((await readBody(res)).error).toBe('versionId is required for revert');
	});

	test('revert to an unknown version -> 404', async () => {
		stacksState.revertImpl = async () => ({ success: false, error: 'Version not found' });
		const res = await historyRoute.POST(makeEvent({ url: 'http://x/api/stacks/hist-stack/history', body: { action: 'revert', type: 'compose', versionId: 'nope' } }));
		expect(res.status).toBe(404);
		expect((await readBody(res)).error).toBe('Version not found');
	});

	test('P12: ?env=abc on POST is treated as null (can() never sees NaN)', async () => {
		const res = await historyRoute.POST(makeEvent({ url: `http://x/api/stacks/${encodeURIComponent(STACK)}/history?env=abc`, body: { action: 'save', type: 'compose', content: 'x' } }));
		expect(res.status).toBe(200);
		const editCall = authState.canCalls.find((c) => c.action === 'edit');
		expect(Number.isNaN(editCall!.environmentId as any)).toBe(false);
		expect(stacksState.composeSaveCalls).toHaveLength(1);
	});

	test('P4: POST uses params.name as-is (no double decode)', async () => {
		const res = await historyRoute.POST(makeEvent({ params: { name: 'a/%2e%2e/b' }, url: 'http://x/api/stacks/x/history', body: { action: 'revert', type: 'compose', versionId: 'v1' } }));
		expect(res.status).toBe(200);
	});
});

// =============================================================================
// P1 (route level): recorded versions are masked against the COMPLETE set
// =============================================================================

describe('PUT /api/stacks/[name]/env/raw (P1 masking, P7 dir co-location, P8 single write, P12)', () => {
	const CONTENT = 'DB_SECRET=topsecret\nPLAIN=x\nPROVIDER_KEY=pv\nOTHER=y\n';

	test('internal stack: the recorded version excludes DB AND provider secrets; the file is written exactly once', async () => {
		// The complete mask set is the UNION: DB_SECRET is a DB isSecret key with
		// NO provider counterpart; PROVIDER_KEY is provider-injected and never in
		// the DB. If the route used the legacy injected-only view, DB_SECRET
		// (name and value) would leak into the version file and this test fails.
		dbState.envVars = [{ key: 'DB_SECRET', value: 'topsecret', isSecret: true }];
		dbState.injectedKeys = ['PROVIDER_KEY'];
		const res = await envRawRoute.PUT(makeRawEvent({ body: { content: CONTENT } }));
		expect(res.status).toBe(200);

		// The .env file holds the submitted content (single in-lock write).
		const envFile = join(stackDir, '.env');
		expect(existsSync(envFile)).toBe(true);
		expect(readFileSync(envFile, 'utf8')).toBe(CONTENT);

		// The version file exists next to the .env file (P7 default co-location).
		const histFile = join(stackDir, '.history', 'env.json');
		expect(existsSync(histFile)).toBe(true);
		const raw = readFileSync(histFile, 'utf8');
		// Non-secrets are stored...
		expect(raw).toContain('PLAIN');
		expect(raw).toContain('OTHER');
		// ...and NO secret key name or value survives (P1), for both the DB
		// secret and the provider-injected key.
		expect(raw).not.toContain('DB_SECRET');
		expect(raw).not.toContain('topsecret');
		expect(raw).not.toContain('PROVIDER_KEY');
		expect(raw).not.toContain('pv');

		// The pointer advanced (version recorded + saved).
		expect(pointerState.upsertCalls.length).toBe(1);
	});

	test('git stack: no version is recorded; the plain file write still happens', async () => {
		dbState.source = { id: 1, stackName: STACK, sourceType: 'git', envPath: null, composePath: null };
		const res = await envRawRoute.PUT(makeRawEvent({ body: { content: 'A=1\n' } }));
		expect(res.status).toBe(200);
		expect(readFileSync(join(stackDir, '.env'), 'utf8')).toBe('A=1\n');
		expect(existsSync(join(stackDir, '.history', 'env.json'))).toBe(false);
	});

	test('P7: custom envPath -> .history/ lands in the SAME dir as the .env file', async () => {
		const customDir = join(stackRoot, 'adopted', STACK);
		mkdirSync(join(customDir, '.history'), { recursive: true });
		dbState.source = { id: 1, stackName: STACK, sourceType: 'internal', envPath: join(customDir, '.env'), composePath: null };
		// findStackDir resolves to the adopted (custom) dir; getStackDir would
		// give the default one - the version record MUST follow the .env file.
		stacksState.findDir = () => customDir;
		dbState.injectedKeys = ['S'];

		const res = await envRawRoute.PUT(makeRawEvent({ body: { content: 'P=1\n' } }));
		expect(res.status).toBe(200);
		expect(existsSync(join(customDir, '.env'))).toBe(true);
		expect(existsSync(join(customDir, '.history', 'env.json'))).toBe(true);
		// And NOT in the default dir:
		expect(existsSync(join(stackDir, '.history', 'env.json'))).toBe(false);
	});

	test('P8: a version-record failure fails the request and leaves NO partial .env file (all-or-nothing)', async () => {
		dbState.injectedKeys = ['S'];
		const histDir = join(stackDir, '.history');
		// Force the core save to fail: a read-only .history dir makes the atomic
		// version write (recordVersion) throw. The pointer-advance path swallows
		// failures by design, so it cannot be used to prove the rollback.
		chmodSync(histDir, 0o500);

		try {
			const res = await envRawRoute.PUT(makeRawEvent({ body: { content: 'A=1\n' } }));
			// Old code: the leading unlocked writeFileSync had already written the
			// file, the record failed best-effort, and the response was 200 - a
			// half state (new file content, no history entry). New code: the in-
			// lock save is all-or-nothing, the error surfaces, and the rolled-back
			// live file is removed (it did not exist before).
			expect(res.status).toBe(500);
			expect(existsSync(join(stackDir, '.env'))).toBe(false);
			expect(existsSync(join(histDir, 'env.json'))).toBe(false);
		} finally {
			// Restore so the next test's cleanup can remove the dir contents.
			chmodSync(histDir, 0o755);
		}
	});

	test('P12: ?env=abc on PUT is treated as null (no NaN into the dir resolution)', async () => {
		const res = await envRawRoute.PUT(makeRawEvent({ url: `http://x/api/stacks/${encodeURIComponent(STACK)}/env/raw?env=abc`, body: { content: 'A=1\n' } }));
		expect(res.status).toBe(200);
		const call = stacksState.stackDirCalls.find((c) => c.fn === 'findStackDir');
		expect(call!.envId).toBeNull();
	});

	test('empty content deletes the .env file (existing behavior preserved)', async () => {
		writeFileSync(join(stackDir, '.env'), 'A=1\n');
		const res = await envRawRoute.PUT(makeRawEvent({ body: { content: '   ' } }));
		expect(res.status).toBe(200);
		const body = await readBody(res);
		expect(body.deleted).toBe(true);
		expect(existsSync(join(stackDir, '.env'))).toBe(false);
	});
});

// =============================================================================
// P1 (route level, DB-source secrets): PUT /env and POST history save for
// GIT stacks mask the COMPLETE set from the DB
// =============================================================================

describe('PUT /env + POST history (P1: DB isSecret keys masked on GIT stacks)', () => {
	test('PUT /env (git stack): the recorded version excludes DB secrets, keeps non-secrets', async () => {
		dbState.source = { id: 1, stackName: STACK, sourceType: 'git', envPath: null, composePath: null };
		// The DB is the live source: the secret is a DB isSecret key (not
		// provider-injected - injectedKeys stays empty) - exactly the case the
		// old injected-only mask leaked (P1). PUT /env persists it, and the
		// union fake picks it up from the persisted envVars state.
		dbState.injectedKeys = [];
		dbState.nonSecretRecord = { UAT_GIT_PLAIN: 'public-value' };

		const url = new URL(`http://x/api/stacks/${encodeURIComponent(STACK)}/env`);
		const request = new Request(url, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				variables: [
					{ key: 'UAT_GIT_PLAIN', value: 'public-value', isSecret: false },
					{ key: 'UAT_GIT_SECRET', value: 'deadbeefcafe0123deadbeef', isSecret: true }
				]
			})
		});
		const res = await envRoute.PUT({ params: { name: STACK }, url, cookies: { get: () => undefined } as any, request } as any);
		expect(res.status).toBe(200);

		const raw = readFileSync(join(stackDir, '.history', 'env.json'), 'utf8');
		expect(raw).toContain('UAT_GIT_PLAIN');
		expect(raw).toContain('public-value');
		expect(raw).not.toContain('UAT_GIT_SECRET');
		expect(raw).not.toContain('deadbeefcafe0123deadbeef');
	});

	test('POST /history save env (git stack): version recorded secret-free via the complete mask set', async () => {
		dbState.source = { id: 1, stackName: STACK, sourceType: 'git', envPath: null, composePath: null };
		dbState.envVars = [{ key: 'UAT_GIT_SECRET', value: 'cafebabedeadbeefcafebabedead', isSecret: true }];
		dbState.injectedKeys = [];

		const res = await historyRoute.POST(
			makeEvent({ url: `http://x/api/stacks/${encodeURIComponent(STACK)}/history`, body: { action: 'save', type: 'env', content: 'G=1\n' } })
		);
		expect(res.status).toBe(200);

		const raw = readFileSync(join(stackDir, '.history', 'env.json'), 'utf8');
		expect(raw).toContain('G');
		expect(raw).not.toContain('UAT_GIT_SECRET');
		expect(raw).not.toContain('cafebabedeadbeef');
	});
});

// =============================================================================
// P1 (route level, deliverable): internal stack - a secret persisted to the DB
// via PUT /env must be absent from the version file recorded by a LATER raw env
// save (the complete mask set at save time includes DB isSecret keys, not just
// provider-injected ones).
// =============================================================================

describe('P1 (deliverable): DB-persisted secret absent after a raw env save (internal stack)', () => {
	test('PUT /env (DB) + PUT /env/raw: the recorded version file excludes the DB secret by name AND value', async () => {
		// Internal stack: the secret lives ONLY in the DB (persisted via PUT /env),
		// never in the .env file. No provider keys are bound (injectedKeys empty),
		// so the mask set is the DB isSecret set ALONE - the legacy injected-only
		// view would be empty and would store DB_SECRET's name AND value.
		dbState.source = { id: 1, stackName: STACK, sourceType: 'internal', envPath: null, composePath: null };
		dbState.injectedKeys = [];

		// Step 1: persist the secret to the DB via PUT /env.
		const url = new URL(`http://x/api/stacks/${encodeURIComponent(STACK)}/env`);
		const request = new Request(url, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ variables: [{ key: 'DB_SECRET', value: 'deadbeefcafe0123', isSecret: true }] })
		});
		const putRes = await envRoute.PUT({ params: { name: STACK }, url, cookies: { get: () => undefined } as any, request } as any);
		expect(putRes.status).toBe(200);
		expect(dbState.setCalls).toHaveLength(1); // the secret hit the DB store

		// Step 2: a raw env save (the version-recording path for internal stacks).
		// The raw file carries the DB secret's key name (legacy file / user error);
		// the recorded version must mask it via the COMPLETE set.
		const rawRes = await envRawRoute.PUT(makeRawEvent({ body: { content: 'DB_SECRET=leaked-into-file\nPLAIN=x\n' } }));
		expect(rawRes.status).toBe(200);

		// The LIVE .env file holds the submitted content - only the VERSION is masked.
		expect(readFileSync(join(stackDir, '.env'), 'utf8')).toBe('DB_SECRET=leaked-into-file\nPLAIN=x\n');

		// The recorded version file excludes the DB secret by name AND value
		// (neither the value from the raw file nor the one persisted in the DB).
		const histRaw = readFileSync(join(stackDir, '.history', 'env.json'), 'utf8');
		expect(histRaw).toContain('PLAIN');
		expect(histRaw).not.toContain('DB_SECRET');
		expect(histRaw).not.toContain('leaked-into-file');
		expect(histRaw).not.toContain('deadbeefcafe0123');
	});
});

// =============================================================================
// P3: the internal-default compose sentinel probes all FOUR standard filenames
// (deliverable: internal stack whose live file is docker-compose.yml -> PUT
// compose with the resolved path -> success AND GET history lists >=1 version;
// before the fix the hardcoded `join(internalDir, 'compose.yaml')` sentinel
// routed those saves to the unversioned custom-path branch and NO history was
// recorded. A genuinely external path keeps the unversioned branch.)
//
// The REAL saveStackComposeFile (src/lib/server/stacks.ts) cannot run in this
// process: it imports $lib/server/db/drizzle (seeds a real better-sqlite3 DB at
// import time) and the $lib/server/stacks specifier is frozen process-wide by
// stacks-fake for the route files that need it. So saveStackComposeFile is
// mirrored below with the REAL classification helper (isInternalDefaultComposePath)
// and the REAL versioning orchestration (saveStackVersion, on disk) -- the same
// modules the production code imports. A regression in the REAL module (e.g. the
// sentinel reverting to the hardcoded compose.yaml join) is pinned by the
// source-level guard in tests/stack-history.test.ts.
// =============================================================================

const productionShapeComposeSave = async (
	name: string,
	content: string,
	create: boolean,
	envId: number | null | undefined,
	options?: { composePath?: string | null }
): Promise<{ success: boolean; error?: string; composePath?: string }> => {
	const composePath = options?.composePath || dbState.source?.composePath;
	if (composePath) {
		// Same dir resolution as production: getStackDir for creates, findStackDir
		// for updates (the harness fakes resolve both to the fixture dir).
		const internalDir = create ? stacksState.getDir(name) : stacksState.findDir(name);
		if (!isInternalDefaultComposePath(composePath, internalDir)) {
			// Genuinely external custom path: plain write, NO versioning (the P3
			// fix must not change external-path behavior).
			const parentDir = dirname(composePath);
			if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
			writeFileSync(composePath, content);
			return { success: true };
		}
	}
	// Internal default (or no explicit path): the versioned, locked save.
	// findDir can return null by harness contract; every P3 test resolves
	// STACK (non-null), so the fallback below is a type-only guard, never
	// taken in this suite.
	const stackDir = (create ? stacksState.getDir(name) : stacksState.findDir(name)) ?? stacksState.getDir(name);
	try {
		// withStackLock is a passthrough fake in this harness; the pointer read +
		// best-effort advance mirror the in-lock production ordering through the
		// shared pointerState (the same state the registerPointersFake impls use).
		await saveStackVersion({
			stackDir,
			livePath: join(stackDir, 'compose.yaml'),
			type: 'compose',
			content,
			lastDeployedAt: pointerState.pointer.lastDeployedAt,
			advancePointer: (values) => {
				pointerState.upsertCalls.push({ name, values });
				return pointerState.upsertImpl(name, envId ?? null, values);
			}
		});
		return { success: true, composePath: join(stackDir, 'compose.yaml') };
	} catch (err: any) {
		return { success: false, error: `Failed to ${create ? 'create' : 'save'} compose file: ${err.message}` };
	}
};

describe('PUT /api/stacks/[name]/compose + GET history (P3: four-filename internal-default sentinel)', () => {
	const ORIGINAL = 'services:\n  orig:\n    image: original:1\n';

	async function getHistoryBody() {
		const res = await historyRoute.GET(makeEvent());
		expect(res.status).toBe(200);
		return await readBody(res);
	}

	beforeEach(() => {
		// Run the REAL versioning core on disk through the production-shape mirror
		// instead of the call recorder.
		stacksState.composeSaveImpl = productionShapeComposeSave;
		// The shared pointer fake records upsert calls but its default upsertImpl
		// mutates nothing; mirror the production upsert (advance last_saved_at) so
		// GET history reports the post-save pointer, like a real DB row would.
		pointerState.upsertImpl = async (_name, _envId, values) => {
			if (values.lastSavedAt) pointerState.pointer.lastSavedAt = values.lastSavedAt;
			if (values.lastDeployedAt !== undefined) pointerState.pointer.lastDeployedAt = values.lastDeployedAt;
		};
		// The stack's live compose file is docker-compose.yml -- the maintainer's
		// P3 repro: an internal stack whose file is NOT the hardcoded compose.yaml.
		writeFileSync(join(stackDir, 'docker-compose.yml'), ORIGINAL);
	});

	test('deliverable: internal stack with docker-compose.yml -> PUT compose (resolved path) -> success AND history >=1 version', async () => {
		const resolved = join(stackDir, 'docker-compose.yml'); // what the edit modal submits
		const content = 'services:\n  new:\n    image: new:1\n';

		const put = await composeRoute.PUT(makeComposeEvent({ body: { content, composePath: resolved, restart: false } }));
		expect(put.status).toBe(200);
		expect((await readBody(put)).success).toBe(true);

		// The versioned save (not the unversioned custom-path write) recorded a
		// secret-free version on disk next to the stack.
		const histFile = join(stackDir, '.history', 'compose.json');
		expect(existsSync(histFile)).toBe(true);
		expect(readFileSync(histFile, 'utf8')).toContain('new:1');

		const body = await getHistoryBody();
		expect(body.versions.length).toBeGreaterThanOrEqual(1); // pre-fix: 0
		expect(body.lastSavedAt).not.toBeNull(); // the versioned save advanced last_saved_at
		// The in-lock pointer advance landed (mirrors the registerPointersFake impl).
		expect(pointerState.upsertCalls.length).toBe(1);
		// The versioned save wrote the live content to the default compose.yaml,
		// which the history GET matches as the current (live) version.
		expect(readFileSync(join(stackDir, 'compose.yaml'), 'utf8')).toBe(content);
		expect(body.currentVersionId).toBe(body.versions[0].id);
	});

	test('all four standard filenames inside the stack dir take the versioned branch', async () => {
		const names = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
		for (let i = 0; i < names.length; i++) {
			const p = join(stackDir, names[i]);
			writeFileSync(p, `services:\n  pre${i}:\n    image: pre${i}\n`);
			const res = await composeRoute.PUT(
				makeComposeEvent({ body: { content: `services:\n  svc${i}:\n    image: svc${i}\n`, composePath: p, restart: false } })
			);
			expect(res.status).toBe(200);
		}
		// One version per save (distinct contents -> no no-op skip): all four
		// filenames were versioned, none fell through to the unversioned branch.
		const body = await getHistoryBody();
		expect(body.versions).toHaveLength(4);
	});

	test('a genuinely EXTERNAL path keeps the unversioned custom branch (no over-correction)', async () => {
		const external = join(stackRoot, 'external', STACK, 'compose.yaml'); // same basename, different dir
		const content = 'services:\n  ext:\n    image: ext\n';
		const res = await composeRoute.PUT(makeComposeEvent({ body: { content, composePath: external, restart: false } }));
		expect(res.status).toBe(200);
		// The custom-path branch wrote the file directly (parent dir auto-created)...
		expect(readFileSync(external, 'utf8')).toBe(content);
		// ...and recorded NO version: external stacks are out of scope for versioning.
		const body = await getHistoryBody();
		expect(body.versions).toHaveLength(0);
		expect(existsSync(join(stackDir, '.history', 'compose.json'))).toBe(false);
	});
});
