import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * That the two permission gates are actually wired to the handlers.
 *
 * The rules themselves are covered in general-settings-visibility.test.ts, but a filter
 * that is written and never applied reads exactly like one that works: reverting either
 * handler to its unfiltered form leaves the whole suite green. These endpoints live in
 * SvelteKit route files that reach the database through better-sqlite3, which bun
 * cannot load, so the source is the available instrument.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('general settings are filtered before they are returned', () => {
	const handler = read('../src/routes/api/settings/general/+server.ts');
	// GET only: the POST below it saves the table and already requires settings:edit,
	// so returning the whole thing there is right.
	const GET = handler.slice(
		handler.indexOf('export const GET'),
		handler.indexOf('export const POST')
	);

	test('the response goes through the filter, not straight out', () => {
		expect(GET).toContain('visibleGeneralSettings(settings');
		// `return json(settings)` would hand every operational value to any caller.
		expect(GET).not.toMatch(/return json\(settings\)/);
	});

	test('and the filter is told the caller permission, not a constant', () => {
		// Passing `true` would keep the call and lose the point of it.
		expect(GET).toMatch(/visibleGeneralSettings\(settings,\s*await auth\.can\('settings',\s*'view'\)\)/);
	});
});

describe('the role permission matrix needs permission to read', () => {
	const list = read('../src/routes/api/roles/+server.ts');
	const byId = read('../src/routes/api/roles/[id]/+server.ts');

	const gateOf = (source: string) =>
		source.slice(source.indexOf('export const GET'), source.indexOf('try {'));

	test('the list route checks more than the licence', () => {
		expect(gateOf(list)).toMatch(/auth\.isAdmin[\s\S]{0,80}auth\.can\('users',\s*'view'\)/);
	});

	test('so does the by-id route, which role ids walk one at a time', () => {
		// Sequential ids mean an ungated by-id route rebuilds the list the other one
		// refuses to serve.
		expect(gateOf(byId)).toMatch(/auth\.isAdmin[\s\S]{0,80}auth\.can\('users',\s*'view'\)/);
	});

	test('both still answer during setup, before auth is switched on', () => {
		// Gating on an account that does not exist yet would lock the first admin out
		// of the screens that create one.
		for (const gate of [gateOf(list), gateOf(byId)]) {
			expect(gate).toContain('if (auth.authEnabled)');
		}
	});
});
