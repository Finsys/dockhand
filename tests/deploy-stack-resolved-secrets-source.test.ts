/**
 * Source guard: deployStack() must record the SAME secret set it redacts against.
 *
 * F4 makes `deployStack()` attach the resolved secret VALUES to its result so the
 * per-route stack_deploy recorder can redact them out of a stored deploy error
 * (deploy-run-record.ts -> RunRecorder.addSecrets -> redactLine). The single
 * production line that carries F4 is, in src/lib/server/stacks.ts:
 *
 *     result.resolvedSecrets = Object.values(secretVars);
 *
 * where `secretVars` is the post-`resolveProviderEnvVars` set that
 * `executeComposeCommand(...)` just redacted the streamed lines against. If that
 * one line is deleted, resolvedSecrets stays undefined and the recorder redacts
 * against nothing -- a provider-resolved secret in a thrown/returned deploy error
 * would be stored in cleartext. A code review demonstrated the gap by mutation:
 * deleting the line left the entire targeted suite green, because the two tests
 * that reference `resolvedSecrets` (git-stack-deploy-run-record.test.ts,
 * stack-compose-redeploy-run-record.test.ts) fake `deployStack` wholesale and
 * hand-set the field in their fixtures -- they prove the DOWNSTREAM wiring, never
 * that the real stacks.ts populates it.
 *
 * WHY THIS IS A SOURCE GUARD AND NOT A BEHAVIOUR TEST (empirically established,
 * not assumed):
 *   1. `tests/helpers/stacks-fake.ts` calls mock.module('$lib/server/stacks', ...)
 *      at import time, which -- per its own doc comment and Bun's single-process
 *      test model -- freezes that specifier's exports for the ENTIRE run. Two
 *      existing suites import it, so in a full `bun test` run `import { deployStack }`
 *      resolves to the fake dispatcher, never the real function. There is no
 *      per-file process isolation in Bun to escape this.
 *   2. Independently: pulling the real `$lib/server/stacks` into a test's import
 *      graph evaluates a module chain that instantiates `better-sqlite3`, which
 *      Bun does not support ("'better-sqlite3' is not yet supported in Bun") and
 *      crashes at load. Reproduced twice while investigating this fix.
 * Either blocker alone makes a real-`deployStack` behaviour test impossible here;
 * that is why the whole suite fakes deployStack and guards its internal invariants
 * at the source level (see deploy-stack-online.test.ts, stack-create-start-build-
 * options.test.ts). This guard follows that established pattern.
 *
 * WHAT THIS GUARD CANNOT PROVE (honest limits of source matching): it matches
 * TEXT, so it cannot prove `secretVars` is populated correctly at runtime (covered
 * by resolveProviderEnvVars' own tests and the redaction tests), and a matching
 * string inside a comment would satisfy it -- so comments are stripped before
 * matching. It proves only the wiring: the derivation of `secretVars`, its use as
 * the executeComposeCommand secret argument, and its assignment to resolvedSecrets.
 */
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stacksPath = join(here, '..', 'src', 'lib', 'server', 'stacks.ts');

// Strip // line comments and /* */ block comments so a matching string inside a
// comment cannot satisfy the guard (the trap called out in test-coverage-pflicht).
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // avoid eating "http://" etc. (rare here)
}

// Extract the brace-balanced body of `export async function deployStack(...) { ... }`.
function deployStackBody(src: string): string {
	const sig = src.indexOf('export async function deployStack(');
	if (sig === -1) return '';
	const open = src.indexOf('{', sig);
	if (open === -1) return '';
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	return '';
}

const raw = readFileSync(stacksPath, 'utf8');
const body = stripComments(deployStackBody(raw));

describe('deployStack records the secret set it redacts against (F4 source guard)', () => {
	// Vacuity guard: if the function can no longer be located, every assertion
	// below would pass on an empty string. Fail loudly instead.
	test('the deployStack body is located and non-trivial', () => {
		expect(body.length).toBeGreaterThan(500);
	});

	test('secretVars is derived from resolveProviderEnvVars (the redaction input)', () => {
		const ok = /\bsecretVars\b[\s\S]{0,80}=\s*await\s+resolveProviderEnvVars\s*\(/.test(body);
		expect(ok, `${stacksPath}: deployStack no longer derives \`secretVars\` from ` +
			`\`await resolveProviderEnvVars(...)\`. F4 records exactly the set that was ` +
			`redacted; if the derivation changed, update this guard AND confirm the recorder ` +
			`still receives the redacted set.`).toBe(true);
	});

	test('the same secretVars is passed to executeComposeCommand as its secret argument', () => {
		const call = body.match(/executeComposeCommand\(([\s\S]*?)\n\t*\);/);
		expect(call, `${stacksPath}: could not find the executeComposeCommand(...) call in ` +
			`deployStack -- the F4 guard cannot verify the redaction/record share \`secretVars\`.`).toBeTruthy();
		expect(/\bsecretVars\b/.test(call ? call[1] : ''),
			`${stacksPath}: deployStack's executeComposeCommand(...) call no longer passes ` +
			`\`secretVars\` as the secret argument. The recorded set (result.resolvedSecrets) ` +
			`must be the SAME set the compose lines were redacted against.`).toBe(true);
	});

	test('result.resolvedSecrets is assigned Object.values(secretVars) (the F4 line)', () => {
		const ok = /result\.resolvedSecrets\s*=\s*Object\.values\(\s*secretVars\s*\)/.test(body);
		expect(ok, `${stacksPath}: the F4 line \`result.resolvedSecrets = Object.values(secretVars)\` ` +
			`is gone from deployStack. Without it the stack_deploy recorder redacts against nothing ` +
			`and a provider-resolved secret can be stored in a deploy error in cleartext. If you ` +
			`intentionally moved this wiring, update this guard to match the new location.`).toBe(true);
	});
});
