/**
 * Unit tests for backups/reap-core.ts — the pure ownership predicate that decides
 * which orphaned helper containers this installation may reap. Fail-closed on the
 * instance label so a co-located Dockhand's helper on a shared daemon is safe.
 */
import { describe, it, expect } from 'bun:test';
import { isOwnedBackupHelper, INSTANCE_LABEL } from '../../src/lib/server/backups/reap-core';

const ME = 'inst-me';
const owned = { [INSTANCE_LABEL]: ME };

describe('isOwnedBackupHelper', () => {
	it('matches an owned backup helper', () => {
		expect(isOwnedBackupHelper('dockhand-backup-12', owned, ME)).toBe(true);
	});
	it('matches an owned restore helper', () => {
		expect(isOwnedBackupHelper('dockhand-restore-abc', owned, ME)).toBe(true);
	});
	it('skips a foreign-instance label (never kill another install\'s helper)', () => {
		expect(isOwnedBackupHelper('dockhand-backup-12', { [INSTANCE_LABEL]: 'other' }, ME)).toBe(false);
	});
	it('skips a missing label (fail closed)', () => {
		expect(isOwnedBackupHelper('dockhand-backup-12', {}, ME)).toBe(false);
		expect(isOwnedBackupHelper('dockhand-backup-12', undefined, ME)).toBe(false);
	});
	it('skips a non-helper name even with our label', () => {
		expect(isOwnedBackupHelper('my-web-app', owned, ME)).toBe(false);
		expect(isOwnedBackupHelper('dockhand-volume-helper', owned, ME)).toBe(false);
	});
	it('skips an empty/undefined name', () => {
		expect(isOwnedBackupHelper('', owned, ME)).toBe(false);
		expect(isOwnedBackupHelper(undefined, owned, ME)).toBe(false);
	});
});
