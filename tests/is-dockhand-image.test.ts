/**
 * isDockhandImage - whether a container image is Dockhand's own, so its
 * container renders the app mark instead of an auto-matched / generic icon.
 */

import { describe, test, expect } from 'bun:test';
import { isDockhandImage } from '../src/lib/utils/icons';

describe('isDockhandImage - matches Dockhand images', () => {
	test('official org, with tag', () => {
		expect(isDockhandImage('fnsys/dockhand:v1.0.47')).toBe(true);
	});
	test('official org, no tag', () => {
		expect(isDockhandImage('fnsys/dockhand')).toBe(true);
	});
	test('finsys spelling variant', () => {
		expect(isDockhandImage('finsys/dockhand:latest')).toBe(true);
	});
	test('docker.io fully qualified', () => {
		expect(isDockhandImage('docker.io/fnsys/dockhand:v1.0.47')).toBe(true);
	});
	test('private registry host / dockhand', () => {
		expect(isDockhandImage('registry.bor6.pl/dockhand:0a9de97e')).toBe(true);
	});
	test('private registry with port', () => {
		expect(isDockhandImage('registry.bor6.pl:5000/dockhand')).toBe(true);
	});
	test('digest pinned', () => {
		expect(isDockhandImage('fnsys/dockhand@sha256:abc123')).toBe(true);
	});
});

describe('isDockhandImage - does NOT match', () => {
	test('unrelated image', () => {
		expect(isDockhandImage('postgres:15.2')).toBe(false);
	});
	test('a different app named dockhand under someone else\'s Docker Hub org', () => {
		// A bare `<org>/dockhand` on Docker Hub (org has no dot/port) is too ambiguous
		// to claim as ours - only the official org or a registry host qualifies.
		expect(isDockhandImage('someuser/dockhand')).toBe(false);
	});
	test('substring in a longer name is not a match', () => {
		expect(isDockhandImage('fnsys/dockhand-agent')).toBe(false);
		expect(isDockhandImage('fnsys/not-dockhand')).toBe(false);
	});
	test('empty / null / undefined', () => {
		expect(isDockhandImage('')).toBe(false);
		expect(isDockhandImage(null)).toBe(false);
		expect(isDockhandImage(undefined)).toBe(false);
	});
});
