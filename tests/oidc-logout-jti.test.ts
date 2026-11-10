import { describe, test, expect } from 'bun:test';
import { JtiReplayGuard } from '../src/lib/server/oidc-logout-jti-core';

describe('JtiReplayGuard', () => {
	test('a fresh jti is not a replay, a repeat is', () => {
		const g = new JtiReplayGuard();
		expect(g.markSeen('a', 1000)).toBe(false);
		expect(g.markSeen('a', 1000)).toBe(true);
		expect(g.markSeen('b', 1000)).toBe(false);
	});

	test('a jti is forgotten after its TTL, so a much-later repeat is fresh again', () => {
		const g = new JtiReplayGuard(1000); // 1s ttl
		expect(g.markSeen('a', 0)).toBe(false);
		expect(g.markSeen('a', 500)).toBe(true); // within ttl -> replay
		expect(g.markSeen('a', 2000)).toBe(false); // past ttl -> treated as new
	});

	test('the set is bounded: the oldest entry is evicted past the cap', () => {
		const g = new JtiReplayGuard(60_000, 2); // cap 2
		expect(g.markSeen('a', 0)).toBe(false);
		expect(g.markSeen('b', 0)).toBe(false);
		expect(g.markSeen('c', 0)).toBe(false); // evicts 'a'
		expect(g.markSeen('a', 0)).toBe(false); // 'a' was dropped, so fresh again
		expect(g.markSeen('c', 0)).toBe(true); // 'c' still remembered
	});

	test('unmark releases a reservation so a retry is processed, not deduped away', () => {
		const g = new JtiReplayGuard();
		expect(g.markSeen('a', 1000)).toBe(false); // reserved
		g.unmark('a'); // the work it was reserved for failed
		expect(g.markSeen('a', 1000)).toBe(false); // the retry is fresh again, not a replay
		expect(g.markSeen('a', 1000)).toBe(true); // and now reserved once more
	});

	test('unmark of an unknown jti is a harmless no-op', () => {
		const g = new JtiReplayGuard();
		g.unmark('never-seen');
		expect(g.markSeen('never-seen', 1000)).toBe(false);
	});
});
