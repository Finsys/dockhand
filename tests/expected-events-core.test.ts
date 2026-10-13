import { describe, test, expect } from 'bun:test';
import { ExpectedEventsTracker } from '../src/lib/server/expected-events-core';

const T0 = 1_000_000;
const TTL = 30_000;

describe('ExpectedEventsTracker', () => {
	test('suppresses die/kill/stop for a marked container within the window', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('abc', T0, TTL);
		for (const a of ['die', 'kill', 'stop']) {
			expect(t.shouldSuppress('abc', a, T0 + 1000)).toBe(true);
		}
	});

	test('does NOT suppress start/oom/health even mid-update (only the noisy actions)', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('abc', T0, TTL);
		for (const a of ['start', 'oom', 'health_status: unhealthy', 'create', 'restart']) {
			expect(t.shouldSuppress('abc', a, T0 + 1000)).toBe(false);
		}
	});

	test('does NOT suppress an unmarked container (a genuine crash of something else)', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('abc', T0, TTL);
		expect(t.shouldSuppress('other', 'die', T0 + 1000)).toBe(false);
	});

	test('does NOT suppress after the window expires (a later real crash still alarms)', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('abc', T0, TTL);
		expect(t.shouldSuppress('abc', 'die', T0 + TTL + 1)).toBe(false);
	});

	test('at exactly the expiry boundary is still within (now > exp is the cutoff)', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('abc', T0, TTL);
		expect(t.shouldSuppress('abc', 'die', T0 + TTL)).toBe(true); // now == exp -> not > exp
		expect(t.shouldSuppress('abc', 'die', T0 + TTL + 1)).toBe(false);
	});

	test('checking an expired entry drops it (lazy cleanup)', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('abc', T0, TTL);
		expect(t.size()).toBe(1);
		t.shouldSuppress('abc', 'die', T0 + TTL + 1); // expired -> deleted
		expect(t.size()).toBe(0);
	});

	test('empty containerId is ignored', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('', T0, TTL);
		expect(t.size()).toBe(0);
	});

	test('clear drops a mark so a later genuine crash is NOT suppressed (rollback case)', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('abc', T0, TTL);
		t.clear('abc');
		expect(t.shouldSuppress('abc', 'die', T0 + 1000)).toBe(false);
		expect(t.size()).toBe(0);
	});

	test('does not leak: a check prunes OTHER expired entries (happy-path cleanup)', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('done', T0, TTL);          // expires at T0+30000
		t.markExpected('live', T0 + 50_000, TTL); // expires at T0+80000
		// A check AFTER 'done' expired but BEFORE 'live' expires reclaims 'done' even
		// though 'done' never got another event of its own.
		t.shouldSuppress('live', 'die', T0 + 60_000);
		expect(t.size()).toBe(1); // only 'live' remains
	});

	test('suppressed hit does NOT drop the entry (die+kill+stop of one update all suppressed)', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('abc', T0, TTL);
		expect(t.shouldSuppress('abc', 'die', T0 + 100)).toBe(true);
		expect(t.shouldSuppress('abc', 'kill', T0 + 200)).toBe(true);
		expect(t.shouldSuppress('abc', 'stop', T0 + 300)).toBe(true); // still suppressed within window
	});

	test('prune removes only expired entries', () => {
		const t = new ExpectedEventsTracker();
		t.markExpected('a', T0, TTL);
		t.markExpected('b', T0 + 20_000, TTL);
		t.prune(T0 + TTL + 1); // 'a' expired, 'b' still valid
		expect(t.size()).toBe(1);
		expect(t.shouldSuppress('b', 'die', T0 + 25_000)).toBe(true);
	});
});
