/**
 * POST /api/git/repositories/{id}/deploy runs a compose deploy on the repository's
 * environment, so git:edit alone is not enough: it needs stacks:create and stacks:start
 * there, and an Enterprise non-admin cannot reach Dockhand's own daemon through a
 * repository with no environment.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { registerDbFake } from './helpers/db-fake';
import { registerAuthorizeFake } from './helpers/authorize-fake';

let deployed: number[];
// No other test file imports $lib/server/git, so replacing it is safe.
mock.module('$lib/server/git', () => ({
	deployFromRepository: async (id: number) => {
		deployed.push(id);
		return { success: true };
	}
}));

// permEnvs: the environments the stack roles are scoped to. can() without an environment
// merges every role, as checkPermission does.
let ctx: { authEnabled: boolean; isAdmin: boolean; isEnterprise: boolean; perms: string[]; permEnvs: number[]; access: number[] };
let repoEnv: number | null;

registerAuthorizeFake(async () => ({
	authEnabled: ctx.authEnabled,
	isAuthenticated: true,
	isAdmin: ctx.isAdmin,
	isEnterprise: ctx.isEnterprise,
	can: async (resource: string, action: string, envId?: number) =>
		ctx.perms.includes(`${resource}:${action}`) && (envId === undefined || ctx.permEnvs.includes(envId)),
	canAccessEnvironment: async (id: number) => ctx.access.includes(id)
}));
registerDbFake('getGitRepository', async (id: number) => ({ id, environmentId: repoEnv }));

const { POST } = await import('../src/routes/api/git/repositories/[id]/deploy/+server');
const call = () => POST({ params: { id: '4' }, cookies: {} } as never);

beforeEach(() => {
	deployed = [];
	repoEnv = 2;
	ctx = { authEnabled: true, isAdmin: false, isEnterprise: true, perms: ['git:edit', 'stacks:create', 'stacks:start'], permEnvs: [2], access: [2] };
});

describe('git repository deploy gate', () => {
	test('git:edit alone is refused', async () => {
		ctx.perms = ['git:edit'];
		expect((await call()).status).toBe(403);
		expect(deployed).toEqual([]);
	});

	test('stack rights must be on the repository environment, not another one', async () => {
		ctx.permEnvs = [3];
		ctx.access = [2, 3];
		expect((await call()).status).toBe(403);
		expect(deployed).toEqual([]);
	});

	test('both stacks:create and stacks:start are needed', async () => {
		ctx.perms = ['git:edit', 'stacks:create'];
		expect((await call()).status).toBe(403);
		ctx.perms = ['git:edit', 'stacks:start'];
		expect((await call()).status).toBe(403);
		expect(deployed).toEqual([]);
	});

	test('stack rights on an accessible environment deploy', async () => {
		expect((await call()).status).toBe(200);
		expect(deployed).toEqual([4]);
	});

	test('an environment outside the user scope is refused', async () => {
		ctx.access = [3];
		expect((await call()).status).toBe(403);
		expect(deployed).toEqual([]);
	});

	test('an enterprise non-admin cannot deploy a repository without an environment', async () => {
		repoEnv = null;
		expect((await call()).status).toBe(403);
		expect(deployed).toEqual([]);
	});

	test('an admin, or the free edition, may deploy a repository without an environment', async () => {
		repoEnv = null;
		ctx.isAdmin = true;
		expect((await call()).status).toBe(200);
		ctx = { authEnabled: true, isAdmin: true, isEnterprise: false, perms: ['git:edit', 'stacks:create', 'stacks:start'], permEnvs: [], access: [] };
		expect((await call()).status).toBe(200);
		expect(deployed).toEqual([4, 4]);
	});
});
