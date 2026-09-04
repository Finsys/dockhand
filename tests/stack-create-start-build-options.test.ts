/**
 * Before this fix, POST /api/stacks (Create & Start) ALWAYS deployed with
 * build:false and no pullPolicy, regardless of what the caller sent -- a stack whose
 * compose declares a `build:` section silently never built on its first start.
 *
 * This is a SOURCE-LEVEL check, not a route-level one, for the same reason
 * tests/stack-compose-redeploy-run-record.test.ts's own doc comment gives for NOT
 * importing the dedicated deploy endpoint: importing this route for real pulls in
 * $lib/server/audit -> $lib/server/license -> $lib/server/notifications/index.ts for
 * the auditStack() call this route makes -- and, worse, $lib/server/docker ->
 * hawser.ts -> `./db/drizzle.js`, a SEPARATE module specifier from $lib/server/db
 * that instantiates a real better-sqlite3 connection at import time (confirmed
 * empirically: faking $lib/server/db alone is not enough, the drizzle specifier
 * throws ERR_DLOPEN_FAILED under Bun regardless). Faking that whole chain just to
 * prove three destructured request fields reach one function call would be a much
 * bigger maintenance burden than the guard itself is worth.
 *
 * What IS covered by a real route-level test: the identical pull/build/forceRecreate
 * plumbing in PUT /api/stacks/[name]/compose (Save & redeploy), which has no such
 * import chain -- see the "restart:true build/pull/forceRecreate options" describe
 * block in stack-compose-redeploy-run-record.test.ts. Both routes were changed
 * together, from the same requestBody shape RedeployPopover.svelte now sends; this
 * file's job is only to catch this route's copy of that change regressing
 * independently of the other.
 */
import { describe, test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const routePath = join(here, '..', 'src', 'routes', 'api', 'stacks', '+server.ts');

async function readRoute(): Promise<string> {
	return readFile(routePath, 'utf8');
}

describe('POST /api/stacks -- build/pull/forceRecreate options (source-level)', () => {
	test('the request body destructuring includes pull, build, and forceRecreate', async () => {
		const source = await readRoute();
		// Single destructuring statement for the whole POST body -- match it as one
		// block so a future refactor that drops one of the three fields (while keeping
		// the others) still fails this test, instead of three independent substring
		// checks that could each pass against three DIFFERENT destructuring statements.
		const match = source.match(/const\s*\{([^}]*)\}\s*=\s*body;/);
		expect(match).not.toBeNull();
		const fields = match![1];
		expect(fields).toContain('pull');
		expect(fields).toContain('build');
		expect(fields).toContain('forceRecreate');
	});

	test('deployStack() is called with build and pullPolicy derived from the request, not hardcoded', async () => {
		const source = await readRoute();
		const deployCall = source.match(/const result = await deployStack\(\{[\s\S]*?\}\);/);
		expect(deployCall).not.toBeNull();
		const body = deployCall![0];

		// build: must reference the coerced request value, not a literal false --
		// `build: false` would match `build:` alone, so anchor on the variable name.
		expect(body).toMatch(/build:\s*buildOpt/);
		// pullPolicy must be conditional on the request's pull flag, not omitted or a
		// hardcoded 'always'/undefined -- the ternary is the actual translation from
		// deployOptions.pull (boolean) to deployStack's pullPolicy (string | undefined).
		expect(body).toMatch(/pullPolicy:\s*pullOpt\s*\?\s*'always'\s*:\s*undefined/);
		expect(body).toMatch(/forceRecreate:\s*forceRecreateOpt/);
	});

	test('buildOpt/pullOpt/forceRecreateOpt are coerced booleans of the destructured request fields, not the raw (possibly undefined/truthy-string) body values', async () => {
		const source = await readRoute();
		expect(source).toMatch(/const\s+pullOpt\s*=\s*!!pull;/);
		expect(source).toMatch(/const\s+buildOpt\s*=\s*!!build;/);
		expect(source).toMatch(/const\s+forceRecreateOpt\s*=\s*!!forceRecreate;/);
	});

	test('the run recorder options match what deployStack is actually called with -- the same three variables, not separately hardcoded values that could drift from the deploy call', async () => {
		const source = await readRoute();
		const recorderCall = source.match(/options:\s*\{\s*pull:\s*pullOpt,\s*build:\s*buildOpt,\s*forceRecreate:\s*forceRecreateOpt\s*\}/);
		expect(recorderCall).not.toBeNull();
	});
});
