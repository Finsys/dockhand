/**
 * Unit tests for nav-preferences.ts — the PURE validation (parseNavPatch). It has no DB
 * dependency, so it imports directly with no mock.module (mocking ./db here is unsafe: bun's
 * mock.module is process-global and would clobber the ./db export set other backup unit tests
 * rely on, e.g. route-guards.test.ts's getBackupConfig). The merge/defaults + env-deletion
 * sweep touch the DB and are exercised via the integration suite, not mocked here.
 */
import { describe, it, expect } from 'bun:test';
import { parseNavPatch, PAGE_SLUGS } from '../src/lib/server/nav-preferences-core';

describe('parseNavPatch — validation', () => {
	it('accepts every real page slug for landingPage', () => {
		for (const p of PAGE_SLUGS) {
			expect(parseNavPatch({ landingPage: p })).toEqual({ landingPage: p });
		}
	});
	it("rejects 'remember' for landingPage (feature removed)", () => {
		expect(() => parseNavPatch({ landingPage: 'remember' })).toThrow('Invalid landingPage');
	});
	it("treats '' and null as a clear (null)", () => {
		expect(parseNavPatch({ landingPage: '' })).toEqual({ landingPage: null });
		expect(parseNavPatch({ landingPage: null })).toEqual({ landingPage: null });
	});
	it('rejects an unknown landingPage', () => {
		expect(() => parseNavPatch({ landingPage: 'nope' })).toThrow('Invalid landingPage');
	});
	it("rejects 'dashboard' for envClickPage (concrete per-env only)", () => {
		expect(() => parseNavPatch({ envClickPage: 'dashboard' })).toThrow('Invalid envClickPage');
	});
	it('accepts an env-scoped page for envClickPage', () => {
		expect(parseNavPatch({ envClickPage: 'stacks' })).toEqual({ envClickPage: 'stacks' });
	});
	it('ignores fields that are not present (partial patch)', () => {
		expect(parseNavPatch({})).toEqual({});
		expect(parseNavPatch({ landingPage: 'logs' })).toEqual({ landingPage: 'logs' });
	});
});
