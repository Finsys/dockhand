import { describe, expect, test } from 'bun:test';
import {
	labelTagNames,
	labelTagSpecs,
	labelTagId,
	filterTagList,
	mergeLabelTags,
	mergeNamedTags,
	matchesTagFilter,
	prunedTagFilter,
	stackLabelTags,
	withStackTags,
	type Tag
} from '../src/lib/utils/tags-core';

/**
 * Tags a container names in its own `dockhand.tags` label.
 *
 * Read where containers are listed rather than written on deploy, so a container
 * Dockhand never deployed - started by `docker run`, or by compose from a
 * terminal - carries its tags just the same.
 */

const PROD: Tag = { id: 4, name: 'prod', color: 'orange', icon: 'laptop' };
const DEVEL: Tag = { id: 6, name: 'devel', color: 'forest', icon: null };
const CATALOG = [PROD, DEVEL];

describe('labelTagNames', () => {
	test('reads a comma-separated list in the order written', () => {
		expect(labelTagNames({ 'dockhand.tags': 'prod,web,db' })).toEqual(['prod', 'web', 'db']);
	});

	test('tolerates the spacing people actually write', () => {
		expect(labelTagNames({ 'dockhand.tags': ' prod , web ' })).toEqual(['prod', 'web']);
		expect(labelTagNames({ 'dockhand.tags': 'prod,  web,   db' })).toEqual(['prod', 'web', 'db']);
		expect(labelTagNames({ 'dockhand.tags': 'prod , , web' })).toEqual(['prod', 'web']);
		expect(labelTagNames({ 'dockhand.tags': 'two  words,other' })).toEqual(['two words', 'other']);
	});

	test('survives the whitespace a yaml file can introduce', () => {
		// A folded compose value can carry a newline; a pasted tag a non-breaking space.
		expect(labelTagNames({ 'dockhand.tags': 'prod,\nweb' })).toEqual(['prod', 'web']);
		expect(labelTagNames({ 'dockhand.tags': 'prod,\r\nweb' })).toEqual(['prod', 'web']);
		expect(labelTagNames({ 'dockhand.tags': 'prod,\tweb\t' })).toEqual(['prod', 'web']);
		expect(labelTagNames({ 'dockhand.tags': 'prod, web' })).toEqual(['prod', 'web']);
	});

	test('absent, empty, or all separators: nothing named', () => {
		expect(labelTagNames(undefined)).toEqual([]);
		expect(labelTagNames(null)).toEqual([]);
		expect(labelTagNames({})).toEqual([]);
		expect(labelTagNames({ 'dockhand.tags': '' })).toEqual([]);
		expect(labelTagNames({ 'dockhand.tags': ' , , ' })).toEqual([]);
	});

	test('collapses a repeat the way the catalogue does, case-insensitively', () => {
		expect(labelTagNames({ 'dockhand.tags': 'prod,Prod,PROD' })).toEqual(['prod']);
	});

	test('keeps the valid entries when one is not a usable name', () => {
		const tooLong = 'x'.repeat(33);
		expect(labelTagNames({ 'dockhand.tags': `prod,${tooLong},web` })).toEqual(['prod', 'web']);
	});
});

describe('mergeLabelTags', () => {
	test('a label name matching the catalogue keeps that tag colour and icon', () => {
		// Someone who coloured "prod" orange expects orange, not a default chip.
		const out = mergeLabelTags([], { 'dockhand.tags': 'prod' }, CATALOG);
		expect(out).toEqual([PROD]);
	});

	test('matches the catalogue case-insensitively', () => {
		expect(mergeLabelTags([], { 'dockhand.tags': 'PROD' }, CATALOG)).toEqual([PROD]);
	});

	test('a name with no catalogue entry still shows, with the default look', () => {
		const out = mergeLabelTags([], { 'dockhand.tags': 'adhoc' }, CATALOG);
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe('adhoc');
		expect(out[0].color).toBe('slate');
		// A negative id cannot collide with a stored tag's.
		expect(out[0].id).toBeLessThan(0);
	});

	test('keeps the tags assigned in Dockhand alongside the label ones', () => {
		const out = mergeLabelTags([DEVEL], { 'dockhand.tags': 'prod' }, CATALOG);
		expect(out.map((t) => t.name)).toEqual(['devel', 'prod']);
	});

	test('a label naming a tag already assigned does not duplicate it', () => {
		const out = mergeLabelTags([PROD], { 'dockhand.tags': 'prod' }, CATALOG);
		expect(out).toEqual([PROD]);
	});

	test('a container with no label shows exactly what Dockhand assigned', () => {
		const assigned = [PROD];
		expect(mergeLabelTags(assigned, undefined, CATALOG)).toBe(assigned);
		expect(mergeLabelTags(assigned, {}, CATALOG)).toBe(assigned);
	});

	test('two unknown names get distinct ids', () => {
		const out = mergeLabelTags([], { 'dockhand.tags': 'one,two' }, CATALOG);
		expect(out.map((t) => t.name)).toEqual(['one', 'two']);
		expect(out[0].id).not.toBe(out[1].id);
	});

	test('an empty catalogue still shows every label name', () => {
		const out = mergeLabelTags([], { 'dockhand.tags': 'a,b' }, []);
		expect(out.map((t) => t.name)).toEqual(['a', 'b']);
	});
});

