import { describe, expect, test } from 'bun:test';
import { autoLoginTarget } from '../src/lib/utils/oidc-autologin';

const ONE = ['/api/auth/oidc/1/initiate'];

describe('going straight to the provider', () => {
	test('one provider and the setting on', () => {
		expect(autoLoginTarget({ enabled: true, oidcInitiateUrls: ONE })).toBe(ONE[0]);
	});

	test('off unless the operator asked for it', () => {
		expect(autoLoginTarget({ enabled: false, oidcInitiateUrls: ONE })).toBeNull();
	});
});

describe('the ways out, so a broken provider cannot lock the page', () => {
	test('an error from the last attempt leaves the form up', () => {
		// Otherwise one failing provider becomes a loop between here and back.
		expect(
			autoLoginTarget({ enabled: true, oidcInitiateUrls: ONE, error: 'Sign-in rejected' })
		).toBeNull();
	});

	test('an empty error string is not an error', () => {
		expect(autoLoginTarget({ enabled: true, oidcInitiateUrls: ONE, error: '' })).toBe(ONE[0]);
	});

	test('?local=1 asks for the form on purpose', () => {
		expect(
			autoLoginTarget({ enabled: true, oidcInitiateUrls: ONE, localRequested: true })
		).toBeNull();
	});
});

describe('how many providers there are', () => {
	test('none to redirect to', () => {
		expect(autoLoginTarget({ enabled: true, oidcInitiateUrls: [] })).toBeNull();
	});

	test('two is a choice, and choosing for the user is not a redirect', () => {
		expect(
			autoLoginTarget({
				enabled: true,
				oidcInitiateUrls: ['/api/auth/oidc/1/initiate', '/api/auth/oidc/2/initiate']
			})
		).toBeNull();
	});
});
