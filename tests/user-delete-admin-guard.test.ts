// Deleting an Admin account, and with the last one switching authentication off, needs an
// administrator even when a non-admin role holds users:remove. The route cannot be imported
// here (it pulls in the database), so the guard and its order are read from the source.
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, '..', 'src', 'routes', 'api', 'users', '[id]', '+server.ts'), 'utf8');
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const del = code.slice(code.indexOf('export const DELETE'));

test('a non-admin cannot delete an admin account', () => {
	expect(del).toMatch(/if \(auth\.authEnabled && userIsAdmin && !auth\.isAdmin\) \{\s*return json\(\{ error: 'Cannot delete an admin account' \}, \{ status: 403 \}\);/);
});

test('the guard runs before any session, deletion or auth-settings change', () => {
	const guard = del.indexOf("'Cannot delete an admin account'");
	expect(guard).toBeGreaterThan(del.indexOf('const userIsAdmin = await userHasAdminRole(id);'));
	// Ahead of the last-admin branch too, so it holds when other admins remain.
	for (const sink of ['countAdminUsers(', 'deleteUserSessions(', 'dbDeleteUser(', 'updateAuthSettings(']) {
		expect(del.indexOf(sink)).toBeGreaterThan(guard);
	}
});