describe('stackLabelTags', () => {
	test('a stack is described by what its services ask for', () => {
		// Compose keeps project-level labels off the containers, so the service
		// labels are all a stack has.
		expect(
			stackLabelTags([{ 'dockhand.tags': 'frontend, prod' }, { 'dockhand.tags': 'prod' }])
				.map((t) => t.name)
		).toEqual(['frontend', 'prod']);
	});

	test('a name two services share appears once', () => {
		expect(
			stackLabelTags([{ 'dockhand.tags': 'prod' }, { 'dockhand.tags': 'PROD' }])
				.map((t) => t.name)
		).toEqual(['prod']);
	});

	test('services without the label contribute nothing', () => {
		expect(stackLabelTags([{}, null, undefined, { 'dockhand.tags': 'solo' }]).map((t) => t.name))
			.toEqual(['solo']);
		expect(stackLabelTags([])).toEqual([]);
		expect(stackLabelTags([{}, null])).toEqual([]);
	});
});

describe('mergeNamedTags', () => {
	test('resolves a name to its catalogue tag, keeping colour and icon', () => {
		expect(mergeNamedTags([], ['prod'], CATALOG)).toEqual([PROD]);
	});

	test('an unknown name still shows, with a negative id', () => {
		const out = mergeNamedTags([], ['adhoc'], CATALOG);
		expect(out[0].name).toBe('adhoc');
		expect(out[0].id).toBeLessThan(0);
	});

	test('nothing named leaves the assigned list untouched', () => {
		const assigned = [PROD];
		expect(mergeNamedTags(assigned, [], CATALOG)).toBe(assigned);
		expect(mergeNamedTags(assigned, undefined, CATALOG)).toBe(assigned);
		expect(mergeNamedTags(assigned, null, CATALOG)).toBe(assigned);
	});
});

describe('the id a label-only tag gets', () => {
	test('two different names never share an id', () => {
		// The filter holds ids: a shared id would make selecting one tag match the
		// other, on a different row entirely.
		const alpha = mergeNamedTags([], ['alpha'], [])[0];
		const beta = mergeNamedTags([], ['beta'], [])[0];
		expect(alpha.id).not.toBe(beta.id);
		// Position has to count, or an anagram would collide.
		expect(labelTagId('web')).not.toBe(labelTagId('ewb'));
	});

	test('the same name gets the same id wherever it appears', () => {
		// First on one row, third on another - still one tag.
		const first = mergeNamedTags([], ['solo'], [])[0];
		const third = mergeNamedTags([], ['a', 'b', 'solo'], [])[2];
		expect(third.name).toBe('solo');
		expect(third.id).toBe(first.id);
	});

	test('filtering by one label tag does not match a row carrying another', () => {
		const alpha = mergeNamedTags([], ['alpha'], []);
		const beta = mergeNamedTags([], ['beta'], []);
		expect(matchesTagFilter(beta.map((t) => t.id), [alpha[0].id], 'any')).toBe(false);
		expect(matchesTagFilter(alpha.map((t) => t.id), [alpha[0].id], 'any')).toBe(true);
	});

	test('stays negative, so it cannot collide with a catalogue id', () => {
		for (const name of ['a', 'prod', 'a-very-long-tag-name', 'Z']) {
			expect(labelTagId(name)).toBeLessThan(0);
		}
	});

	test('is case-insensitive, matching how the catalogue treats names', () => {
		expect(labelTagId('Prod')).toBe(labelTagId('prod'));
		expect(labelTagId('PROD')).toBe(labelTagId('prod'));
	});
});

