import { describe, expect, test } from 'bun:test';
import { mergeVisibleOrder } from '../src/lib/stores/sidebar-preferences';

/**
 * Saving a sidebar drag.
 *
 * The drag list holds only the entries a user may see, so the ones hidden by
 * permission or licence have to keep their slots when the new order is saved -
 * otherwise an admin's menu loses items the moment a non-admin reorders theirs.
 */

const FULL = ['/', '/containers', '/backups', '/stacks', '/audit', '/settings'];
// What a user without backups or audit-log access actually drags.
const VISIBLE = ['/', '/containers', '/stacks', '/settings'];

describe('mergeVisibleOrder', () => {
	test('an unchanged drag leaves the full order exactly as it was', () => {
		expect(mergeVisibleOrder(FULL, VISIBLE)).toEqual(FULL);
	});

	test('moving a visible item rearranges only the visible slots', () => {
		// Settings dragged to the front of what the user can see.
		const merged = mergeVisibleOrder(FULL, ['/settings', '/', '/containers', '/stacks']);
		expect(merged).toEqual(['/settings', '/', '/backups', '/containers', '/audit', '/stacks']);
	});

	test('entries the drag never saw are still present afterwards', () => {
		const merged = mergeVisibleOrder(FULL, ['/stacks', '/settings', '/', '/containers']);
		expect(merged).toContain('/backups');
		expect(merged).toContain('/audit');
		expect(merged).toHaveLength(FULL.length);
	});

	test('hidden entries keep their position in the list, not just their presence', () => {
		// /backups sits at index 2 and /audit at index 4; a visible-only reshuffle
		// must not slide them, or a later unhide would surface them somewhere new.
		const merged = mergeVisibleOrder(FULL, ['/settings', '/stacks', '/containers', '/']);
		expect(merged.indexOf('/backups')).toBe(2);
		expect(merged.indexOf('/audit')).toBe(4);
	});

	test('nothing is duplicated or lost', () => {
		const merged = mergeVisibleOrder(FULL, ['/settings', '/', '/stacks', '/containers']);
		expect(new Set(merged).size).toBe(merged.length);
		expect([...merged].sort()).toEqual([...FULL].sort());
	});

	test('a user who can see everything reorders the whole list', () => {
		const merged = mergeVisibleOrder(FULL, [...FULL].reverse());
		expect(merged).toEqual([...FULL].reverse());
	});

	test('an empty drag list leaves the order untouched', () => {
		expect(mergeVisibleOrder(FULL, [])).toEqual(FULL);
	});
});
