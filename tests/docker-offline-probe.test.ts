import { describe, it, expect } from 'bun:test';
import { isDockerProbePath, isDockerNetworkError } from '../src/lib/server/docker-probe-core';

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

describe('isDockerNetworkError', () => {
	it('identifies network offline, refused and timeout errors', () => {
		expect(isDockerNetworkError(new TypeError('fetch failed'))).toBe(true);
		expect(isDockerNetworkError('connect ECONNREFUSED 192.168.0.200:2376')).toBe(true);
		expect(isDockerNetworkError('connect ETIMEDOUT 192.168.0.200:2376')).toBe(true);
		expect(isDockerNetworkError('getaddrinfo EHOSTUNREACH')).toBe(true);
		expect(isDockerNetworkError('getaddrinfo ENOTFOUND host')).toBe(true);
		expect(isDockerNetworkError('read ECONNRESET')).toBe(true);
		expect(isDockerNetworkError('The operation was aborted due to timeout')).toBe(true);
	});

	it('returns false for non-network errors', () => {
		expect(isDockerNetworkError(new Error('SyntaxError: Unexpected token'))).toBe(false);
		expect(isDockerNetworkError(new Error('Invalid credentials'))).toBe(false);
		expect(isDockerNetworkError('404 Not Found')).toBe(false);
	});
});