describe('filterTagList', () => {
	test('offers a tag that only a label names, so it can be filtered by', () => {
		// Without this a label tag is visible on a row but missing from the picker.
		const rows = [mergeNamedTags([], ['adhoc'], CATALOG)];
		const out = filterTagList(CATALOG, rows);
		expect(out.map((t) => t.name)).toEqual(['prod', 'devel', 'adhoc']);
	});

	test('does not list a catalogue tag twice when a label names it too', () => {
		const rows = [mergeNamedTags([], ['prod'], CATALOG)];
		expect(filterTagList(CATALOG, rows)).toHaveLength(CATALOG.length);
	});

	test('dedupes by name, so a label id for a catalogue name is not offered too', () => {
		// A row built against an empty catalogue carries the negative label id for
		// 'prod'; the picker must still offer only the real catalogue tag.
		const row = mergeNamedTags([], ['prod'], []);
		expect(row[0].id).toBe(labelTagId('prod'));
		expect(filterTagList(CATALOG, [row]).map((t) => t.id)).toEqual([4, 6]);
	});

	test('lists a label tag once however many rows carry it', () => {
		const rows = [
			mergeNamedTags([], ['adhoc'], CATALOG),
			mergeNamedTags([], ['adhoc'], CATALOG),
			mergeNamedTags([], ['ADHOC'], CATALOG)
		];
		const extra = filterTagList(CATALOG, rows).filter((t) => t.name.toLowerCase() === 'adhoc');
		expect(extra).toHaveLength(1);
	});

	test('with nothing on screen it is just the catalogue', () => {
		expect(filterTagList(CATALOG, [])).toEqual(CATALOG);
		expect(filterTagList(CATALOG, [[], []])).toEqual(CATALOG);
	});

	test('a label tag it offers really does filter its own row', () => {
		// The picker and the filter must agree: the id offered has to be the id the
		// row carries, or selecting it would match nothing.
		const row = mergeNamedTags([], ['adhoc'], CATALOG);
		const offered = filterTagList(CATALOG, [row]).find((t) => t.name === 'adhoc')!;
		expect(matchesTagFilter(row.map((t) => t.id), [offered.id], 'any')).toBe(true);
	});
});

describe('prunedTagFilter', () => {
	// The pages drop a selected id the picker no longer offers, so a filter can
	// never empty the list with no visible cause. filterTagList is what the picker
	// offers, so it is what the prune is measured against.
	const READY = true;

	test('keeps a label tag while a row still names it', () => {
		const row = mergeNamedTags([], ['adhoc'], CATALOG);
		const offered = filterTagList(CATALOG, [row]);
		const adhoc = labelTagId('adhoc');
		expect(prunedTagFilter([adhoc, 4], offered, READY)).toEqual([adhoc, 4]);
	});

	test('drops a label tag once its last row is gone', () => {
		// The container was deleted: nothing names 'adhoc' any more, so keeping it
		// selected would show an empty grid for no visible reason.
		expect(prunedTagFilter([labelTagId('adhoc')], filterTagList(CATALOG, []), READY)).toEqual([]);
	});

	test('drops a deleted catalogue tag too', () => {
		expect(prunedTagFilter([4, 999], filterTagList(CATALOG, []), READY)).toEqual([4]);
	});

	test('keeps the whole selection while the picker is still loading', () => {
		// A half-built picker offers almost nothing, so measuring against it would
		// drop every valid id - and the pages persist the result immediately.
		const row = mergeNamedTags([], ['adhoc'], CATALOG);
		const halfBuilt = filterTagList([], [row]);
		const saved = [4, 6, labelTagId('adhoc')];
		expect(prunedTagFilter(saved, halfBuilt, false)).toEqual(saved);
	});

	test('an empty catalogue mid-load does not strip the catalogue tags', () => {
		// The rows have arrived but /api/tags has not: a catalogue tag no row
		// happens to carry is still valid and must survive.
		const row = mergeNamedTags([], ['adhoc'], CATALOG);
		expect(prunedTagFilter([4, 6], filterTagList([], [row]), false)).toEqual([4, 6]);
	});

	test('returns the same array when nothing is dropped', () => {
		// The pages assign the result to a $state that is persisted on change, so a
		// new array every pass would rewrite localStorage forever.
		const saved = [4];
		expect(prunedTagFilter(saved, filterTagList(CATALOG, []), READY)).toBe(saved);
	});

	test('an empty selection stays empty', () => {
		expect(prunedTagFilter([], filterTagList(CATALOG, []), READY)).toEqual([]);
	});
});

