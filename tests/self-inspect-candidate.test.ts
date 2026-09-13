/**
 * Unit tests for isSelfInspectCandidate — which environments qualify for the
 * socket-proxy fallback (inspecting Dockhand's OWN container over tcp://) in
 * host-path.ts (#1203/#1204).
 *
 * Run with: bun test tests/unit/self-inspect-candidate.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { isSelfInspectCandidate } from '../src/lib/server/host-path-core';

describe('isSelfInspectCandidate', () => {
	test('plain-http direct env with host+port qualifies', () => {
		expect(isSelfInspectCandidate({ connectionType: 'direct', protocol: 'http', host: 'socket-proxy', port: 2375 })).toBe(true);
	});

	test('direct env with null protocol defaults to http and qualifies', () => {
		expect(isSelfInspectCandidate({ connectionType: 'direct', protocol: null, host: 'socket-proxy', port: 2375 })).toBe(true);
	});

	test('direct env with undefined protocol qualifies', () => {
		expect(isSelfInspectCandidate({ connectionType: 'direct', host: 'socket-proxy', port: 2375 })).toBe(true);
	});

	test('https direct env is rejected (needs TLS certs a bare tcp:// would drop)', () => {
		expect(isSelfInspectCandidate({ connectionType: 'direct', protocol: 'https', host: 'docker', port: 2376 })).toBe(false);
	});

	test('socket env is rejected (no host:port, and a socketless container cannot reach a socket)', () => {
		expect(isSelfInspectCandidate({ connectionType: 'socket', protocol: 'http', host: null, port: null })).toBe(false);
	});

	test('hawser-standard env is rejected (remote agent, not the local daemon)', () => {
		expect(isSelfInspectCandidate({ connectionType: 'hawser-standard', protocol: 'http', host: 'agent', port: 2376 })).toBe(false);
	});

	test('hawser-edge env is rejected', () => {
		expect(isSelfInspectCandidate({ connectionType: 'hawser-edge', protocol: 'http', host: null, port: null })).toBe(false);
	});

	test('direct env missing host is rejected', () => {
		expect(isSelfInspectCandidate({ connectionType: 'direct', protocol: 'http', host: null, port: 2375 })).toBe(false);
	});

	test('direct env missing port is rejected', () => {
		expect(isSelfInspectCandidate({ connectionType: 'direct', protocol: 'http', host: 'socket-proxy', port: null })).toBe(false);
	});

	test('null connectionType is rejected', () => {
		expect(isSelfInspectCandidate({ connectionType: null, protocol: 'http', host: 'socket-proxy', port: 2375 })).toBe(false);
	});
});
