import { describe, expect, test } from 'bun:test';
import {
	mergeUserinfo,
	claimsGrantAdmin,
	identityFromClaims,
	rolesFromClaims
} from '../src/lib/server/oidc-claims-core';

describe('merging the userinfo response', () => {
	test('a response about the same subject is merged', () => {
		const out = mergeUserinfo(
			{ sub: 'user-1', email: 'old@example.com' },
			{ sub: 'user-1', email: 'new@example.com', name: 'Ada' }
		);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.claims.email).toBe('new@example.com');
			expect(out.claims.name).toBe('Ada');
		}
	});

	test('a response about somebody else is refused', () => {
		// The admin claim is read after this merge, so a userinfo response that is not
		// about the token's subject must not reach it.
		const out = mergeUserinfo(
			{ sub: 'user-1', groups: ['viewers'] },
			{ sub: 'user-2', groups: ['dockhand_admins'] }
		);
		expect(out).toEqual({ ok: false, reason: 'subject-mismatch' });
	});

	test('a response naming nobody is set aside, not treated as an imposter', () => {
		// The token is already verified, so a provider that answers without a subject
		// is a poor provider rather than an attack. Refusing the whole login here
		// would lock those users out over a field nothing depends on.
		const out = mergeUserinfo({ sub: 'user-1', groups: ['viewers'] }, { email: 'x@example.com' });
		expect(out).toEqual({
			ok: true,
			claims: { sub: 'user-1', groups: ['viewers'] },
			ignored: 'no-subject'
		});
	});

	test('and its claims are not merged, so it cannot grant anything', () => {
		const out = mergeUserinfo({ sub: 'user-1' }, { groups: ['dockhand_admins'] });
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.claims.groups).toBeUndefined();
	});

	test('no userinfo at all leaves the token claims alone', () => {
		const claims = { sub: 'user-1', groups: ['viewers'] };
		expect(mergeUserinfo(claims, null)).toEqual({ ok: true, claims });
		expect(mergeUserinfo(claims, undefined)).toEqual({ ok: true, claims });
	});

	test('the same numbered subject written two ways is one person', () => {
		// A provider that numbers its subjects may send 1 in the token and "1" here.
		const out = mergeUserinfo({ sub: '1' }, { sub: 1 as unknown as string, name: 'Ada' });
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.claims.name).toBe('Ada');
	});

	test('two different numbered subjects are still refused', () => {
		const out = mergeUserinfo(
			{ sub: 1 as unknown as string, groups: ['viewers'] },
			{ sub: 2 as unknown as string, groups: ['dockhand_admins'] }
		);
		expect(out).toEqual({ ok: false, reason: 'subject-mismatch' });
	});
});

describe('whether the claims grant admin', () => {
	test('a listed value in an array claim grants it', () => {
		expect(claimsGrantAdmin({ groups: ['a', 'dockhand_admins'] }, 'groups', 'dockhand_admins')).toBe(
			true
		);
	});

	test('a listed value in a scalar claim grants it', () => {
		expect(claimsGrantAdmin({ role: 'admin' }, 'role', 'admin')).toBe(true);
	});

	test('any of several configured values is enough', () => {
		expect(claimsGrantAdmin({ groups: ['ops'] }, 'groups', 'admin, ops , superuser')).toBe(true);
	});

	test('an unlisted value grants nothing', () => {
		expect(claimsGrantAdmin({ groups: ['viewers'] }, 'groups', 'dockhand_admins')).toBe(false);
		// A scalar claim too: the array and scalar branches are separate code, and this
		// is the line that decides who is an administrator.
		expect(claimsGrantAdmin({ role: 'peon' }, 'role', 'admin')).toBe(false);
	});

	test('an unconfigured pair grants nothing', () => {
		const claims = { groups: ['dockhand_admins'] };
		expect(claimsGrantAdmin(claims, null, 'dockhand_admins')).toBe(false);
		expect(claimsGrantAdmin(claims, 'groups', null)).toBe(false);
		expect(claimsGrantAdmin(claims, 'groups', '')).toBe(false);
		expect(claimsGrantAdmin(claims, 'groups', ' , ')).toBe(false);
	});

	test('a value that merely contains the configured one grants nothing', () => {
		// The near misses are what separate an exact match from a substring match. A
		// group called "non-admin" must not make somebody an administrator.
		expect(claimsGrantAdmin({ groups: ['non-admin'] }, 'groups', 'admin')).toBe(false);
		expect(claimsGrantAdmin({ groups: ['admins-readonly'] }, 'groups', 'admins')).toBe(false);
		expect(claimsGrantAdmin({ role: 'non-admin' }, 'role', 'admin')).toBe(false);
	});

	test('matching is case-sensitive', () => {
		// Group names are opaque identifiers at the provider, not prose. Both branches:
		// a claim can arrive as a list or as a single value, and they are separate code.
		expect(claimsGrantAdmin({ groups: ['ADMIN'] }, 'groups', 'admin')).toBe(false);
		expect(claimsGrantAdmin({ groups: ['Admin'] }, 'groups', 'admin')).toBe(false);
		expect(claimsGrantAdmin({ role: 'ADMIN' }, 'role', 'admin')).toBe(false);
		expect(claimsGrantAdmin({ role: 'Admin' }, 'role', 'admin')).toBe(false);
	});

	test('a missing claim grants nothing', () => {
		expect(claimsGrantAdmin({}, 'groups', 'dockhand_admins')).toBe(false);
	});

	test('a non-string entry in the array is ignored', () => {
		expect(claimsGrantAdmin({ groups: [1, 2] }, 'groups', '1')).toBe(false);
	});
});

