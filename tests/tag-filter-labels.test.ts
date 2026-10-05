/**
 * Per-container tag filters for the newer-version check.
 *
 * A container names an exception the global settings cannot express: a repository
 * carrying a legacy tag that sorts high, or date-style build tags beside semver
 * ones. The What's Up Docker spellings are read too, so a migrated install keeps
 * working without re-labelling every container.
 */

import { describe, expect, test } from 'bun:test';
import {
	applyTagFilter,
	hasTagFilter,
	tagFilterFromLabels
} from '../src/lib/server/semver/tag-filter-labels';

describe('reading the labels', () => {
	test('the native label is read', () => {
		const f = tagFilterFromLabels({ 'dockhand.tag.include': '^\\d+\\.\\d+$' });
		expect(f.include?.source).toBe('^\\d+\\.\\d+$');
		expect(f.exclude).toBeUndefined();
	});

	test('the WUD label is read, so a migrated container keeps working', () => {
		const f = tagFilterFromLabels({ 'wud.tag.exclude': '^8\\.1\\.2135$' });
		expect(f.exclude?.source).toBe('^8\\.1\\.2135$');
	});

	test('the slash spelling WUD also accepts is read', () => {
		expect(tagFilterFromLabels({ 'wud/tag.include': 'alpine' }).include?.source).toBe('alpine');
	});

	test('a native label wins over the WUD one', () => {
		const f = tagFilterFromLabels({
			'dockhand.tag.include': 'native',
			'wud.tag.include': 'migrated'
		});
		expect(f.include?.source).toBe('native');
	});

	test('no labels means no filter', () => {
		expect(hasTagFilter(tagFilterFromLabels({}))).toBe(false);
		expect(hasTagFilter(tagFilterFromLabels(null))).toBe(false);
		expect(hasTagFilter(tagFilterFromLabels(undefined))).toBe(false);
	});

	test('a blank value is not a filter', () => {
		// An empty regex matches everything, which would read as "filter present" and
		// change nothing while hiding a typo.
		expect(hasTagFilter(tagFilterFromLabels({ 'dockhand.tag.include': '' }))).toBe(false);
		expect(hasTagFilter(tagFilterFromLabels({ 'dockhand.tag.include': '   ' }))).toBe(false);
		// And the blank must not shadow a real filter in a later key.
		const both = tagFilterFromLabels({ 'dockhand.tag.include': '', 'wud.tag.include': '^3\\.' });
		expect(both.include?.source).toBe('^3\\.');
		expect(applyTagFilter(['3.1.0', '8.1.2135'], both)).toEqual(['3.1.0']);
	});

	test('a value is trimmed, since a compose list item often carries spaces', () => {
		expect(tagFilterFromLabels({ 'dockhand.tag.include': '  ^v\\d  ' }).include?.source).toBe('^v\\d');
	});

	test('an unparseable pattern is ignored, not fatal and not match-nothing', () => {
		// A typo must cost the filter, never the update check for that container.
		const f = tagFilterFromLabels({ 'dockhand.tag.include': '[unclosed' });
		expect(f.include).toBeUndefined();
		expect(hasTagFilter(f)).toBe(false);
	});
});

describe('applying the filters', () => {
	const tags = ['3.1.0', '3.1.1', '3.2.0', '8.1.2135', 'latest', '3.1.0-alpine'];

	test('no filter keeps everything', () => {
		expect(applyTagFilter(tags, {})).toEqual(tags);
	});

	test('include keeps only what matches', () => {
		const f = tagFilterFromLabels({ 'dockhand.tag.include': '^3\\.' });
		expect(applyTagFilter(tags, f)).toEqual(['3.1.0', '3.1.1', '3.2.0', '3.1.0-alpine']);
	});

	test('exclude drops what matches', () => {
		const f = tagFilterFromLabels({ 'dockhand.tag.exclude': '^8\\.1\\.2135$' });
		expect(applyTagFilter(tags, f)).not.toContain('8.1.2135');
		expect(applyTagFilter(tags, f)).toContain('3.2.0');
	});

	test('exclude wins over include when both name a tag', () => {
		// The more specific instruction is the one that removes something.
		const f = tagFilterFromLabels({
			'dockhand.tag.include': '^3\\.',
			'dockhand.tag.exclude': 'alpine'
		});
		expect(applyTagFilter(tags, f)).toEqual(['3.1.0', '3.1.1', '3.2.0']);
	});

	test('the pattern is unanchored, matching what WUD does with the same label', () => {
		// Someone bringing a working wud.tag.include across must get the same
		// candidates, so a bare substring matches mid-tag.
		const f = tagFilterFromLabels({ 'dockhand.tag.include': 'alpine' });
		expect(applyTagFilter(tags, f)).toEqual(['3.1.0-alpine']);
	});

	test('an empty tag list stays empty rather than throwing', () => {
		expect(applyTagFilter([], tagFilterFromLabels({ 'dockhand.tag.include': 'x' }))).toEqual([]);
	});

	test('the reported case: excluding the stale tag leaves the real one', () => {
		const f = tagFilterFromLabels({ 'wud.tag.exclude': '^8\\.' });
		expect(applyTagFilter(['3.1.0', '3.1.1', '8.1.2135'], f)).toEqual(['3.1.0', '3.1.1']);
	});
});

