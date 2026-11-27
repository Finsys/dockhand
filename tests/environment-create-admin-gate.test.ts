/**
 * A new environment can point at any Docker socket or host, Dockhand's own included, so
 * under Enterprise RBAC creating one is admin-only (as deleting one is). An environments:create
 * grant on a non-admin role must not reach createEnvironment.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { registerDbFake } from './helpers/db-fake';
import { registerAuthorizeFake } from './helpers/authorize-fake';

// Neither module is imported for real by any other test file, so replacing them is safe.
mock.module('$lib/server/audit', () => ({ auditEnvironment: async () => {} }));
mock.module('$lib/server/subprocess-manager', () => ({ refreshSubprocessEnvironments: () => {} }));

let ctx: { authEnabled: boolean; isAuthenticated: boolean; isAdmin: boolean; isEnterprise: boolean };
let created: unknown[];

registerAuthorizeFake(async () => ({ ...ctx, user: { id: 7 }, can: async () => true }));
registerDbFake('getEnvironmentByName', async () => null);
// Record the call and stop there, so the success path never touches host detection.
registerDbFake('createEnvironment', async (d: unknown) => {
	created.push(d);
	throw new Error('stop after create');
});

const { POST } = await import('../src/routes/api/environments/+server');

function post() {
	const request = new Request('http://x/api/environments', {
		method: 'POST',
		body: JSON.stringify({ name: 'self', connectionType: 'socket', socketPath: '/var/run/docker.sock' })
	});
	return POST({ request, cookies: {} } as never);
}

beforeEach(() => {
	ctx = { authEnabled: true, isAuthenticated: true, isAdmin: false, isEnterprise: true };
	created = [];
});

describe('POST /api/environments under Enterprise RBAC', () => {
	test('a non-admin holding environments:create is refused before anything is created', async () => {
		expect((await post()).status).toBe(403);
		expect(created).toEqual([]);
	});

	test('an admin reaches createEnvironment', async () => {
		ctx.isAdmin = true;
		await post();
		expect(created.length).toBe(1);
	});

	test('the free edition (every user is admin) reaches createEnvironment', async () => {
		ctx = { authEnabled: true, isAuthenticated: true, isAdmin: true, isEnterprise: false };
		await post();
		expect(created.length).toBe(1);
	});
});
