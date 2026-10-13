import { describe, test, expect } from 'bun:test';
import { Agent } from 'undici';
import { getStreamingDispatcher, STREAMING_DISPATCHER_TIMEOUTS } from '../src/lib/server/dns-dispatcher';

// The streaming dispatcher exists so a long, quiet Docker log/backup stream is not
// aborted by undici's default 300s bodyTimeout. Assert its timeouts are off and that
// it is a reused singleton (one Agent, not one per streaming request).
describe('streaming dispatcher', () => {
	test('body timeout is disabled', () => {
		// 0 = no timeout in undici. A non-zero bodyTimeout would let a quiet backup stream
		// be aborted mid-run, the crash this dispatcher prevents.
		expect(STREAMING_DISPATCHER_TIMEOUTS.bodyTimeout).toBe(0);
	});

	test('headers timeout is left at undici default', () => {
		// Only the body goes quiet; the pre-header wait must stay bounded, so headersTimeout
		// is deliberately NOT overridden (a wedged daemon that never replies is still capped).
		expect('headersTimeout' in STREAMING_DISPATCHER_TIMEOUTS).toBe(false);
	});

	test('is an undici Agent', () => {
		expect(getStreamingDispatcher()).toBeInstanceOf(Agent);
	});

	test('is a lazily-built singleton', () => {
		expect(getStreamingDispatcher()).toBe(getStreamingDispatcher());
	});
});
