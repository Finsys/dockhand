// The login route reads the local-login policy and picks the authenticator from the same
// decision, so a provider value can never reach the local login past DISABLE_LOCAL_LOGIN.
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginMethod, usableLdapConfig } from '../src/lib/server/login-provider-core';

describe('loginMethod', () => {
	test('LDAP providers', () => {
		expect(loginMethod('ldap')).toEqual({ kind: 'ldap' });
		expect(loginMethod('ldap:3')).toEqual({ kind: 'ldap', configId: 3 });
	});

	test('everything else is the local login, whatever it is called', () => {
		for (const p of ['local', 'Local', 'LOCAL', ' local', 'local ', 'oidc', 'oidc:1', 'passkey', '', 'x', 'LDAP', 'ldap ', 'ldapx', undefined, null, 42, {}, ['local']]) {
			expect(loginMethod(p)).toEqual({ kind: 'local' });
		}
	});
});

describe('usableLdapConfig', () => {
	test('only an enabled config may sign anybody in', () => {
		const on = { id: 1, enabled: true };
		expect(usableLdapConfig(on)).toEqual([on]);
		expect(usableLdapConfig({ id: 2, enabled: false })).toEqual([]);
		expect(usableLdapConfig({ id: 3, enabled: null })).toEqual([]);
		expect(usableLdapConfig({ id: 4 })).toEqual([]);
		expect(usableLdapConfig(null)).toEqual([]);
		expect(usableLdapConfig(undefined)).toEqual([]);
	});
});

// The route and auth.ts cannot be imported here (they pull in the database and argon2),
// so their wiring is read from the source.
const read = (...p: string[]) =>
	readFileSync(join(import.meta.dir, '..', ...p), 'utf8')
		.split('\n')
		.filter((l) => !l.trim().startsWith('//'))
		.join('\n');

describe('wiring', () => {
	test('the login route decides the policy on loginMethod, not on the raw provider string', () => {
		const code = read('src', 'routes', 'api', 'auth', 'login', '+server.ts');
		expect(code).toContain('const method = loginMethod(provider);');
		expect(code).toMatch(/if \(method\.kind === 'local' && process\.env\.DISABLE_LOCAL_LOGIN === 'true'\) \{\s*return json/);
		expect(code).not.toMatch(/provider === 'local'/);
		expect(code).not.toMatch(/provider\.startsWith\(/);
		const policy = code.indexOf("method.kind === 'local' && process.env.DISABLE_LOCAL_LOGIN");
		expect(policy).toBeGreaterThan(-1);
		expect(code.indexOf('authenticateLocal(')).toBeGreaterThan(policy);
		// The dispatch reads the same decision, so the two cannot drift apart.
		expect(code).toContain("if (method.kind === 'ldap') {");
		expect(code).toContain('authenticateLdap(username, password, method.configId)');
	});

	test('authenticateLdap keeps a config named by id only when it is enabled', () => {
		const code = read('src', 'lib', 'server', 'auth.ts');
		const start = code.indexOf('export async function authenticateLdap(');
		const body = code.slice(start, code.indexOf('\n}', start));
		expect(body).toMatch(/\? usableLdapConfig\(await getLdapConfig\(configId\)/);
		expect(body).toContain(': await getEnabledLdapConfigs();');
		expect(body).not.toContain('.filter(Boolean)');
	});
});
