import { describe, it, expect } from 'bun:test';
import {
	computeRequestTimeoutMs,
	isPrunePath,
	isStopPath,
	stopTimeoutMs,
	STOP_TIMEOUT_MARGIN_MS
} from '../../src/lib/server/backups/request-timeout';

const base = { path: '/containers/x/json', streamingBody: false, streamingResponse: false };

describe('computeRequestTimeoutMs - idle-timeout policy', () => {
	it('a normal small request gets the 30s idle timeout', () => {
		expect(computeRequestTimeoutMs(base)).toBe(30000);
	});

	it('a STREAMING BODY (large tar PUT) gets NO timeout, even for a small response (the #9 fix)', () => {
		expect(computeRequestTimeoutMs({ path: '/containers/x/archive', streamingBody: true, streamingResponse: false })).toBeNull();
	});

	it('a STREAMING RESPONSE (logs/events) gets NO timeout', () => {
		expect(computeRequestTimeoutMs({ ...base, streamingResponse: true })).toBeNull();
	});

	it('a prune request gets 300s (it can take a while)', () => {
		expect(computeRequestTimeoutMs({ ...base, path: '/images/prune' })).toBe(300000);
		expect(computeRequestTimeoutMs({ ...base, path: '/containers/prune' })).toBe(300000);
	});

	it('an image prune WITH a filters query still gets 300s (#1630)', () => {
		const path = '/images/prune?filters=%7B%22dangling%22%3A%5B%22true%22%5D%7D';
		expect(computeRequestTimeoutMs({ ...base, path })).toBe(300000);
		expect(isPrunePath(path)).toBe(true);
	});

	it('a query string alone never enables the prune timeout', () => {
		expect(computeRequestTimeoutMs({ ...base, path: '/images/json?filters=/prune' })).toBe(30000);
		expect(isPrunePath('/images/json?x=/prune')).toBe(false);
		expect(isPrunePath('/images/json')).toBe(false);
	});

	it('a compose operation gets the COMPOSE_TIMEOUT (default 900s)', () => {
		expect(computeRequestTimeoutMs({ ...base, path: '/_hawser/compose' })).toBe(900000);
		expect(computeRequestTimeoutMs({ ...base, path: '/_hawser/compose', composeTimeoutSecs: 1800 })).toBe(1800000);
	});

	it('streaming beats the path-based bumps (a streamed prune/compose still has no timeout)', () => {
		expect(computeRequestTimeoutMs({ path: '/containers/prune', streamingBody: true, streamingResponse: false })).toBeNull();
		expect(computeRequestTimeoutMs({ path: '/_hawser/compose', streamingBody: false, streamingResponse: true })).toBeNull();
	});
});

describe('a stop waits out the container\'s grace period', () => {
	it('isStopPath recognises stop and restart, with or without a query', () => {
		expect(isStopPath('/containers/abc/stop')).toBe(true);
		expect(isStopPath('/containers/abc/stop?t=60')).toBe(true);
		expect(isStopPath('/containers/abc/restart?t=60')).toBe(true);
		expect(isStopPath('/containers/abc/start')).toBe(false);
		expect(isStopPath('/containers/json')).toBe(false);
		// a container named "stop" must not drag its other endpoints in
		expect(isStopPath('/containers/stop/json')).toBe(false);
	});

	it('the reported case: a 60s grace period is no longer cut off at 30s', () => {
		// Home Assistant with stop_grace_period 60s: the daemon may hold the response for
		// the full 60s, and aborting at 30s left the container stopped and the update failed.
		expect(stopTimeoutMs(60)).toBe(60000 + STOP_TIMEOUT_MARGIN_MS);
		expect(stopTimeoutMs(60)).toBeGreaterThan(30000);
	});

	it('a container that declares nothing keeps the ordinary 30s', () => {
		expect(stopTimeoutMs(null)).toBe(30000);
		expect(stopTimeoutMs(undefined)).toBe(30000);
	});

	it('a grace period shorter than 30s does not shorten the wait', () => {
		// 5s + margin is under 30s; the floor keeps the request from being the thing
		// that fails first when the daemon is merely slow to answer.
		expect(stopTimeoutMs(5)).toBe(30000);
	});

	it('the env var raises the floor for a container that declares nothing', () => {
		expect(stopTimeoutMs(null, 120)).toBe(120000);
		expect(stopTimeoutMs(undefined, 45)).toBe(45000);
	});

	it('the env var never cuts a declared grace period short', () => {
		// 300s declared, env says 60: the container still gets its own deadline.
		expect(stopTimeoutMs(300, 60)).toBe(300000 + STOP_TIMEOUT_MARGIN_MS);
	});

	it('nonsense values fall back instead of producing a tiny or NaN timeout', () => {
		for (const bad of [0, -1, NaN, Infinity]) {
			expect(stopTimeoutMs(bad as number)).toBe(30000);
			expect(stopTimeoutMs(null, bad as number)).toBe(30000);
		}
	});

	it('computeRequestTimeoutMs routes a stop through the grace period', () => {
		expect(
			computeRequestTimeoutMs({
				path: '/containers/abc/stop?t=60',
				streamingBody: false,
				streamingResponse: false,
				stopTimeoutSecs: 60
			})
		).toBe(60000 + STOP_TIMEOUT_MARGIN_MS);
	});

	it('a streaming request still has no timeout at all, stop or not', () => {
		expect(
			computeRequestTimeoutMs({
				path: '/containers/abc/stop',
				streamingBody: false,
				streamingResponse: true,
				stopTimeoutSecs: 60
			})
		).toBeNull();
	});
});

describe('the grace period travels on the path, for transports that cannot read the signal', () => {
	// The https/mTLS transport sets a socket idle timeout the caller's AbortSignal cannot
	// lengthen, and the edge transport computes its own deadline. Both recover the
	// allowance from the `?t=` stopContainer already put on the path, so the policy has to
	// produce the same answer from the path alone.
	const fromPath = (path: string): number | null => {
		if (!isStopPath(path)) return null;
		const t = parseInt(new URLSearchParams(path.split('?')[1] || '').get('t') || '', 10);
		return Number.isFinite(t) && t > 0 ? t : null;
	};

	it('recovers a declared period and gives it the full allowance', () => {
		expect(stopTimeoutMs(fromPath('/containers/abc/stop?t=60'))).toBe(60000 + STOP_TIMEOUT_MARGIN_MS);
	});

	it('a stop with no ?t= keeps the ordinary wait', () => {
		expect(stopTimeoutMs(fromPath('/containers/abc/stop'))).toBe(30000);
	});

	it('a malformed or zero ?t= does not produce a tiny timeout', () => {
		for (const bad of ['?t=abc', '?t=0', '?t=-5', '?t=']) {
			expect(stopTimeoutMs(fromPath(`/containers/abc/stop${bad}`))).toBe(30000);
		}
	});
});
