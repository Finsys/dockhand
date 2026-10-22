import { describe, expect, test } from 'bun:test';
import { providerKind, oidcProviderName, isFederatedSession } from '../src/lib/server/provider-kind-core';

/**
 * What a session's provider column means.
 *
 * It decides what the session reports itself as, and whether logging out also ends
 * the session at the identity provider - so a provider whose name is read wrong
 * quietly leaves the user signed in upstream.
 */

describe('the kind of account a session belongs to', () => {
	test('a named OIDC provider is an OIDC session', () => {
		expect(providerKind('oidc:Keycloak')).toBe('oidc');
	});

	test('a name containing colons is still one name', () => {
		// "oidc:" is a prefix, not a separator to split on.
		expect(providerKind('oidc:corp:eu:keycloak')).toBe('oidc');
	});

	test('a bare kind is that kind', () => {
		expect(providerKind('oidc')).toBe('oidc');
		expect(providerKind('ldap')).toBe('ldap');
		expect(providerKind('local')).toBe('local');
	});

	test('no provider at all is a local account', () => {
		expect(providerKind(null)).toBe('local');
		expect(providerKind(undefined)).toBe('local');
		expect(providerKind('')).toBe('local');
	});

	test('something nothing writes grants nothing extra', () => {
		expect(providerKind('saml')).toBe('local');
		expect(providerKind('oidcx')).toBe('local');
		// Exact, not a prefix: 'passkeyx' is not a passkey session.
		expect(providerKind('passkeyx')).toBe('local');
		expect(providerKind('passkey:')).toBe('local');
		expect(providerKind('PASSKEY')).toBe('local');
	});
});

describe('which provider should end the session', () => {
	test('the name after the prefix', () => {
		expect(oidcProviderName('oidc:Keycloak')).toBe('Keycloak');
		expect(oidcProviderName('oidc:corp:eu')).toBe('corp:eu');
	});

	test('a bare oidc names nobody, so logout stays local', () => {
		expect(oidcProviderName('oidc')).toBeNull();
		expect(oidcProviderName('oidc:')).toBeNull();
	});

	test('other kinds name nobody', () => {
		expect(oidcProviderName('ldap:AD')).toBeNull();
		expect(oidcProviderName('local')).toBeNull();
		expect(oidcProviderName(null)).toBeNull();
	});
});

describe('whether a session has a password to confirm', () => {
	// Creating an API token asks a local account for its password first, so a stolen
	// session cannot mint a durable credential. Only a federated account skips that,
	// because it has no password here.
	test('a federated sign-in has none', () => {
		expect(isFederatedSession('oidc')).toBe(true);
		expect(isFederatedSession('oidc:Keycloak')).toBe(true);
		expect(isFederatedSession('ldap')).toBe(true);
		expect(isFederatedSession('ldap:AD')).toBe(true);
	});

	test('a passkey session is a local account signing in differently', () => {
		// The whole point: it must still be asked for the password.
		expect(isFederatedSession('passkey')).toBe(false);
	});

	test('a local session has one', () => {
		expect(isFederatedSession('local')).toBe(false);
		expect(isFederatedSession(null)).toBe(false);
		expect(isFederatedSession(undefined)).toBe(false);
	});

	test('a near miss is not federated, so it is asked for the password', () => {
		// An unrecognised value must fail CLOSED - toward asking - rather than
		// inheriting a federated bypass from a lookalike prefix.
		expect(isFederatedSession('oidcx')).toBe(false);
		expect(isFederatedSession('ldapx')).toBe(false);
		expect(isFederatedSession('OIDC')).toBe(false);
		expect(isFederatedSession('saml')).toBe(false);
		expect(isFederatedSession('')).toBe(false);
	});
});
