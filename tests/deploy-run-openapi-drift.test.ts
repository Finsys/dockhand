/**
 * B1 regression: the three single-run deploy routes' @openapi annotations
 * must not claim a response code that never appears literally in the
 * handler's own body -- that is exactly Gate 4 of
 * scripts/generate-openapi.ts's `--check` (statusCodes drift), the CI tor
 * .github/workflows/openapi.yml:49 runs. This file reproduces that one
 * gate's logic directly against these three routes' actual source (via the
 * SAME parseAnnotations/splitMethodBodies/analyzeHandlerBody the generator
 * itself uses), rather than shelling out to the full generator -- which
 * scans and regenerates the ENTIRE route tree and would make this a slow,
 * broad-scoped test for what is a narrow, three-file regression.
 *
 * Before the fix: GET and DELETE .../deploys/{runId} documented resp-400 and
 * resp-404 as `resp-NNN:` lines, and GET .../deploys/{runId}/log documented
 * resp-400 -- but all three of those specific codes are produced by the
 * SHARED loadOwnedDeployRun() helper (deploy-run-access.ts), not by a
 * literal `status: 400` / `error(400)` in the handler's own body text, which
 * is all the generator's static scanner can see. Fixed by moving that
 * information into the `description:` field as prose (the same pattern
 * POST /api/backup/destinations/{id}/task already uses for its own
 * guard-produced codes), which this test also confirms is still readable.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAnnotations, splitMethodBodies, analyzeHandlerBody } from '../scripts/openapi/lib';

const ROUTES: { file: string; methods: ('GET' | 'DELETE')[] }[] = [
	{ file: 'src/routes/api/stacks/[name]/deploys/[runId]/+server.ts', methods: ['GET', 'DELETE'] },
	{ file: 'src/routes/api/stacks/[name]/deploys/[runId]/log/+server.ts', methods: ['GET'] }
];

describe('B1: deploy-run routes have no status-code drift (Gate 4)', () => {
	for (const { file, methods } of ROUTES) {
		const content = readFileSync(join(import.meta.dir, '..', file), 'utf-8');
		const annotations = parseAnnotations(content);
		const bodies = splitMethodBodies(content);

		for (const method of methods) {
			test(`${method} ${file}: every documented response code appears literally in the handler body`, () => {
				const ann = annotations[method];
				const body = bodies[method];
				expect(ann).toBeDefined();
				expect(body).toBeDefined();
				if (!ann || !body) return; // unreachable, satisfies the type checker

				const analysis = analyzeHandlerBody(body);
				const codeCodes = new Set(analysis.statusCodes.filter((c) => c !== '200'));
				const docCodes = Object.keys(ann.responses).filter((c) => c !== '200');

				// This IS Gate 4's own drift condition, reproduced directly: a
				// documented code with no matching status()/error() call in the
				// SAME handler's body text is exactly what turned CI red.
				const stale = docCodes.filter((c) => !codeCodes.has(c));
				expect(stale).toEqual([]);
			});
		}

		test(`${file}: the 400/404 codes loadOwnedDeployRun() produces are still documented, in prose`, () => {
			for (const method of methods) {
				const ann = annotations[method];
				expect(ann?.description).toBeDefined();
				expect(ann!.description).toMatch(/loadOwnedDeployRun/);
			}
		});
	}
});