describe('a label spelling out colour and icon', () => {
	test('name alone still works, with the default look', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'prod' })).toEqual([{ name: 'prod' }]);
	});

	test('name:color', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'prod:red' })).toEqual([{ name: 'prod', color: 'red' }]);
	});

	test('name:color:icon', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'backup:cyan:database' }))
			.toEqual([{ name: 'backup', color: 'cyan', icon: 'database' }]);
	});

	test('a colon-bearing icon reaches the check whole, rather than truncated', () => {
		// Splitting on every colon would hand the check `selfhst` and silently keep
		// `plex`; rejoining lets it see the real value and reject it.
		const known = (n: string) => n === 'database';
		expect(labelTagSpecs({ 'dockhand.tags': 'media:amber:selfhst:plex' }, known))
			.toEqual([{ name: 'media', color: 'amber' }]);
		expect(labelTagSpecs({ 'dockhand.tags': 'media:selfhst:plex' }, known))
			.toEqual([{ name: 'media' }]);
	});

	test('a second field that is not a colour is treated as the icon', () => {
		// So `media:selfhst:plex` keeps its prefix instead of losing it to the
		// colour slot. Without an icon check the name is taken at face value.
		expect(labelTagSpecs({ 'dockhand.tags': 'media:selfhst:plex' }))
			.toEqual([{ name: 'media', icon: 'selfhst:plex' }]);
		expect(labelTagSpecs({ 'dockhand.tags': 'prod:rde' })).toEqual([{ name: 'prod', icon: 'rde' }]);
	});

	test('with an icon check, an unknown icon is dropped and the tag survives', () => {
		// A typo costs the icon, never the tag - the promise the manual makes.
		const known = (n: string) => n === 'database';
		expect(labelTagSpecs({ 'dockhand.tags': 'prod:rde' }, known)).toEqual([{ name: 'prod' }]);
		expect(labelTagSpecs({ 'dockhand.tags': 'backup:cyan:databse' }, known))
			.toEqual([{ name: 'backup', color: 'cyan' }]);
		expect(labelTagSpecs({ 'dockhand.tags': 'backup:cyan:Database' }, known))
			.toEqual([{ name: 'backup', color: 'cyan' }]);
		expect(labelTagSpecs({ 'dockhand.tags': 'backup:cyan:database' }, known))
			.toEqual([{ name: 'backup', color: 'cyan', icon: 'database' }]);
	});

	test('a value that is neither a colour nor a known icon leaves a bare tag', () => {
		const known = (n: string) => n === 'database';
		expect(labelTagSpecs({ 'dockhand.tags': 'prod:#ff0000' }, known)).toEqual([{ name: 'prod' }]);
	});

	test('an unusable icon is dropped, the colour survives', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'prod:red:not a valid icon' }))
			.toEqual([{ name: 'prod', color: 'red' }]);
	});

	test('colour matching is case-insensitive and tolerates spacing', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'prod: RED ' })).toEqual([{ name: 'prod', color: 'red' }]);
	});

	test('an icon with no colour works with or without the empty slot', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'prod::database' }))
			.toEqual([{ name: 'prod', icon: 'database' }]);
		expect(labelTagSpecs({ 'dockhand.tags': 'prod:database' }))
			.toEqual([{ name: 'prod', icon: 'database' }]);
	});

	test('mixed entries in one label', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'prod, media:amber, backup:cyan:database' }))
			.toEqual([
				{ name: 'prod' },
				{ name: 'media', color: 'amber' },
				{ name: 'backup', color: 'cyan', icon: 'database' }
			]);
	});

	test('a name containing a slash is unaffected', () => {
		expect(labelTagSpecs({ 'dockhand.tags': 'web/proxy:teal' }))
			.toEqual([{ name: 'web/proxy', color: 'teal' }]);
	});

	test('labelTagNames still returns just the names', () => {
		expect(labelTagNames({ 'dockhand.tags': 'prod:red, media:amber:database' }))
			.toEqual(['prod', 'media']);
	});
});

