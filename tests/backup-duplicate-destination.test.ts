/**
 * pickDuplicateDestinationId: "Duplicate" on a backup schedule should point the copy
 * at a repository the target isn't backed up to yet (e.g. offsite), falling back to
 * the source's own repository when every one is already used (#1578).
 */
import { describe, it, expect } from 'bun:test';
import { pickDuplicateDestinationId, duplicateStartsEnabled } from '../src/lib/utils/backup';

describe('pickDuplicateDestinationId', () => {
	it('picks the first repository with no schedule for this target', () => {
		expect(pickDuplicateDestinationId(1, [1, 2, 3], [1])).toBe(2);
	});

	it('skips repositories already used by other schedules of the target', () => {
		expect(pickDuplicateDestinationId(1, [1, 2, 3], [1, 2])).toBe(3);
	});

	it('falls back to the source repository when all are used', () => {
		expect(pickDuplicateDestinationId(2, [1, 2], [1, 2])).toBe(2);
	});

	it('falls back to the source repository when it is the only one', () => {
		expect(pickDuplicateDestinationId(5, [5], [5])).toBe(5);
	});
});

describe('whether a duplicate starts enabled', () => {
	// A manual config is stored disabled because it has no schedule. Its copy exists
	// to be given one, so it starts enabled - otherwise the copy would be saved and
	// then quietly never run.
	it('a copy of a manual config starts enabled', () => {
		expect(duplicateStartsEnabled({ schedule: null, enabled: false })).toBe(true);
		expect(duplicateStartsEnabled({})).toBe(true);
	});

	// Duplicating a schedule somebody paused must not resume it behind their back.
	it('a copy of a scheduled config keeps the original state', () => {
		expect(duplicateStartsEnabled({ schedule: '0 2 * * *', enabled: true })).toBe(true);
		expect(duplicateStartsEnabled({ schedule: '0 2 * * *', enabled: false })).toBe(false);
	});
});
