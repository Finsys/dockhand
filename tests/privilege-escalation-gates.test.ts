import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitMethodBodies } from '../scripts/openapi/lib';

// These two handlers import db (better-sqlite3), so they cannot be imported and run
// under bun. The gate each one carries is a privilege-escalation boundary, so pin the
// exact condition at the source level (the env-file-values.test.ts precedent for a
// db-bound call site): a mutation back to the weaker check must fail here.
const read = (p: string) => readFileSync(join(process.cwd(), 'src', 'routes', p), 'utf8');

describe('license mutation is admin-only (A17)', () => {
	// A non-admin holding the delegable license:manage permission must NOT be able to
	// deactivate/replace the license: in free edition that flips every authenticated
	// user to admin. POST and DELETE gate on isAdmin, never on can('license','manage').
	// (GET legitimately uses can('license','manage') to gate showing the redacted key -
	// a read, not a mutation - so scope the assertions to the mutating method bodies.)
	const methods = splitMethodBodies(read('api/license/+server.ts'));

	for (const m of ['POST', 'DELETE'] as const) {
		test(`${m} gates on auth.isAdmin, not license:manage`, () => {
			const body = methods[m];
			expect(body).toBeDefined();
			expect(body!).toContain('!auth.isAdmin');
			expect(body!).not.toContain(`auth.can('license', 'manage')`);
		});
	}
});

describe('first-user auto-admin needs a genuine first run (A48)', () => {
	// POST /api/users auto-assigns Admin and auto-logs-in only on true first-run (no
	// user AND auth still disabled). Keying on hasAdminUser() let an authenticated
	// users:create holder self-grant Admin whenever the instance had zero Admin-role
	// holders while auth stayed enabled.
	const src = read('api/users/+server.ts');

	test('isFirstUser requires auth disabled and no existing user', () => {
		expect(src).toContain('const isFirstUser = !auth.authEnabled && !(await hasAnyUser());');
	});

	test('first-run is not keyed on hasAdminUser', () => {
		expect(src).not.toContain('hasAdminUser');
	});
});