describe('the catalogue outranks what a label asks for', () => {
	test('a catalogue tag keeps its own colour and icon', () => {
		// PROD is orange with a laptop icon in CATALOG; the label asking for red
		// must not repaint an instance-wide tag.
		const out = mergeLabelTags([], { 'dockhand.tags': 'prod:red:database' }, CATALOG);
		expect(out).toEqual([PROD]);
	});

	test('a tag the catalogue does not know takes the label colour and icon', () => {
		const out = mergeLabelTags([], { 'dockhand.tags': 'adhoc:violet:flask' }, CATALOG);
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe('adhoc');
		expect(out[0].color).toBe('violet');
		expect(out[0].icon).toBe('flask');
		expect(out[0].id).toBeLessThan(0);
	});

	test('an unknown tag with no colour still gets the default look', () => {
		const out = mergeLabelTags([], { 'dockhand.tags': 'adhoc' }, CATALOG);
		expect(out[0].color).toBe('slate');
		expect(out[0].icon).toBeNull();
	});

	test('the colour does not change the id, so filtering still matches', () => {
		// The filter holds ids; two rows spelling the same tag with different
		// colours must still be the same tag.
		const a = mergeLabelTags([], { 'dockhand.tags': 'adhoc:red' }, [])[0];
		const b = mergeLabelTags([], { 'dockhand.tags': 'adhoc:teal' }, [])[0];
		expect(a.id).toBe(b.id);
		// Pin the ACTUAL value: comparing against labelTagId() again moves both
		// sides together, so it cannot tell what the id is derived from. A filter
		// id that changes between releases silently drops saved selections.
		expect(labelTagId('adhoc')).toBe(-92664122);
		expect(labelTagId('ADHOC')).toBe(-92664122);
	});
});

describe('merging specs that were built without an icon check', () => {
	// The server builds a stack's specs and cannot import the icon set, so the
	// check has to run again at merge time or an undrawable name reaches the chip.
	const known = (n: string) => n === 'database';

	test('an unknown icon on a spec is dropped at merge time', () => {
		const out = mergeNamedTags([], [{ name: 'media', color: 'amber', icon: 'selfhst:plex' }], [], known);
		expect(out[0].icon).toBeNull();
		expect(out[0].color).toBe('amber');
	});

	test('a known icon survives the merge', () => {
		const out = mergeNamedTags([], [{ name: 'backup', icon: 'database' }], [], known);
		expect(out[0].icon).toBe('database');
	});

	test('with no check the spec is taken as given', () => {
		const out = mergeNamedTags([], [{ name: 'media', icon: 'whatever' }], []);
		expect(out[0].icon).toBe('whatever');
	});
});

describe('a stack whose services disagree', () => {
	test('the first spelling wins, so listing order cannot repaint the stack', () => {
		const out = stackLabelTags([
			{ 'dockhand.tags': 'media:amber' },
			{ 'dockhand.tags': 'media:teal' }
		]);
		expect(out).toEqual([{ name: 'media', color: 'amber' }]);
	});

	test('colours from different services are all kept', () => {
		expect(stackLabelTags([
			{ 'dockhand.tags': 'web:blue' },
			{ 'dockhand.tags': 'db:forest:database' }
		])).toEqual([
			{ name: 'web', color: 'blue' },
			{ name: 'db', color: 'forest', icon: 'database' }
		]);
	});
});

describe('a container showing its stack tags', () => {
	const MEDIA: Tag = { id: 9, name: 'media', color: 'amber', icon: 'clapperboard' };

	test('a stack tag appears on the container, marked inherited', () => {
		const out = withStackTags([], [MEDIA]);
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe('media');
		expect(out[0].color).toBe('amber');
		expect(out[0].icon).toBe('clapperboard');
		expect(out[0].inherited).toBe(true);
	});

	test('a tag the container already has stays its own, and stays removable', () => {
		// Removing it from the stack must not take away the direct assignment.
		const out = withStackTags([PROD], [PROD]);
		expect(out).toHaveLength(1);
		expect(out[0].inherited).toBeUndefined();
	});

	test('direct and inherited tags sit side by side', () => {
		const out = withStackTags([PROD], [MEDIA]);
		expect(out.map((t) => t.name)).toEqual(['prod', 'media']);
		expect(out[0].inherited).toBeUndefined();
		expect(out[1].inherited).toBe(true);
	});

	test('matching is case-insensitive, like everywhere else', () => {
		const out = withStackTags([{ ...PROD, name: 'PROD' }], [PROD]);
		expect(out).toHaveLength(1);
		expect(out[0].inherited).toBeUndefined();
	});

	test('a stack with no tags changes nothing, and keeps the same array', () => {
		const own = [PROD];
		expect(withStackTags(own, [])).toBe(own);
	});

	test('a container with no tags of its own shows only inherited ones', () => {
		const out = withStackTags([], [PROD, MEDIA]);
		expect(out.every((t) => t.inherited)).toBe(true);
	});

	test('the source tags are not mutated', () => {
		// The inherited flag must live on the copy: the catalogue object is shared
		// across every row, so marking it in place would leak onto the stack page.
		const src = { ...MEDIA };
		withStackTags([], [src]);
		expect(src.inherited).toBeUndefined();
	});
});
