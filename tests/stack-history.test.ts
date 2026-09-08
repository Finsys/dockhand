/**
 * Unit tests for the pure saved-vs-deployed status helper (src/lib/utils/stack-history).
 *
 * The helper is pure (no DB / better-sqlite3 imports) so it loads cleanly under
 * bun test. Timestamps are ISO-8601 strings; versions arrive newest-first (the S04
 * /api/stacks/[name]/history response shape).
 */
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
