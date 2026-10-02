import { describe, test, expect } from 'bun:test';
import { applyOrder } from '../src/lib/utils/apply-order';
import { normalizeTag, matchesTagFilter, normalizeColor, tagGroupDescriptor, compareTagNames, tagHex, TAG_COLORS, MAX_TAG_LENGTH, type Tag } from '../src/lib/utils/tags-core';

describe('normalizeTag', () => {
	test('trims and collapses whitespace', () => {
		expect(normalizeTag('  home   cloud ')).toBe('home cloud');
	});
	test('allows letters, digits and _ - . /', () => {
		expect(normalizeTag('web/proxy')).toBe('web/proxy');
		expect(normalizeTag('v2.0_beta-1')).toBe('v2.0_beta-1');
	});
	test('rejects empty / non-string', () => {
		expect(normalizeTag('')).toBeNull();
		expect(normalizeTag('   ')).toBeNull();
		expect(normalizeTag(null)).toBeNull();
		expect(normalizeTag(42)).toBeNull();
	});
	test('rejects illegal characters', () => {
		for (const bad of ['a,b', 'a;b', 'a:b', 'a=b', 'a`b', 'a$b', 'a\tb'.replace('\t', '')]) {
			expect(normalizeTag(bad)).toBeNull();
		}
	});
	test('rejects an over-long tag', () => {
		expect(normalizeTag('a'.repeat(MAX_TAG_LENGTH + 1))).toBeNull();
		expect(normalizeTag('a'.repeat(MAX_TAG_LENGTH))).toBe('a'.repeat(MAX_TAG_LENGTH));
	});
});

