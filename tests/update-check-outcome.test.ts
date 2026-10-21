/**
 * The headline of a manual update check that found nothing to update: failed checks
 * must never read as "all up to date".
 */
import { describe, test, expect } from 'bun:test';
import { noUpdatesOutcome, checkableCounts } from '../src/lib/utils/update-check-outcome';

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
