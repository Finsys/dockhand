/**
 * A stack operation without an environment runs against Dockhand's own Docker daemon. Under
 * Enterprise RBAC a non-admin's env-scoped roles must not reach that daemon by leaving the
 * environment out, so deniesEnvScope refuses a missing environment for them.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deniesEnvScope } from '../src/lib/server/env-scope';

const auth = (o: Partial<{ authEnabled: boolean; isEnterprise: boolean; isAdmin: boolean; access: number[] }>) => ({
	authEnabled: o.authEnabled ?? true,
	isEnterprise: o.isEnterprise ?? true,
	isAdmin: o.isAdmin ?? false,
	canAccessEnvironment: async (id: number) => (o.access ?? [2]).includes(id)
});

describe('deniesEnvScope', () => {
	test('enterprise non-admin without an environment is refused', async () => {
		expect(await deniesEnvScope(auth({}), undefined)).toBe(true);
		expect(await deniesEnvScope(auth({}), null)).toBe(true);
		expect(await deniesEnvScope(auth({}), 0)).toBe(true);
	});

	test('enterprise non-admin: an accessible environment passes, another does not', async () => {
		expect(await deniesEnvScope(auth({}), 2)).toBe(false);
		expect(await deniesEnvScope(auth({}), 3)).toBe(true);
	});

	test('an enterprise admin may still omit the environment', async () => {
		expect(await deniesEnvScope(auth({ isAdmin: true, access: [] }), undefined)).toBe(false);
	});

	test('free edition and auth-disabled installs keep the old behaviour', async () => {
		expect(await deniesEnvScope(auth({ isEnterprise: false, access: [] }), undefined)).toBe(false);
		expect(await deniesEnvScope(auth({ authEnabled: false, access: [] }), undefined)).toBe(false);
	});

	// The handlers import the stack engine and cannot load under bun, so their behaviour is
	// unpinned; the source is pinned instead: each mutating handler returns on the check,
	// and none short-circuits it when the environment is missing.
	test('no mutating stack handler skips the scope check for a missing environment', () => {
		const files = [
			'stacks/+server.ts', 'stacks/[name]/+server.ts', 'stacks/[name]/attach/+server.ts',
			'stacks/[name]/deploy/+server.ts', 'stacks/[name]/down/+server.ts', 'stacks/[name]/env/+server.ts',
			'stacks/[name]/env/raw/+server.ts', 'stacks/[name]/restart/+server.ts', 'stacks/[name]/start/+server.ts',
			'stacks/[name]/stop/+server.ts', 'stacks/[name]/compose/+server.ts', 'stacks/[name]/relocate/+server.ts',
			'git/stacks/+server.ts'
		];
		for (const f of files) {
			const src = readFileSync(`src/routes/api/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
			const mutating = src.split(/\nexport const /).filter((h) => /^(POST|PUT|DELETE)\b/.test(h));
			expect(mutating.length).toBeGreaterThan(0);
			for (const h of mutating) {
				expect(`${f}: ${/^\s*if \(await deniesEnvScope\(auth, ([A-Za-z_$][\w$]*|typeof data\.environmentId === 'number' \? data\.environmentId : undefined)\)\) \{\s*return json\(/m.test(h)}`).toBe(`${f}: true`);
				expect(`${f}: ${/&&\s*(\(\s*)?await deniesEnvScope/.test(h)}`).toBe(`${f}: false`);
			}
		}
	});
});