describe('the examples the manual publishes', () => {
	// Documented patterns are a promise. If one stops behaving as the manual says,
	// the manual is wrong and somebody copies a filter that does not work.
	const run = (labels: Record<string, string>, tags: string[]) =>
		applyTagFilter(tags, tagFilterFromLabels(labels));

	test('plain three-part versions only', () => {
		// Three numbers is the whole rule - a date build is also three numbers, which
		// the manual says out loud rather than pretending otherwise.
		expect(run({ 'dockhand.tag.include': '^\\d+\\.\\d+\\.\\d+$' },
			['1.2.3', '6', 'nightly', '1.2.4', '1.2.3-rc1'])).toEqual(['1.2.3', '1.2.4']);
		expect(run({ 'dockhand.tag.include': '^\\d+\\.\\d+\\.\\d+$' },
			['1.2.3', '26.09.20260929'])).toContain('26.09.20260929');
	});

	test('ignore one legacy numbering scheme', () => {
		expect(run({ 'dockhand.tag.exclude': '^8\\.' },
			['3.1.0', '3.1.1', '8.1.2135'])).toEqual(['3.1.0', '3.1.1']);
	});

	test('stay on one variant', () => {
		expect(run({ 'dockhand.tag.include': '-alpine$' },
			['1.2', '1.2-alpine', '1.3-alpine', '1.3-slim']))
			.toEqual(['1.2-alpine', '1.3-alpine']);
	});

	test('skip date-style build tags', () => {
		expect(run({ 'dockhand.tag.exclude': '^\\d{2}\\.\\d{2}\\.\\d{8}$' },
			['26.05.5', '26.09.20260929', '26.06.1'])).toEqual(['26.05.5', '26.06.1']);
	});

	test('never leave a major version', () => {
		expect(run({ 'dockhand.tag.include': '^16\\.' },
			['16.2', '16.15', '17.0'])).toEqual(['16.2', '16.15']);
	});

	test('the compose example: one major line, no prereleases', () => {
		expect(run(
			{ 'dockhand.tag.include': '^16\\.', 'dockhand.tag.exclude': '(rc|beta)' },
			['16.2-alpine', '16.15-alpine', '17.0-alpine', '16.16-rc1']
		)).toEqual(['16.2-alpine', '16.15-alpine']);
	});
});

describe('patterns a filter will not accept', () => {
	// The update check walks containers in sequence, so a pattern that backtracks
	// for tens of seconds on one tag stalls the whole sweep and a scheduled run
	// never finishes. JavaScript cannot time a regex out, so the guard is at
	// compile time, shared with dockhand.version.pattern.
	const refused = [
		'(a+)+$',
		'(\\d+)*$',
		'(a|a)+$',
		'([a-z]+)+$',
		'(x*)*y',
		// The brace form backtracks identically and must not slip past because the
		// guard only spelled the outer quantifier as + or *.
		'(a+){1,}$',
		'(a+){2,}$',
		'(\\d+){1,}$',
		'(a|a){1,}$',
		'(a{1,}){1,}$',
		// No groups at all: a chain of bounded repetitions backtracks just as badly,
		// which is why the count matters and not only the shape.
		'a{1,9}'.repeat(10) + '!',
		'a?'.repeat(20) + 'b'
	];

	for (const pattern of refused) {
		test(`refuses the backtracking shape ${pattern}`, () => {
			expect(hasTagFilter(tagFilterFromLabels({ 'dockhand.tag.include': pattern }))).toBe(false);
		});
	}

	test('a refused pattern leaves the candidates alone rather than hiding them', () => {
		const f = tagFilterFromLabels({ 'dockhand.tag.include': '(a+)+$' });
		expect(applyTagFilter(['1.2.3', '1.2.4'], f)).toEqual(['1.2.3', '1.2.4']);
	});

	test('a refused pattern completes immediately', () => {
		const started = performance.now();
		applyTagFilter(['a'.repeat(40) + 'b'], tagFilterFromLabels({ 'dockhand.tag.include': '(a+)+$' }));
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test('an over-long pattern is refused', () => {
		expect(hasTagFilter(tagFilterFromLabels({ 'dockhand.tag.include': 'a'.repeat(400) }))).toBe(false);
	});

	test('a WUD placeholder is refused rather than matching nothing', () => {
		// WUD substitutes ${major} before compiling; we do not, so the pattern would
		// compile to something no tag matches and silently offer zero candidates.
		// Refusing degrades to "no filter", which is visible as unchanged behaviour.
		const f = tagFilterFromLabels({ 'wud.tag.include': '^${major}\\.' });
		expect(hasTagFilter(f)).toBe(false);
		expect(applyTagFilter(['16.2', '16.15', '17.0'], f)).toEqual(['16.2', '16.15', '17.0']);
	});

	test('the patterns people actually write still compile', () => {
		const fine = [
			'^\\d+\\.\\d+\\.\\d+$',
			'^8\\.',
			'-alpine$',
			'^\\d{2}\\.\\d{2}\\.\\d{8}$',
			'^16\\.',
			'(rc|beta)',
			'^v?\\d+',
			'alpine|slim',
			// A brace quantifier on a plain character class is ordinary, not risky.
			'^\\d{4}\\.\\d+$'
		];
		for (const pattern of fine) {
			expect(hasTagFilter(tagFilterFromLabels({ 'dockhand.tag.include': pattern }))).toBe(true);
		}
	});
});

describe('every WUD label spelling is read', () => {
	// WUD accepts four prefixes; a container labelled through any of them must not
	// lose its filter just because of which one its author used.
	for (const key of [
		'wud.tag.exclude',
		'wud/tag.exclude',
		'getwud.app/tag.exclude',
		'wud.getwud.io/tag.exclude'
	]) {
		test(`reads ${key}`, () => {
			expect(tagFilterFromLabels({ [key]: '^8\\.' }).exclude?.source).toBe('^8\\.');
		});
	}

	test('the native label still wins over every one of them', () => {
		const f = tagFilterFromLabels({
			'dockhand.tag.include': 'native',
			'wud.tag.include': 'a',
			'getwud.app/tag.include': 'b',
			'wud.getwud.io/tag.include': 'c'
		});
		expect(f.include?.source).toBe('native');
	});
});
