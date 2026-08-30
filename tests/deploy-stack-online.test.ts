/**
 * Regression guard: every deployStack() call in an API route must pass onLine.
 *
 * The compose output window is fed by 'progress' messages of shape
 * {type:'line', line}. A route that runs deployStack inside createJobResponse but
 * forgets `onLine: (line) => send('progress', { type: 'line', line })` still works
 * — it just shows the user an empty output window until the job settles. Nothing
 * fails, so the omission is invisible: POST /api/stacks (create & start) and
 * PUT /api/stacks/{name}/compose (save & redeploy) both shipped without it while
 * the five stack-row actions had it.
 *
 * deployStack talks to the Docker socket and the DB, so we can't drive these
 * handlers end-to-end here. Instead we assert at the source level that every
 * deployStack call under src/routes/api carries onLine — the same shape of check
 * as tests/encryption-rotation-coverage.test.ts (a list that silently omitted
 * one entry).
 */
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, '..', 'src', 'routes', 'api');

function serverFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...serverFiles(full));
		else if (entry.name === '+server.ts') found.push(full);
	}
	return found;
}

// Returns the text of each deployStack(...) argument list, paren-balanced so a
// nested call or object literal doesn't cut the match short.
function deployStackCalls(source: string): string[] {
	const calls: string[] = [];
	const marker = 'deployStack(';

	for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
		// Skip identifiers that merely end in "deployStack(" (e.g. runRedeployStack().
		const before = source[at - 1];
		if (before && /[A-Za-z0-9_$]/.test(before)) continue;

		let depth = 0;
		for (let i = at + marker.length - 1; i < source.length; i++) {
			if (source[i] === '(') depth++;
			else if (source[i] === ')') {
				depth--;
				if (depth === 0) {
					calls.push(source.slice(at, i + 1));
					break;
				}
			}
		}
	}
	return calls;
}

const callsByFile = new Map<string, string[]>();
for (const file of serverFiles(apiRoot)) {
	const calls = deployStackCalls(readFileSync(file, 'utf8'));
	if (calls.length > 0) callsByFile.set(relative(join(here, '..'), file), calls);
}

describe('API routes stream compose output', () => {
	// Without this the suite would pass vacuously if the scan ever stopped
	// finding anything (renamed directory, changed route layout).
	test('the scan finds the known deployStack routes', () => {
		expect([...callsByFile.keys()].sort()).toEqual([
			'src/routes/api/stacks/+server.ts',
			'src/routes/api/stacks/[name]/compose/+server.ts',
			'src/routes/api/stacks/[name]/deploy/+server.ts'
		]);
	});

	test('every deployStack call passes onLine', () => {
		const missing: string[] = [];
		for (const [file, calls] of callsByFile) {
			for (const call of calls) {
				if (!call.includes('onLine')) missing.push(file);
			}
		}
		expect(missing).toEqual([]);
	});
});
