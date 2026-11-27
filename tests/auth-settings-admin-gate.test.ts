/**
 * PUT /api/auth/settings can switch authentication off for the whole instance, so it is
 * admin-only. An Enterprise role carrying settings:edit (even one scoped to a single
 * environment) must not reach updateAuthSettings.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { registerDbFake } from './helpers/db-fake';
import { registerAuthorizeFake } from './helpers/authorize-fake';

let ctx: { authEnabled: boolean; isAuthenticated: boolean; isAdmin: boolean; isEnterprise: boolean };
let writes: unknown[];

registerAuthorizeFake(async () => ({
	...ctx,
	// A settings:edit grant: proves the gate does not fall back to the permission check.
	can: async () => true
}));
registerDbFake('getAuthSettings', async () => ({ authEnabled: true, defaultProvider: 'local', sessionTimeout: 86400 }));
registerDbFake('updateAuthSettings', async (d: unknown) => {
	writes.push(d);
	return { authEnabled: false, defaultProvider: 'local', sessionTimeout: 86400 };
});
registerDbFake('countAdminUsers', async () => 1);
registerDbFake('getPasskeysEnabled', async () => false);
registerDbFake('setPasskeysEnabled', async () => {});

const { PUT } = await import('../src/routes/api/auth/settings/+server');

function put(body: unknown) {
	const request = new Request('http://x/api/auth/settings', { method: 'PUT', body: JSON.stringify(body) });
	return PUT({ request, cookies: {} } as never);
}

beforeEach(() => {
	ctx = { authEnabled: true, isAuthenticated: true, isAdmin: false, isEnterprise: true };
	writes = [];
});

describe('PUT /api/auth/settings is admin-only', () => {
	test('an Enterprise non-admin with settings:edit is refused and nothing is written', async () => {
		const res = await put({ authEnabled: false });
		expect(res.status).toBe(403);
		expect(writes).toEqual([]);
	});

	test('an Enterprise admin can change the settings', async () => {
		ctx.isAdmin = true;
		const res = await put({ authEnabled: false });
		expect(res.status).toBe(200);
		expect(writes).toEqual([{ authEnabled: false }]);
	});

	test('the free edition (every user is admin) keeps working', async () => {
		ctx = { authEnabled: true, isAuthenticated: true, isAdmin: true, isEnterprise: false };
		expect((await put({ sessionTimeout: 0 })).status).toBe(200);
	});

	test('with auth disabled (initial setup) the settings stay editable', async () => {
		ctx = { authEnabled: false, isAuthenticated: false, isAdmin: false, isEnterprise: false };
		expect((await put({ authEnabled: true })).status).toBe(200);
	});

	test('an unauthenticated caller gets 401', async () => {
		ctx.isAuthenticated = false;
		expect((await put({ authEnabled: false })).status).toBe(401);
		expect(writes).toEqual([]);
	});
});
