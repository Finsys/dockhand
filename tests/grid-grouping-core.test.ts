import { describe, it, expect } from 'bun:test';
import { groupData, UNGROUPED_KEY, type GroupDescriptor } from '../src/lib/components/data-grid/grouping-core';

interface Row { id: number; combo: string | null; }

// Group by the row's `combo` string; null -> ungrouped.
const by = (r: Row): GroupDescriptor | null =>
	r.combo ? { key: r.combo, label: r.combo, color: '#abc', order: r.combo.length } : null;

describe('groupData', () => {
	it('partitions rows by group key, preserving in-group order', () => {
		const data: Row[] = [
			{ id: 1, combo: 'prod' },
			{ id: 2, combo: 'infra' },
			{ id: 3, combo: 'prod' }
		];
		const groups = groupData(data, by);
		const prod = groups.find((g) => g.key === 'prod')!;
		expect(prod.items.map((r) => r.id)).toEqual([1, 3]); // order preserved
	});

	it('orders groups by `order` weight first', () => {
		const data: Row[] = [
			{ id: 1, combo: 'infra' }, // len 5
			{ id: 2, combo: 'prod' },  // len 4
			{ id: 3, combo: 'db' }     // len 2
		];
		const groups = groupData(data, by);
		expect(groups.map((g) => g.key)).toEqual(['db', 'prod', 'infra']);
	});

	it('places the ungrouped bucket last with the given label', () => {
		const data: Row[] = [
			{ id: 1, combo: null },
			{ id: 2, combo: 'prod' },
			{ id: 3, combo: null }
		];
		const groups = groupData(data, by, 'No tags');
		expect(groups[groups.length - 1].key).toBe(UNGROUPED_KEY);
		expect(groups[groups.length - 1].label).toBe('No tags');
		expect(groups[groups.length - 1].items.map((r) => r.id)).toEqual([1, 3]);
	});

	it('breaks equal order weights by label, case-insensitively', () => {
		// same length -> same order -> label decides, not first appearance (#1625)
		const data: Row[] = [
			{ id: 1, combo: 'ccc' },
			{ id: 2, combo: 'BBB' },
			{ id: 3, combo: 'aaa' },
			{ id: 4, combo: 'ccc' }
		];
		const groups = groupData(data, by).filter((g) => g.key !== UNGROUPED_KEY);
		expect(groups.map((g) => g.key)).toEqual(['aaa', 'BBB', 'ccc']);
	});

	it('falls back to key when order and label tie, regardless of row order', () => {
		const same = (r: Row): GroupDescriptor | null =>
			r.combo ? { key: r.combo, label: 'x', order: 1 } : null;
		const data: Row[] = [
			{ id: 1, combo: 'k2' },
			{ id: 2, combo: 'k1' }
		];
		expect(groupData(data, same).map((g) => g.key)).toEqual(['k1', 'k2']);
		expect(groupData([...data].reverse(), same).map((g) => g.key)).toEqual(['k1', 'k2']);
	});

	it('carries color and icons from the descriptor', () => {
		const data: Row[] = [{ id: 1, combo: 'prod' }];
		const withIcons = (r: Row): GroupDescriptor | null =>
			r.combo ? { key: r.combo, label: r.combo, color: '#f00', icons: ['shield', null] } : null;
		const [g] = groupData(data, withIcons);
		expect(g.color).toBe('#f00');
		expect(g.icons).toEqual(['shield', null]);
	});

	it('returns an empty array for empty data', () => {
		expect(groupData([], by)).toEqual([]);
	});

	it('every input row lands in exactly one group', () => {
		const data: Row[] = Array.from({ length: 50 }, (_, i) => ({
			id: i,
			combo: i % 3 === 0 ? null : `g${i % 4}`
		}));
		const groups = groupData(data, by);
		const total = groups.reduce((n, g) => n + g.items.length, 0);
		expect(total).toBe(50);
	});
});
