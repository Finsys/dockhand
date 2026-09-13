import { describe, it, expect } from 'bun:test';
import { landingRedirectTarget } from '../src/lib/utils/landing';

describe('landingRedirectTarget', () => {
	it('redirects to the configured landing page (page only, no env)', () => {
		expect(landingRedirectTarget({ landingPage: 'volumes' }, false)).toBe('/volumes');
		expect(landingRedirectTarget({ landingPage: 'containers' }, false)).toBe('/containers');
	});

	it('stays on the dashboard when landing is dashboard or unset', () => {
		expect(landingRedirectTarget({ landingPage: 'dashboard' }, false)).toBeNull();
		expect(landingRedirectTarget({ landingPage: null }, false)).toBeNull();
		expect(landingRedirectTarget({}, false)).toBeNull();
		expect(landingRedirectTarget(null, false)).toBeNull();
	});

	it('the ?home marker suppresses the redirect (sidebar Dashboard / logo click)', () => {
		expect(landingRedirectTarget({ landingPage: 'volumes' }, true)).toBeNull();
		expect(landingRedirectTarget({ landingPage: 'containers' }, true)).toBeNull();
	});

	it('redirects on every open without the marker (no per-tab memory)', () => {
		// Same input, no marker -> always the same redirect, however many times the app opens.
		expect(landingRedirectTarget({ landingPage: 'stacks' }, false)).toBe('/stacks');
		expect(landingRedirectTarget({ landingPage: 'stacks' }, false)).toBe('/stacks');
	});
});
