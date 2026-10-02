/**
 * applyOrder: lay a saved order over a list, keyed by whatever identifies an item.
 * Shared by the sidebar menu (keyed by href) and the environment list (by id).
 */
import { describe, test, expect } from 'bun:test';
import { applyOrder } from '../src/lib/utils/apply-order';

const byId = (e: { id: number }) => e.id;
const env = (id: number, name = `env${id}`) => ({ id, name });

describe('applyOrder', () => {
	test('an empty order leaves the list as it came', () => {
		const items = [env(1), env(2), env(3)];
		expect(applyOrder(items, [], byId)).toEqual(items);
	});

	test('the saved order wins', () => {
		const items = [env(1), env(2), env(3)];
		expect(applyOrder(items, [3, 1, 2], byId).map(byId)).toEqual([3, 1, 2]);
	});

	test('a repeated id yields the item once, not twice', () => {
		// A keyed {#each} throws on a duplicate key, which would blank the list.
		const items = [env(1), env(2), env(3)];
		const out = applyOrder(items, [2, 2, 1], byId);
		// 3 is absent from the order, so it lands after its neighbour 2.
		expect(out.map(byId)).toEqual([2, 3, 1]);
		expect(out).toHaveLength(3);
		expect(new Set(out).size).toBe(out.length);
	});

	test('an order made entirely of repeats still yields each item once', () => {
		const items = [env(1), env(2)];
		const out = applyOrder(items, [2, 2, 2, 1, 1], byId);
		expect(out.map(byId)).toEqual([2, 1]);
		expect(out).toHaveLength(2);
	});

	test('an id that is no longer in the list is ignored', () => {
		// An environment the user lost access to, or one that was deleted.
		const items = [env(1), env(3)];
		const out = applyOrder(items, [3, 2, 1], byId);
		expect(out.map(byId)).toEqual([3, 1]);
		// No hole where the missing id was: every slot holds a real item.
		expect(out.every((item) => item !== undefined && item !== null)).toBe(true);
		expect(out).toHaveLength(2);
	});

	test('a new item lands next to its neighbour, not at the end', () => {
		// env 2 was added after the order was saved; it followed env 1 in the
		// incoming list, so that is where it belongs.
		const items = [env(1), env(2), env(3)];
		expect(applyOrder(items, [3, 1], byId).map(byId)).toEqual([3, 1, 2]);
	});

	test('items missing from the order keep their incoming positions around it', () => {
		// 1 has no predecessor in the result yet, so it leads; 2 and 3 follow it,
		// and the one saved id keeps the place the saved order gave it.
		const items = [env(1), env(2), env(3), env(4)];
		expect(applyOrder(items, [4], byId).map(byId)).toEqual([1, 2, 3, 4]);
	});

	test('a pinned first environment stays first when a new one appears', () => {
		// The point of the feature: the environment the user put on top keeps the
		// top even after another environment is added.
		const items = [env(1), env(2), env(3), env(4)];
		expect(applyOrder(items, [3, 1, 2], byId).map(byId)[0]).toBe(3);
	});

	test('a new first item stays first', () => {
		const items = [env(1), env(2), env(3)];
		expect(applyOrder(items, [2, 3], byId).map(byId)).toEqual([1, 2, 3]);
	});

	test('the same items come back, never a copy or a gap', () => {
		const items = [env(1), env(2), env(3)];
		const out = applyOrder(items, [2], byId);
		expect(out).toHaveLength(3);
		expect(new Set(out.map(byId))).toEqual(new Set([1, 2, 3]));
		expect(out.every((o) => items.includes(o))).toBe(true);
	});

	test('works on string keys too - the sidebar menu uses href', () => {
		const items = [{ href: '/a' }, { href: '/b' }, { href: '/c' }];
		const order = ['/c', '/a'];
		expect(applyOrder(items, order, (i) => i.href).map((i) => i.href)).toEqual(['/c', '/a', '/b']);
	});

	test('the input list is not mutated', () => {
		const items = [env(1), env(2), env(3)];
		const snapshot = items.map(byId);
		applyOrder(items, [3, 2, 1], byId);
		expect(items.map(byId)).toEqual(snapshot);
	});
});
