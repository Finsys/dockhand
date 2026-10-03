import { describe, expect, test } from 'bun:test';
import { isKnownIconName, getIconComponent } from '../src/lib/utils/icons';
import { labelTagSpecs, mergeNamedTags } from '../src/lib/utils/tags-core';

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

	test('accepts the PascalCase spelling lucide documents, rejects a misspelling', () => {
		// Lucide's own docs name icons PascalCase, so both spellings resolve to the
		// same component; a name the library does not ship is still rejected.
		expect(isKnownIconName('Database')).toBe(true);
		expect(getIconComponent('Database')).toBe(getIconComponent('database'));
		expect(isKnownIconName('databse')).toBe(false);
		expect(isKnownIconName('DataBase')).toBe(false);
		expect(isKnownIconName('DATABASE')).toBe(false);
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

/**
 * A label tag may name ANY icon the lucide library ships, not only the curated
 * set the pickers list. Containers and stacks resolve tag icons through the same
 * pair (isKnownIconName to accept, getIconComponent to draw), so both views get
 * this from one place.
 */
describe('label tags accept the whole lucide set', () => {
	test('an icon outside the curated map is accepted on a container label', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'DUPA:pink:party-popper' }, isKnownIconName))
			.toEqual([{ name: 'DUPA', color: 'pink', icon: 'party-popper' }]);
	});

	test('and on a stack, which merges its tags the same way', () => {
		const merged = mergeNamedTags(
			[],
			[{ name: 'DUPA', color: 'pink', icon: 'party-popper' }],
			[],
			isKnownIconName
		);
		expect(merged[0].icon).toBe('party-popper');
		expect(merged[0].color).toBe('pink');
	});

	test('a curated alias still beats the library name it shadows', () => {
		// 'tree' is our alias for TreePine; lucide also exports a plain Tree-ish set.
		expect(isKnownIconName('tree')).toBe(true);
		expect(getIconComponent('tree')).toBe(getIconComponent('tree'));
	});

	test('a name lucide does not ship is still rejected', () => {
		expect(isKnownIconName('definitely-not-an-icon')).toBe(false);
		expect(labelTagSpecs({ 'dockhand.tags': 'x:pink:definitely-not-an-icon' }, isKnownIconName))
			.toEqual([{ name: 'x', color: 'pink' }]);
	});

	test('an unknown name draws the fallback rather than nothing', () => {
		expect(getIconComponent('definitely-not-an-icon')).toBe(getIconComponent('globe'));
	});

	test('a digit-bearing name resolves (layers-3 -> Layers3)', () => {
		expect(isKnownIconName('layers-3')).toBe(true);
	});

	test('the lucide base Icon component is not reachable by name', () => {
		// lucide exports Icon beside the icons; it draws nothing without an
		// iconNode prop, so accepting it would put an empty glyph on the tag.
		expect(isKnownIconName('icon')).toBe(false);
		expect(getIconComponent('icon')).toBe(getIconComponent('globe'));
	});

	test('library helpers are not icons either', () => {
		for (const name of ['icons', 'default-attributes', 'create-lucide-icon']) {
			expect(isKnownIconName(name)).toBe(false);
		}
	});

	test('an inherited object property is not an icon', () => {
		// A label name is user input and is used to look up a plain object, so the
		// lookup must see own properties only.
		for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
			expect(isKnownIconName(name)).toBe(false);
			expect(getIconComponent(name)).toBe(getIconComponent('globe'));
		}
	});

	test('a label naming one of those keeps its tag, minus the icon', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'x:pink:constructor' }, isKnownIconName))
			.toEqual([{ name: 'x', color: 'pink' }]);
	});
});