describe('the identity behind the claims', () => {
	const config = {
		usernameClaim: 'preferred_username',
		emailClaim: 'email',
		displayNameClaim: 'name'
	};

	test('takes the configured claims', () => {
		const out = identityFromClaims(
			{ preferred_username: 'ada', email: 'ada@example.com', name: 'Ada L' },
			config
		);
		expect(out).toEqual({ ok: true, username: 'ada', email: 'ada@example.com', displayName: 'Ada L' });
	});

	test('falls back to sub when the username claim is absent', () => {
		// sub is the only claim a provider must always send.
		const out = identityFromClaims({ sub: 'user-1' }, config);
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.username).toBe('user-1');
	});

	test('honours a custom username claim', () => {
		const out = identityFromClaims({ upn: 'ada@corp', sub: 'x' }, { usernameClaim: 'upn' });
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.username).toBe('ada@corp');
	});

	test('no username at all fails rather than inventing one', () => {
		expect(identityFromClaims({ email: 'a@b.c' }, config)).toEqual({
			ok: false,
			reason: 'no-username'
		});
	});

	test('a numbered subject is a username', () => {
		// Some providers number their subjects. By this point the claims are verified,
		// so refusing one would lock those users out over its type alone.
		const out = identityFromClaims({ sub: 12345 as unknown as string }, config);
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.username).toBe('12345');
	});

	test('an empty claim falls through to the next candidate', () => {
		// Some federated providers send an empty preferred_username for service
		// accounts. Stopping at the empty value would lock them out.
		const out = identityFromClaims({ preferred_username: '', sub: 'real-user-1' }, config);
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.username).toBe('real-user-1');
	});

	test('an empty string is not a username', () => {
		expect(identityFromClaims({ preferred_username: '', sub: '' }, config).ok).toBe(false);
	});

	test('email and display name stay optional', () => {
		const out = identityFromClaims({ sub: 'user-1' }, config);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.email).toBeUndefined();
			expect(out.displayName).toBeUndefined();
		}
	});
});

describe('the roles the claims ask for', () => {
	const mappings = [
		{ claimValue: 'devs', roleId: 2 },
		{ claimValue: 'ops', roleId: 3 }
	];

	test('matches an array claim', () => {
		expect(rolesFromClaims({ groups: ['devs', 'other'] }, mappings, 'groups')).toEqual([2]);
	});

	test('a mapping pointing at no real role is dropped', () => {
		// These come from JSON in the provider row, so the shape is not guaranteed and
		// a bad one must not become an assignment against role 0 or NaN.
		const broken = [
			{ claimValue: 'devs', roleId: 0 },
			{ claimValue: 'devs', roleId: -1 },
			{ claimValue: 'devs', roleId: 1.5 },
			{ claimValue: 'devs', roleId: undefined as unknown as number },
			{ claimValue: 'devs', roleId: '4' as unknown as number }
		];
		expect(rolesFromClaims({ groups: ['devs'] }, broken, 'groups')).toEqual([]);
	});

	test('a near-miss claim value maps to no role', () => {
		expect(rolesFromClaims({ groups: ['devs-external'] }, mappings, 'groups')).toEqual([]);
		expect(rolesFromClaims({ groups: ['DEVS'] }, mappings, 'groups')).toEqual([]);
		// A scalar claim goes through separate code to the list above.
		expect(rolesFromClaims({ groups: 'devs-external' }, mappings, 'groups')).toEqual([]);
		expect(rolesFromClaims({ groups: 'DEVS' }, mappings, 'groups')).toEqual([]);
	});

	test('matches a scalar claim', () => {
		expect(rolesFromClaims({ groups: 'ops' }, mappings, 'groups')).toEqual([3]);
	});

	test('several matches come back once each', () => {
		const dup = [...mappings, { claimValue: 'devs', roleId: 2 }];
		expect(rolesFromClaims({ groups: ['devs', 'ops'] }, dup, 'groups')).toEqual([2, 3]);
	});

	test('defaults to the groups claim', () => {
		expect(rolesFromClaims({ groups: ['devs'] }, mappings, null)).toEqual([2]);
	});

	test('no mappings, no claim, or no match yields nothing', () => {
		expect(rolesFromClaims({ groups: ['devs'] }, [], 'groups')).toEqual([]);
		expect(rolesFromClaims({ groups: ['devs'] }, null, 'groups')).toEqual([]);
		expect(rolesFromClaims({}, mappings, 'groups')).toEqual([]);
		expect(rolesFromClaims({ groups: ['nobody'] }, mappings, 'groups')).toEqual([]);
	});
});
