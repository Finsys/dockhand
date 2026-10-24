/**
 * The headline of a manual update check that found nothing to update: failed checks
 * must never read as "all up to date".
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { noUpdatesOutcome, checkableCounts, resultsInScope, summarizeCheck } from '../src/lib/utils/update-check-outcome';

describe('noUpdatesOutcome', () => {
	test('every checkable container failed: the check failed, no "Latest" state', () => {
		expect(noUpdatesOutcome(3, 3, 0)).toEqual({ status: 'error', headline: 'all-failed' });
		expect(noUpdatesOutcome(1, 1, 0)).toEqual({ status: 'error', headline: 'all-failed' });
	});

	test('every check failing outranks held updates', () => {
		expect(noUpdatesOutcome(2, 2, 1)).toEqual({ status: 'error', headline: 'all-failed' });
	});

	test('some failed: only the rest are known to be current', () => {
		expect(noUpdatesOutcome(1, 3, 0)).toEqual({ status: 'none', headline: 'rest-current' });
	});

	test('nothing failed: all current', () => {
		expect(noUpdatesOutcome(0, 3, 0)).toEqual({ status: 'none', headline: 'all-current' });
		expect(noUpdatesOutcome(0, 0, 0)).toEqual({ status: 'none', headline: 'all-current' });
	});

	test('held updates headline a partial failure', () => {
		expect(noUpdatesOutcome(1, 3, 2)).toEqual({ status: 'none', headline: 'cooling-down' });
	});
});

describe('checkableCounts', () => {
	test('a failed system container does not count against healthy user containers', () => {
		const counts = checkableCounts([
			{ systemContainer: 'hawser', error: 'Rate limited by registry (429)', hasUpdate: false },
			{ hasUpdate: false }
		]);
		expect(counts).toEqual({ checkable: 1, failed: 0 });
		expect(noUpdatesOutcome(counts.failed, counts.checkable, 0)).toEqual({ status: 'none', headline: 'all-current' });
	});

	test('update-disabled and local images are neither checkable nor failed', () => {
		expect(checkableCounts([
			{ updateDisabled: true, error: 'x' },
			{ isLocalImage: true, error: 'x' },
			{ error: 'Registry returned 404', hasUpdate: false }
		])).toEqual({ checkable: 1, failed: 1 });
	});

	test('an error next to a found update is not a failure', () => {
		expect(checkableCounts([{ error: 'x', hasUpdate: true }])).toEqual({ checkable: 1, failed: 0 });
	});
});

describe('resultsInScope', () => {
	const results = [
		{ containerId: 'stack-web', hasUpdate: false },
		{ containerId: 'standalone', hasUpdate: true },
		{ containerId: 'stack-db', hasUpdate: true }
	];

	test('the stacks page counts only the containers of its stacks', () => {
		const inScope = resultsInScope(results, new Set(['stack-web', 'stack-db']));
		expect(inScope.map((r) => r.containerId)).toEqual(['stack-web', 'stack-db']);
		expect(inScope.filter((r) => r.hasUpdate)).toHaveLength(1);
	});

	test('no scope keeps every result; an empty scope keeps none', () => {
		expect(resultsInScope(results)).toBe(results);
		expect(resultsInScope(results, new Set())).toEqual([]);
	});
});

describe('summarizeCheck', () => {
	const r = (containerId: string, flags: Record<string, unknown> = {}) => ({ containerId, containerName: containerId, imageName: `${containerId}:1`, ...flags });
	const results = [
		r('standalone', { hasUpdate: true }),
		r('stack-app', { hasUpdate: true }),
		r('stack-pinned', { hasUpdate: true, pinnedToDigest: true, newDigest: 'sha256:new' }),
		r('stack-failed', { error: 'manifest unknown' }),
		r('stack-held', { releaseAgeRemainingHours: 5 }),
		r('stack-semver', { newerVersion: { tag: '2.0' } }),
		r('stack-dockhand', { hasUpdate: true, systemContainer: 'dockhand' })
	];
	const stack = new Set(results.map((x) => x.containerId).filter((id) => id !== 'standalone'));

	test('the stacks page sees only its stacks: a standalone update counts nowhere', () => {
		const s = summarizeCheck(results, stack);
		expect(s.withUpdates.map((x) => x.containerId)).toEqual(['stack-app']);
		expect(s.pinned.map((x) => x.containerId)).toEqual(['stack-pinned']);
		expect(s.failed.map((x) => x.containerId)).toEqual(['stack-failed']);
		expect(s.deferred.map((x) => x.containerId)).toEqual(['stack-held']);
		expect(s.newerVersions.map((x) => x.containerId)).toEqual(['stack-semver']);
		expect(s.counts).toEqual({ checkable: 5, failed: 1 });
	});

	test('the containers page, with no scope, counts the standalone update too', () => {
		expect(summarizeCheck(results).withUpdates.map((x) => x.containerId)).toEqual(['standalone', 'stack-app']);
	});

	test('a pinned digest move is reported apart from the updates a bulk update acts on', () => {
		const s = summarizeCheck([r('a', { hasUpdate: true, pinnedToDigest: true, newDigest: 'sha256:n' })]);
		expect(s.withUpdates).toEqual([]);
		expect(s.pinned).toEqual([{ containerId: 'a', containerName: 'a', imageName: 'a:1', newDigest: 'sha256:n' }]);
	});

	test('system containers, disabled updates and local images are not applicable updates', () => {
		const s = summarizeCheck([
			r('dh', { hasUpdate: true, systemContainer: 'dockhand' }),
			r('off', { hasUpdate: true, updateDisabled: true }),
			r('local', { hasUpdate: true, isLocalImage: true })
		]);
		expect(s.withUpdates).toEqual([]);
	});
});

// A .svelte file cannot be imported under bun, so this only pins that the scope is
// spelled through to the check; the result itself was verified in the browser.
describe('the stacks page hands its scope to the check', () => {
	const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

	test('the button summarizes within the scope it is given', () => {
		expect(read('../src/lib/components/CheckUpdatesButton.svelte')).toMatch(/summarizeCheck\([^)]*, containerIds\)/);
	});

	test('the stacks page passes the containers of its stacks', () => {
		const page = read('../src/routes/stacks/+page.svelte');
		// While the list loads there is no scope yet, so the check counts every container.
		expect(page).toContain('containerIds={loading ? undefined : stackContainerIds}');
		expect(page).toMatch(/stackContainerIds = \$derived\(new Set\(stacks\.flatMap\(\(s\) => \(s\.containerDetails/);
	});
});
