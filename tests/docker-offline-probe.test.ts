import { describe, it, expect } from 'bun:test';
import {
	isDockerProbePath,
	isExpectedConnectionError,
	isQuietDockerFailure,
	transportTimeoutError
} from '../src/lib/server/docker-probe-core';

describe('isDockerProbePath', () => {
	it('matches lightweight health check and probe paths', () => {
		expect(isDockerProbePath('/_ping')).toBe(true);
		expect(isDockerProbePath('/_ping?ts=123')).toBe(true);
		expect(isDockerProbePath('/version')).toBe(true);
		expect(isDockerProbePath('/_hawser/info')).toBe(true);
	});

	it('does not match standard operational endpoints', () => {
		expect(isDockerProbePath('/containers/json')).toBe(false);
		expect(isDockerProbePath('/images/json')).toBe(false);
		expect(isDockerProbePath('/_hawser/compose')).toBe(false);
		expect(isDockerProbePath('/info')).toBe(false);
	});
});

describe('isExpectedConnectionError', () => {
	it('identifies network offline, refused and timeout errors', () => {
		expect(isExpectedConnectionError(new TypeError('fetch failed'))).toBe(true);
		expect(isExpectedConnectionError('connect ECONNREFUSED 192.168.0.200:2376')).toBe(true);
		expect(isExpectedConnectionError('connect ETIMEDOUT 192.168.0.200:2376')).toBe(true);
		expect(isExpectedConnectionError('getaddrinfo EHOSTUNREACH')).toBe(true);
		expect(isExpectedConnectionError('getaddrinfo ENOTFOUND host')).toBe(true);
		expect(isExpectedConnectionError('read ECONNRESET')).toBe(true);
	});

	it('identifies a host that answers nothing at all', () => {
		// A powered-off host does not refuse the connection, it stays silent, so the
		// request is cut short by AbortSignal.timeout and carries no errno. This is the
		// COMMONEST offline shape and the reason the check cannot be errno-only.
		const timedOut = Object.assign(new Error('The operation was aborted due to timeout'), {
			name: 'TimeoutError'
		});
		expect(isExpectedConnectionError(timedOut)).toBe(true);
	});

	it('identifies a timeout a transport synthesised itself', () => {
		// The HTTPS agent and the edge relay cut the request short themselves, so the
		// socket's errno is gone and only the wording would remain. They name the error
		// instead, which is what makes ONE predicate work on every transport: without
		// this, an unreachable mTLS or edge host is the only shape still logging an error
		// on every cycle - the flood this whole change exists to stop.
		for (const wording of ['Request timeout', 'Request aborted', 'Connection timeout']) {
			expect(isExpectedConnectionError(transportTimeoutError(wording))).toBe(true);
		}
	});

	it('does not treat the same wording as unreachable when nothing named it', () => {
		// The near miss for the rule above: the name is what carries the meaning, not the
		// words. A plain Error saying "Request timeout" is not a transport's own abort.
		expect(isExpectedConnectionError(new Error('Request timeout'))).toBe(false);
	});

	it('does NOT treat a non-network timeout as unreachable', () => {
		// Each of these contains the word "timeout" and none of them is a network
		// failure. Matching the word rather than the errno would silence a real error
		// anywhere this helper is reused.
		expect(isExpectedConnectionError(new Error('container stop timeout exceeded'))).toBe(false);
		expect(isExpectedConnectionError(new Error('restic lock timeout: repository is locked'))).toBe(false);
		expect(isExpectedConnectionError(new Error('exec timeout waiting for command'))).toBe(false);
		expect(isExpectedConnectionError(
			new Error('Error response from daemon: timeout waiting for container to stop')
		)).toBe(false);
	});

	it('returns false for non-network errors', () => {
		expect(isExpectedConnectionError(new Error('SyntaxError: Unexpected token'))).toBe(false);
		expect(isExpectedConnectionError(new Error('Invalid credentials'))).toBe(false);
		expect(isExpectedConnectionError('404 Not Found')).toBe(false);
	});

	it('keeps the cases the volume-helper sweeps rely on', () => {
		// These two call sites used to carry their own copy of this check; the wordings
		// they matched have to keep working now that they consult this helper.
		expect(isExpectedConnectionError(new Error('Agent not connected'))).toBe(true);
		expect(isExpectedConnectionError(new Error('Environment offline'))).toBe(true);
		expect(isExpectedConnectionError(new Error('Host unreachable'))).toBe(true);
		expect(isExpectedConnectionError(new Error('write EPROTO ... ssl3_get_record'))).toBe(true);
	});
});

describe('which failures are logged quietly', () => {
	// The routing decision itself. It lives here rather than in docker.ts because that
	// module cannot be imported under bun, and a decision only reachable through an
	// unimportable module is a decision nothing can hold.
	const offline = transportTimeoutError('Request aborted');

	it('quiets a probe that could not reach the host', () => {
		expect(isQuietDockerFailure('/_ping', offline)).toBe(true);
		expect(isQuietDockerFailure('/version', new TypeError('fetch failed'))).toBe(true);
		expect(isQuietDockerFailure('/_hawser/info', 'connect ECONNREFUSED 10.0.0.1:2376')).toBe(true);
	});

	it('still reports a probe that failed for any other reason', () => {
		// The whole point of not quieting by environment status: these need acting on.
		expect(isQuietDockerFailure('/_ping', new Error('401 Unauthorized'))).toBe(false);
		expect(isQuietDockerFailure('/version', new Error('certificate has expired'))).toBe(false);
		expect(isQuietDockerFailure('/_ping', new Error('permission denied'))).toBe(false);
	});

	it('still reports an operational request, even when the host is unreachable', () => {
		// A real call that failed is news, however offline the host is.
		expect(isQuietDockerFailure('/containers/json', offline)).toBe(false);
		expect(isQuietDockerFailure('/images/json', new TypeError('fetch failed'))).toBe(false);
	});
});
