/**
 * Regression guard: the restore redeploy MUST force-recreate.
 *
 * redeployStackFromDir() is the redeploy-from-restored-snapshot path - its ONLY
 * caller is the backup restore port (backups/index.ts), used by both the in-place
 * and clone restore paths. A restore rewrites the stack dir and swaps the
 * volume data underneath the stack, then this function runs `docker compose up`. A
 * plain `up` sees the unchanged compose and only restarts the container compose
 * thinks is up-to-date, which after an in-place swap can leave it not-yet-running
 * (the source of an intermittent post-restore "stack never came up"). Passing
 * forceRecreate rebuilds the container fresh against the restored state.
 *
 * This asserts at the source level (like tests/deploy-stack-online.test.ts) that the
 * executeComposeCommand('up', ...) inside redeployStackFromDir carries
 * forceRecreate: true - a real daemon isn't needed to prove the invariant, and it
 * survives refactors of the surrounding code.
 */
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stacksSrc = readFileSync(join(here, '..', 'src', 'lib', 'server', 'stacks.ts'), 'utf8');

// The body of redeployStackFromDir, from its declaration to the next top-level
// `export ... function` (paren/brace matching would be overkill - the next export
// is a hard boundary).
function redeployStackFromDirBody(source: string): string {
	const start = source.indexOf('export async function redeployStackFromDir');
	expect(start).toBeGreaterThan(-1);
	const rest = source.slice(start + 1);
	const nextExport = rest.indexOf('\nexport ');
	return rest.slice(0, nextExport === -1 ? undefined : nextExport);
}

describe('restore redeploy force-recreates', () => {
	const body = redeployStackFromDirBody(stacksSrc);

	test('redeployStackFromDir runs an `up`', () => {
		expect(body).toContain("executeComposeCommand(");
		expect(body).toContain("'up'");
	});

	test('redeployStackFromDir passes forceRecreate: true', () => {
		// Whitespace-tolerant: `forceRecreate: true` in the options object.
		expect(body).toMatch(/forceRecreate\s*:\s*true/);
	});

	// A restore loads raw DB secrets; if this path skips the provider-resolution choke
	// point, a secret-marked op://... reaches the container as the literal reference
	// string. Guard the wiring at the source level (a real behavioral test needs a
	// local dev server + a fake provider CLI, which the CI shard can't host): the
	// resolver must be CALLED, its result ASSIGNED BACK to the vars, and it must run
	// BEFORE the deploy - so a refactor that drops the result or reorders the call fails.
	test('redeployStackFromDir resolves provider references and uses the result before deploying', () => {
		const call = body.indexOf('resolveProviderEnvVars(');
		const deploy = body.indexOf('executeComposeCommand(');
		expect(call).toBeGreaterThan(-1);
		expect(deploy).toBeGreaterThan(-1);
		// resolution happens before the compose command runs
		expect(call).toBeLessThan(deploy);
		// the resolved maps are assigned back (result not discarded)
		expect(body).toMatch(/=\s*resolved\.dbNonSecretVars/);
		expect(body).toMatch(/=\s*resolved\.secretVars/);
	});
});