describe('tagGroupDescriptor', () => {
	const mk = (id: number, name: string, color = 'blue', icon: string | null = null): Tag => ({ id, name, color, icon });

	/** Group order follows the user's arrangement of the tag catalogue. */
	describe('order weight', () => {
		const prod = mk(1, 'prod');
		const test_ = mk(2, 'test');
		const devel = mk(3, 'devel');

		/** Weights are opaque; what matters is the order they produce. */
		const rank = (groups: Tag[][], order: number[] = []) =>
			groups
				.map((g) => ({ label: tagGroupDescriptor(g, order)!.label, w: tagGroupDescriptor(g, order)!.order }))
				.sort((a, b) => a.w - b.w || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
				.map((g) => g.label);

		test('with no arrangement, fewer tags first then alphabetical - unchanged', () => {
			expect(rank([[test_], [prod, test_], [prod]])).toEqual(['prod', 'test', 'prod + test']);
		});

		test('a group sits where its highest-placed tag sits', () => {
			// The user put prod first, then devel, then test.
			expect(rank([[test_], [devel], [prod]], [1, 3, 2])).toEqual(['prod', 'devel', 'test']);
		});

		test('pinning prod pulls every group carrying prod forward', () => {
			expect(rank([[devel], [test_, prod]], [1, 3, 2])).toEqual(['prod + test', 'devel']);
		});

		test('the plain tag leads the combinations that merely include it', () => {
			// The tie-break: same best tag, so the smaller group comes first.
			expect(rank([[prod, test_], [prod], [devel, prod]], [1, 2, 3])).toEqual([
				'prod',
				'devel + prod',
				'prod + test'
			]);
		});

		test('a tag the user never arranged ranks after every one they did', () => {
			expect(rank([[test_], [prod]], [1])).toEqual(['prod', 'test']);
		});

		test('an id left over from a deleted tag does not drag the group forward', () => {
			// 99 no longer exists; groups rank by the tags they actually have.
			expect(rank([[prod], [test_]], [99, 2, 1])).toEqual(['test', 'prod']);
		});

		test('groups read the same way the tag list does', () => {
			// The pages resolve the saved order through applyOrder before grouping, so
			// a tag the user never arranged sits in the same place on both.
			const catalogue = [mk(3, 'devel'), mk(7, 'pre-prod'), mk(1, 'prod'), mk(2, 'test')];
			const saved = [1]; // only prod arranged
			const resolved = applyOrder(catalogue, saved, (t) => t.id).map((t) => t.id);
			const list = applyOrder(catalogue, saved, (t) => t.id).map((t) => t.name);
			const groups = catalogue
				.map((t) => ({ label: t.name, w: tagGroupDescriptor([t], resolved)!.order }))
				.sort((a, b) => a.w - b.w || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
				.map((g) => g.label);
			expect(groups).toEqual(list);
		});

		test('the arrangement never changes the key, label or colour', () => {
			const plain = tagGroupDescriptor([prod, test_]);
			const ordered = tagGroupDescriptor([prod, test_], [2, 1]);
			expect(ordered!.key).toBe(plain!.key);
			expect(ordered!.label).toBe(plain!.label);
			expect(ordered!.color).toBe(plain!.color);
		});
	});

	test('untagged -> null (falls into the Untagged bucket)', () => {
		expect(tagGroupDescriptor([])).toBeNull();
	});
	test('single tag: key=id, label=name, colour from that tag', () => {
		const d = tagGroupDescriptor([mk(5, 'prod', 'red')]);
		expect(d).toMatchObject({ key: '5', label: 'prod', color: tagHex('red') });
	});
	test('combination: sorted-id key, label in name order', () => {
		// deliberately unsorted input
		const d = tagGroupDescriptor([mk(9, 'infra'), mk(3, 'prod'), mk(12, 'Db')]);
		expect(d?.key).toBe('3+9+12');
		expect(d?.label).toBe('Db + infra + prod');
	});
	test('colour + icons follow name order', () => {
		const d = tagGroupDescriptor([mk(3, 'prod', 'red', 'lock'), mk(9, 'infra', 'green', 'wrench')]);
		expect(d?.color).toBe(tagHex('green'));       // "infra" sorts first
		expect(d?.icons).toEqual(['wrench', 'lock']);
	});
	test('key ignores input order and names', () => {
		const a = tagGroupDescriptor([mk(2, 'b'), mk(10, 'a')])!;
		const b = tagGroupDescriptor([mk(10, 'a'), mk(2, 'b')])!;
		expect(a.key).toBe('2+10');
		expect(b.key).toBe('2+10');
	});
	test('order weight: fewer tags first, independent of ids', () => {
		const one = tagGroupDescriptor([mk(2, 'a')])!;
		const oneHigher = tagGroupDescriptor([mk(7, 'b')])!;
		const two = tagGroupDescriptor([mk(1, 'a'), mk(2, 'b')])!;
		expect(one.order).toBe(oneHigher.order); // same size -> label decides (groupData)
		expect(oneHigher.order).toBeLessThan(two.order);
	});
});

describe('compareTagNames', () => {
	const mk = (id: number, name: string): Tag => ({ id, name, color: 'blue', icon: null });
	test('case-insensitive alphabetical', () => {
		const names = [mk(1, 'zeta'), mk(2, 'IOT'), mk(3, 'dev'), mk(4, 'Alpha')].sort(compareTagNames).map((t) => t.name);
		expect(names).toEqual(['Alpha', 'dev', 'IOT', 'zeta']);
	});
	test('ties broken by id', () => {
		expect(compareTagNames(mk(5, 'Prod'), mk(2, 'prod'))).toBeGreaterThan(0);
		expect(compareTagNames(mk(2, 'prod'), mk(5, 'Prod'))).toBeLessThan(0);
	});
});

describe('matchesTagFilter', () => {
	test('empty filter matches everything', () => {
		expect(matchesTagFilter([], [])).toBe(true);
		expect(matchesTagFilter(undefined, [])).toBe(true);
		expect(matchesTagFilter([1], [])).toBe(true);
	});
	test('ALL mode (default): item must carry every selected tag id', () => {
		expect(matchesTagFilter([1, 2], [1])).toBe(true);
		expect(matchesTagFilter([1, 2], [1, 2])).toBe(true);
		expect(matchesTagFilter([1], [1, 2])).toBe(false);
		expect(matchesTagFilter([1], [1, 2], 'all')).toBe(false);
	});
	test('ANY mode: item must carry at least one selected tag id', () => {
		expect(matchesTagFilter([1], [1, 2], 'any')).toBe(true);
		expect(matchesTagFilter([3], [1, 2], 'any')).toBe(false);
		expect(matchesTagFilter([2, 3], [1, 2], 'any')).toBe(true);
	});
	test('untagged item with a non-empty filter never matches', () => {
		expect(matchesTagFilter([], [1])).toBe(false);
		expect(matchesTagFilter(undefined, [1])).toBe(false);
	});
});

describe('normalizeColor', () => {
	test('accepts palette colours', () => {
		for (const c of TAG_COLORS) expect(normalizeColor(c)).toBe(c);
	});
	test('defaults unknown/invalid to slate', () => {
		expect(normalizeColor('mauve')).toBe('slate');
		expect(normalizeColor(null)).toBe('slate');
		expect(normalizeColor(42)).toBe('slate');
	});
});
