/**
 * Unit tests for the pure saved-vs-deployed status helper (src/lib/utils/stack-history).
 *
 * The helper is pure (no DB / better-sqlite3 imports) so it loads cleanly under
 * bun test. Timestamps are ISO-8601 strings; versions arrive newest-first (the S04
 * /api/stacks/[name]/history response shape).
 *
 * Also hosts the P3 source-level guard (PR #1548 review point 3): the
 * internal-default compose sentinel in src/lib/server/stacks.ts must classify via
 * the four-filename helper, not a hardcoded `compose.yaml` join.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { historyStatus, type StackVersionRef } from '../src/lib/utils/stack-history';

const v = (id: string, timestamp: string): StackVersionRef => ({ id, timestamp });

describe('historyStatus', () => {
	it('returns empty for an empty version list', () => {
		expect(historyStatus([], '2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z')).toEqual({
			state: 'empty',
			deployedVersionId: null,
			undeployedCount: 0
		});
	});

	it('is never-deployed when lastDeployedAt is null (every version undeployed)', () => {
		expect(historyStatus([v('v2', '2026-01-02T00:00:00Z'), v('v1', '2026-01-01T00:00:00Z')], '2026-01-02T00:00:00Z', null)).toEqual({
			state: 'never-deployed',
			deployedVersionId: null,
			undeployedCount: 2
		});
	});

	it('is in-sync when the newest saved version is at-or-before the last deploy', () => {
		expect(historyStatus([v('v3', '2026-01-03T00:00:00Z'), v('v2', '2026-01-02T00:00:00Z')], '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z')).toEqual({
			state: 'in-sync',
			deployedVersionId: 'v3',
			undeployedCount: 0
		});
	});

	it('marks the newest-at-or-before-deploy version as deployed and counts versions after deploy', () => {
		// v3 (01-05) is after deploy (01-04) -> undeployed; v2 (01-04) is the newest at-or-before.
		expect(
			historyStatus(
				[v('v3', '2026-01-05T00:00:00Z'), v('v2', '2026-01-04T00:00:00Z'), v('v1', '2026-01-03T00:00:00Z')],
				'2026-01-05T00:00:00Z',
				'2026-01-04T00:00:00Z'
			)
		).toEqual({ state: 'undeployed', deployedVersionId: 'v2', undeployedCount: 1 });
	});

	it('counts multiple versions saved since deploy', () => {
		// All three are after deploy (01-02) -> undeployedCount 3, no deployed marker.
		expect(
			historyStatus(
				[v('v3', '2026-01-05T00:00:00Z'), v('v2', '2026-01-04T00:00:00Z'), v('v1', '2026-01-03T00:00:00Z')],
				'2026-01-05T00:00:00Z',
				'2026-01-02T00:00:00Z'
			)
		).toEqual({ state: 'undeployed', deployedVersionId: null, undeployedCount: 3 });
	});

	it('basic undeployed: one version after deploy, deployed marker is the newest at-or-before', () => {
		expect(
			historyStatus([v('v2', '2026-01-02T00:00:00Z'), v('v1', '2026-01-01T00:00:00Z')], '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')
		).toEqual({ state: 'undeployed', deployedVersionId: 'v1', undeployedCount: 1 });
	});

	it('on equal timestamps at-or-before deploy, picks the first-seen (newer) version', () => {
		// Both share the deploy timestamp; newest-first list -> first-seen is preferred.
		expect(
			historyStatus(
				[v('newer', '2026-01-04T00:00:00Z'), v('older', '2026-01-04T00:00:00Z')],
				'2026-01-04T00:00:00Z',
				'2026-01-04T00:00:00Z'
			)
		).toEqual({ state: 'in-sync', deployedVersionId: 'newer', undeployedCount: 0 });
	});

	it('skips versions with an unparseable timestamp for comparison', () => {
		// 'not-a-date' is ignored; only v1 (01-01) is at-or-before deploy (01-01).
		expect(
			historyStatus([v('bad', 'not-a-date'), v('v1', '2026-01-01T00:00:00Z')], '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
		).toEqual({ state: 'in-sync', deployedVersionId: 'v1', undeployedCount: 0 });
	});
});

describe('historyStatus - external-deploy detection (deployStartedAt runtime reference)', () => {
	it('infers the deployed version from deployStartedAt when the pointer is null', () => {
		// Stack deployed outside Dockhand: versions v1 (01-01) and v2 (01-02) saved,
		// containers created at 01-03 -> v2 was live when deployed.
		expect(
			historyStatus(
				[v('v2', '2026-01-02T00:00:00Z'), v('v1', '2026-01-01T00:00:00Z')],
				'2026-01-02T00:00:00Z',
				null,
				'2026-01-03T00:00:00Z'
			)
		).toEqual({ state: 'in-sync', deployedVersionId: 'v2', undeployedCount: 0 });
	});

	it('counts versions saved after the external deploy as undeployed', () => {
		expect(
			historyStatus(
				[v('v3', '2026-01-04T00:00:00Z'), v('v2', '2026-01-02T00:00:00Z')],
				'2026-01-04T00:00:00Z',
				null,
				'2026-01-03T00:00:00Z'
			)
		).toEqual({ state: 'undeployed', deployedVersionId: 'v2', undeployedCount: 1 });
	});

	it('is running-unsaved when every saved version post-dates the external deploy', () => {
		// The running content was never saved as a version.
		expect(
			historyStatus(
				[v('v2', '2026-01-04T00:00:00Z'), v('v1', '2026-01-03T12:00:00Z')],
				'2026-01-04T00:00:00Z',
				null,
				'2026-01-03T00:00:00Z'
			)
		).toEqual({ state: 'running-unsaved', deployedVersionId: null, undeployedCount: 2 });
	});

	it('the lastDeployedAt pointer wins over deployStartedAt when both are set', () => {
		expect(
			historyStatus(
				[v('v2', '2026-01-02T00:00:00Z'), v('v1', '2026-01-01T00:00:00Z')],
				'2026-01-02T00:00:00Z',
				'2026-01-02T12:00:00Z',
				'2026-01-05T00:00:00Z'
			)
		).toEqual({ state: 'in-sync', deployedVersionId: 'v2', undeployedCount: 0 });
	});

	it('is never-deployed when neither pointer nor runtime reference exists', () => {
		expect(
			historyStatus(
				[v('v1', '2026-01-01T00:00:00Z')],
				'2026-01-01T00:00:00Z',
				null,
				null
			)
		).toEqual({ state: 'never-deployed', deployedVersionId: null, undeployedCount: 1 });
	});

	it('deployStartedAt defaults to null (back-compat 3-arg call)', () => {
		expect(historyStatus([v('v1', '2026-01-01T00:00:00Z')], '2026-01-01T00:00:00Z', null)).toEqual({
			state: 'never-deployed',
			deployedVersionId: null,
			undeployedCount: 1
		});
	});
});

// =============================================================================
// P3 (source-level guard): saveStackComposeFile classifies the internal default
// via the four-filename helper, not a hardcoded compose.yaml join.
//
// The REAL saveStackComposeFile cannot run under bun test for the same reason
// documented in tests/stack-create-start-build-options.test.ts and
// tests/stack-compose-redeploy-run-record.test.ts: src/lib/server/stacks.ts
// imports $lib/server/db/drizzle, which opens a real better-sqlite3 DB at import
// time, and the $lib/server/stacks specifier is frozen process-wide by
// stacks-fake for the route-level test files. So the route-level behavior is
// proven in tests/stack-history-endpoints.test.ts (real PUT compose route + real
// classification helper + real on-disk versioning core via a production-shape
// mirror), and THIS guard pins the real module itself: a regression that reverts
// the sentinel to `join(internalDir, 'compose.yaml')` (pre-fix: docker-compose.yml
// internals fell through to the unversioned custom-path branch and silently lost
// all history) fails here.
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url));

async function readModule(rel: string): Promise<string> {
	return readFile(join(here, '..', rel), 'utf8');
}

/**
 * Slice the saveStackComposeFile function body out of stacks.ts: from its
 * declaration to the next top-level function/section marker. The self-checks
 * below assert the slice is the RIGHT function (contains both the classification
 * and the versioned save), so a rename/move of the neighbors fails loudly
 * instead of silently asserting against a stale window.
 */
