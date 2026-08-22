/**
 * canExecDecision: the action-level gate the WebSocket terminal path uses so it
 * matches the REST exec endpoint. Free edition / auth-disabled / admin all pass;
 * enterprise requires the env-scoped containers:exec permission. Deps are
 * injected, so no shared modules are mocked (mock.module is process-global).
 */
import { describe, it, expect } from 'bun:test';
import { canExecDecision } from '../src/lib/server/ws-exec-core';

const auth = (over: Partial<{ isAdmin: boolean; authDisabled: boolean }> = {}) => ({
	userId: 1,
	username: 'u',
	isAdmin: false,
	authDisabled: false,
	...over
});

const deps = (enterprise: boolean, containers: string[]) => ({
	isEnterprise: async () => enterprise,
	getPerms: async () => ({ containers })
});

describe('canExecDecision', () => {
	it('auth-disabled (bootstrap) -> allow', async () => {
		expect(await canExecDecision(auth({ authDisabled: true }), 1, deps(true, []))).toBe(true);
	});

	it('admin -> allow', async () => {
		expect(await canExecDecision(auth({ isAdmin: true }), 1, deps(true, []))).toBe(true);
	});

	it('free edition -> allow for any authed user', async () => {
		expect(await canExecDecision(auth(), 1, deps(false, []))).toBe(true);
	});

	it('enterprise without the exec permission -> deny', async () => {
		expect(await canExecDecision(auth(), 1, deps(true, ['view', 'logs']))).toBe(false);
	});

	it('enterprise with the exec permission -> allow', async () => {
		expect(await canExecDecision(auth(), 1, deps(true, ['view', 'logs', 'exec']))).toBe(true);
	});

	it('enterprise, no envId -> deny (cannot resolve env-scoped perm)', async () => {
		expect(await canExecDecision(auth(), undefined, deps(true, ['exec']))).toBe(false);
	});
});
