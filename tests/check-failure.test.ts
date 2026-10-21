import { describe, test, expect } from 'bun:test';
import { groupFailuresByMessage } from '../src/lib/utils/check-failure';

describe('groupFailuresByMessage', () => {
	test('containers with the same message share one group, in order of first appearance', () => {
		const groups = groupFailuresByMessage([
			{ containerName: 'a', error: 'Registry returned 404' },
			{ containerName: 'b', error: 'Registry denied access (401)' },
			{ containerName: 'c', error: 'Registry returned 404' }
		]);
		expect(groups.map((g) => ({ error: g.error, names: g.items.map((i) => i.containerName) }))).toEqual([
			{ error: 'Registry returned 404', names: ['a', 'c'] },
			{ error: 'Registry denied access (401)', names: ['b'] }
		]);
	});

	test('messages that differ only slightly stay separate', () => {
		const groups = groupFailuresByMessage([
			{ containerName: 'a', error: 'Registry denied access (401)' },
			{ containerName: 'b', error: 'Registry denied access (403)' }
		]);
		expect(groups.map((g) => g.items.map((i) => i.containerName))).toEqual([['a'], ['b']]);
	});

	test('each item is carried whole, so its image is there to draw its icon', () => {
		const item = { containerName: 'a', imageName: 'nginx:alpine', error: 'x' };
		expect(groupFailuresByMessage([item])[0].items[0]).toBe(item);
	});

	test('no failures, no groups', () => {
		expect(groupFailuresByMessage([])).toEqual([]);
	});
});
