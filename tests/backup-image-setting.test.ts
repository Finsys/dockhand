/**
 * shouldSaveBackupImage decides whether the "Backup helper image" setting is
 * persisted on Save. It must persist ONLY a real change — saving the pre-filled
 * versioned default would pin the DB to that version and defeat the engine's
 * auto-version-tracking across upgrades (see src/lib/utils/backup-image.ts).
 */
import { describe, it, expect } from 'bun:test';
import { shouldSaveBackupImage, syncBackupImageFromStore } from '../src/lib/utils/backup-image';

describe('shouldSaveBackupImage', () => {
	it('does NOT save when the value is unchanged (pre-filled default left as-is)', () => {
		expect(shouldSaveBackupImage('fnsys/dockhand-backup:1.0.38', 'fnsys/dockhand-backup:1.0.38')).toBe(false);
	});

	it('saves when the user typed a different image', () => {
		expect(shouldSaveBackupImage('myregistry/helper:v2', 'fnsys/dockhand-backup:1.0.38')).toBe(true);
	});

	it('saves when the user keeps an existing override untouched? — no, unchanged is unchanged', () => {
		// Field loaded with a saved override; Save without editing → nothing to persist.
		expect(shouldSaveBackupImage('myregistry/helper:v2', 'myregistry/helper:v2')).toBe(false);
	});

	it('treats surrounding whitespace as no change (trim on both sides)', () => {
		expect(shouldSaveBackupImage('  fnsys/dockhand-backup:1.0.38  ', 'fnsys/dockhand-backup:1.0.38')).toBe(false);
	});

	it('detects a real change even when whitespace differs', () => {
		expect(shouldSaveBackupImage('  myregistry/helper:v2  ', 'fnsys/dockhand-backup:1.0.38')).toBe(true);
	});

	it('saves when the user clears the field (empty != non-empty default)', () => {
		// Clearing is a deliberate change — it lets the server fall back to its default.
		expect(shouldSaveBackupImage('', 'fnsys/dockhand-backup:1.0.38')).toBe(true);
	});

	it('does not save empty→empty', () => {
		expect(shouldSaveBackupImage('', '')).toBe(false);
	});

	it('tolerates null/undefined inputs without throwing', () => {
		expect(shouldSaveBackupImage(undefined as unknown as string, '')).toBe(false);
		expect(shouldSaveBackupImage('x', null as unknown as string)).toBe(true);
	});
});

describe('syncBackupImageFromStore', () => {
	it('replaces the pre-load default when the stored setting arrives', () => {
		expect(syncBackupImageFromStore(
			'fnsys/dockhand-backup:1.0.51',
			'fnsys/dockhand-backup:1.0.51',
			'ghcr.io/example/dockhand-backup:test'
		)).toEqual({
			current: 'ghcr.io/example/dockhand-backup:test',
			initial: 'ghcr.io/example/dockhand-backup:test'
		});
	});

	it('does not overwrite an unsaved user edit when the store changes', () => {
		expect(syncBackupImageFromStore(
			'ghcr.io/example/dockhand-backup:new',
			'fnsys/dockhand-backup:1.0.51',
			'ghcr.io/example/dockhand-backup:saved'
		)).toEqual({
			current: 'ghcr.io/example/dockhand-backup:new',
			initial: 'fnsys/dockhand-backup:1.0.51'
		});
	});
});