async function saveStackComposeFileSource(): Promise<string> {
	const source = await readModule('src/lib/server/stacks.ts');
	const start = source.indexOf('export async function saveStackComposeFile(');
	if (start === -1) throw new Error('saveStackComposeFile not found in stacks.ts');
	const rest = source.slice(start);
	const end = rest.search(/\n(?:export )?(?:async )?function /s);
	return end === -1 ? rest : rest.slice(0, end);
}

describe('P3 (source-level): stacks.ts save path probes all four compose filenames', () => {
	it('imports isInternalDefaultComposePath from stack-path-utils', async () => {
		const source = await readModule('src/lib/server/stacks.ts');
		expect(source).toMatch(
			/import\s*\{[^}]*\bisInternalDefaultComposePath\b[^}]*\}\s*from\s*'\.\/stack-path-utils'/
		);
	});

	it('saveStackComposeFile classifies the internal default with the four-filename helper (not a hardcoded compose.yaml join)', async () => {
		const fn = await saveStackComposeFileSource();
		// Self-check: the slice really is the save function (classification AND
		// versioned save present), so the assertions below can't pass against a
		// stale/empty window.
		expect(fn).toContain('internalDir');
		expect(fn).toContain('saveStackVersion');

		// The custom-path branch is gated on the four-filename classification
		// (PR #1548 point 3): dirname(composePath) === internal stack dir AND
		// basename in {compose.yaml, compose.yml, docker-compose.yml,
		// docker-compose.yaml} -> versioned save; anything else -> plain write.
		expect(fn).toMatch(/isInternalDefaultComposePath\(\s*composePath\s*,\s*internalDir\s*\)/);

		// The pre-fix hardcoded sentinel is gone: no `internalDefault = internalDir
		// ? join(internalDir, 'compose.yaml') : null` and no
		// `composePath !== internalDefault` equality test may remain.
		expect(fn).not.toMatch(/internalDefault\s*=/);
		expect(fn).not.toMatch(/composePath\s*(!=|===)\s*internalDefault/);
	});

	it('the helper probes exactly the four standard compose filenames', async () => {
		const source = await readModule('src/lib/server/stack-path-utils.ts');
		const match = source.match(/INTERNAL_COMPOSE_FILENAMES\s*=\s*\[([\s\S]*?)\]/);
		expect(match).not.toBeNull();
		const names = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
		expect(names).toEqual(['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']);
	});
});
