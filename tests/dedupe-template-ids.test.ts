import { describe, test, expect } from 'bun:test';
import { dedupeTemplateIds } from '../src/lib/utils/template-dedupe';

describe('dedupeTemplateIds', () => {
	test('leaves already-unique ids unchanged', () => {
		const out = dedupeTemplateIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
		expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c']);
	});

	test('suffixes duplicates so every id is unique', () => {
		const out = dedupeTemplateIds([{ id: 'x' }, { id: 'x' }, { id: 'x' }]);
		expect(out.map((t) => t.id)).toEqual(['x', 'x-1', 'x-2']);
		expect(new Set(out.map((t) => t.id)).size).toBe(3);
	});

	test('no id collides across a mixed list', () => {
		const out = dedupeTemplateIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'a' }, { id: 'b' }]);
		expect(new Set(out.map((t) => t.id)).size).toBe(out.length);
	});

	test('empty list is fine', () => {
		expect(dedupeTemplateIds([])).toEqual([]);
	});
});
