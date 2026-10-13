import { describe, test, expect } from 'bun:test';
import { filterPalette, rankItem, type PaletteItem } from '../src/lib/utils/palette-filter';

const item = (over: Partial<PaletteItem> & { id: string; group: string; label: string }): PaletteItem => ({
	keywords: '',
	...over
});

describe('rankItem (match tiers)', () => {
	const it = item({ id: '1', group: 'g', label: 'Editor theme', keywords: 'dark colors' });

	test('empty query matches everything at tier 0', () => {
		expect(rankItem(it, '')).toBe(0);
	});
	test('label prefix is tier 0', () => {
		expect(rankItem(it, 'editor')).toBe(0);
	});
	test('word-boundary in label is tier 1', () => {
		expect(rankItem(it, 'theme')).toBe(1); // starts the second word
	});
	test('mid-word substring in label is tier 2', () => {
		expect(rankItem(it, 'dito')).toBe(2);
	});
	test('keyword-only match is tier 3', () => {
		expect(rankItem(it, 'colors')).toBe(3);
	});
	test('no match is -1', () => {
		expect(rankItem(it, 'zzz')).toBe(-1);
	});
	test('case-insensitive (query is pre-lowercased by filterPalette; rankItem assumes lowercase q)', () => {
		expect(rankItem(item({ id: '2', group: 'g', label: 'Dracula', keywords: '' }), 'drac')).toBe(0);
	});

	test('regex special chars in the query are matched literally (escapeRegExp), never as wildcards', () => {
		// a query with regex metachars must not throw and must not act as a pattern
		const gpp = item({ id: 'x', group: 'g', label: 'g++ tool', keywords: '' });
		expect(rankItem(gpp, 'g++')).toBe(0); // prefix, literal '++'
		// a dot must be literal: '1.6' must NOT match 'host 156' (dot != any-char)
		const host = item({ id: 'y', group: 'g', label: 'host 156', keywords: '' });
		expect(rankItem(host, '1.6')).toBe(-1);
		// but a literal dotted string matches
		expect(rankItem(item({ id: 'z', group: 'g', label: 'v1.6.0', keywords: '' }), '1.6')).toBe(2);
	});
});

describe('filterPalette', () => {
	const items: PaletteItem[] = [
		item({ id: 'nav-dash', group: 'Navigation', label: 'Dashboard', keywords: 'home' }),
		item({ id: 'nav-cont', group: 'Navigation', label: 'Containers', keywords: 'docker' }),
		item({ id: 'th-drac', group: 'Theme', label: 'Dracula', keywords: '' }),
		item({ id: 'th-mono', group: 'Theme', label: 'Monokai', keywords: '' }),
		item({ id: 'th-nord', group: 'Theme', label: 'Nord', keywords: '' }),
		item({ id: 'ct-nginx', group: 'Containers', label: 'nginx-proxy', keywords: 'nginx:latest prod' }),
		item({ id: 'ct-db', group: 'Containers', label: 'postgres', keywords: 'postgres:16 prod' })
	];

	test('whitespace-only query behaves as empty', () => {
		expect(filterPalette(items, '   ').length).toBe(items.length);
	});

	test('empty query applies per-group caps', () => {
		const out = filterPalette(items, '', { defaultCaps: { Theme: 2 } });
		const themes = out.filter((i) => i.group === 'Theme');
		expect(themes.length).toBe(2); // capped from 3
		expect(out.filter((i) => i.group === 'Navigation').length).toBe(2); // uncapped
		// cap keeps source order (first two themes)
		expect(themes.map((t) => t.id)).toEqual(['th-drac', 'th-mono']);
	});

	test('results stay grouped in source group order, not globally reshuffled', () => {
		const out = filterPalette(items, 'o'); // matches across groups
		const groups = out.map((i) => i.group);
		// once a group ends it does not reappear
		const seen = new Set<string>();
		let prev = '';
		for (const g of groups) {
			if (g !== prev && seen.has(g)) throw new Error(`group ${g} interleaved`);
			seen.add(g);
			prev = g;
		}
		expect(groups[0]).toBe('Navigation'); // Navigation appears before Theme/Containers
	});

	test('prefix ranks above word-boundary above substring above keyword-only', () => {
		const ranked: PaletteItem[] = [
			item({ id: 'kw', group: 'g', label: 'zzz', keywords: 'alpha' }), // keyword-only
			item({ id: 'sub', group: 'g', label: 'xalphax', keywords: '' }), // substring
			item({ id: 'wb', group: 'g', label: 'x alpha', keywords: '' }), // word-boundary
			item({ id: 'pre', group: 'g', label: 'alpha thing', keywords: '' }) // prefix
		];
		const out = filterPalette(ranked, 'alpha');
		expect(out.map((i) => i.id)).toEqual(['pre', 'wb', 'sub', 'kw']);
	});

	test('keyword/image haystack finds a container by its image tag', () => {
		const out = filterPalette(items, 'nginx:latest');
		expect(out.map((i) => i.id)).toContain('ct-nginx');
	});

	test('case-insensitive matching', () => {
		expect(filterPalette(items, 'DRACULA').map((i) => i.id)).toContain('th-drac');
		expect(filterPalette(items, 'NGINX').map((i) => i.id)).toContain('ct-nginx');
	});

	test('no matches returns empty', () => {
		expect(filterPalette(items, 'zzzznope')).toEqual([]);
	});

	test('stable order within a tier (source order preserved)', () => {
		// all three themes are keyword-less; querying a common substring keeps source order
		const out = filterPalette(items, 'o').filter((i) => i.group === 'Theme');
		expect(out.map((i) => i.id)).toEqual(['th-mono', 'th-nord']); // Monokai, Nord (Dracula has no 'o')
	});
});
