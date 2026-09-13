/**
 * A column with defaultVisible:false is hidden by default (user can enable it in
 * grid preferences); every other column stays visible. The stacks 'webhook' column
 * relies on this so it does not clutter the list for users without git webhooks (#845).
 */
import { describe, it, expect } from 'bun:test';
import { getDefaultColumnPreferences, getConfigurableColumns } from '../src/lib/config/grid-columns';

describe('getDefaultColumnPreferences honors defaultVisible', () => {
	it('hides a column marked defaultVisible:false', () => {
		const prefs = getDefaultColumnPreferences('stacks');
		const webhook = prefs.find((p) => p.id === 'webhook');
		expect(webhook).toBeDefined();
		expect(webhook!.visible).toBe(false);
	});

	it('leaves all other configurable columns visible', () => {
		const prefs = getDefaultColumnPreferences('stacks');
		for (const p of prefs) {
			if (p.id === 'webhook') continue;
			expect(p.visible).toBe(true);
		}
	});

	it('the webhook column is configurable (user can toggle it), not fixed', () => {
		const configurable = getConfigurableColumns('stacks').map((c) => c.id);
		expect(configurable).toContain('webhook');
	});
});
