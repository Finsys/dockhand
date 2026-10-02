import { describe, expect, test } from 'bun:test';
import { isKnownIconName } from '../src/lib/utils/icons';
import { labelTagSpecs } from '../src/lib/utils/tags-core';

/**
 * The icon half of the `dockhand.tags` label, against the REAL icon set.
 *
 * tags-core.ts takes the check as an argument so it stays importable by the
 * server; these tests run the actual one, so a drift between what the parser
 * accepts and what a tag chip can draw shows up here.
 */

describe('isKnownIconName', () => {
	test('accepts the names the manual tells people to use', () => {
		for (const name of ['database', 'hard-drive', 'shield-check']) {
			expect(isKnownIconName(name)).toBe(true);
		}
	});

	test('rejects a mis-cased or misspelled name', () => {
		expect(isKnownIconName('Database')).toBe(false);
		expect(isKnownIconName('databse')).toBe(false);
	});

	test('rejects a selfhst reference - tag chips cannot draw one', () => {
		expect(isKnownIconName('selfhst:plex')).toBe(false);
	});
});

describe('a label parsed with the real icon check', () => {
	test('a documented icon is kept', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'backup:cyan:database' }, isKnownIconName))
			.toEqual([{ name: 'backup', color: 'cyan', icon: 'database' }]);
	});

	test('a selfhst reference is dropped, and the tag and colour survive', () => {
		// The manual no longer offers these on tags; a user who tries one gets the
		// tag they asked for, not a placeholder glyph.
		expect(labelTagSpecs({ 'dockhand.tags': 'media:amber:selfhst:plex' }, isKnownIconName))
			.toEqual([{ name: 'media', color: 'amber' }]);
	});

	test('the prefix-only form is dropped whole, not kept as its tail', () => {
		// Splitting on every colon would quietly keep `plex` and draw the fallback.
		expect(labelTagSpecs({ 'dockhand.tags': 'media:selfhst:plex' }, isKnownIconName))
			.toEqual([{ name: 'media' }]);
	});

	test('a typo costs the icon, never the tag', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'backup:cyan:databse' }, isKnownIconName))
			.toEqual([{ name: 'backup', color: 'cyan' }]);
	});
});
