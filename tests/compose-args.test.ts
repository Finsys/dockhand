import { describe, it, expect } from 'bun:test';
import { buildComposeOperationArgs, shouldRunSeparateBuildStep } from '../src/lib/server/compose-args';

describe('buildComposeOperationArgs', () => {
	it('plain up: no --build, no --no-cache (back-compat, the common case)', () => {
		const a = buildComposeOperationArgs('up', {});
		expect(a).toEqual(['up', '-d', '--remove-orphans']);
	});

	it('up with build (no no-cache): keeps --build exactly as before', () => {
		const a = buildComposeOperationArgs('up', { build: true });
		expect(a).toContain('--build');
		expect(a).not.toContain('--no-cache');
	});

	it('up never carries --no-cache, even when noBuildCache is requested (#1479)', () => {
		const a = buildComposeOperationArgs('up', { build: true, noBuildCache: true });
		expect(a).not.toContain('--no-cache');
	});

	it('up omits --build when a no-cache rebuild is requested (the separate build step handles it)', () => {
		const a = buildComposeOperationArgs('up', { build: true, noBuildCache: true });
		expect(a).not.toContain('--build');
	});

	it('up passes forceRecreate, pull policy, and a target service', () => {
		const a = buildComposeOperationArgs('up', { forceRecreate: true, pullPolicy: 'always', serviceName: 'web' });
		expect(a).toEqual(['up', '-d', '--remove-orphans', '--force-recreate', '--pull', 'always', 'web']);
	});

	it('build operation carries --no-cache only when requested', () => {
		expect(buildComposeOperationArgs('build', { noBuildCache: true })).toEqual(['build', '--no-cache']);
		expect(buildComposeOperationArgs('build', { noBuildCache: false })).toEqual(['build']);
	});

	it('build operation scopes to a single service when given', () => {
		expect(buildComposeOperationArgs('build', { noBuildCache: true, serviceName: 'web' })).toEqual(['build', '--no-cache', 'web']);
	});

	it('down / stop / start / restart / pull unchanged (back-compat)', () => {
		expect(buildComposeOperationArgs('down', {})).toEqual(['down', '--remove-orphans']);
		expect(buildComposeOperationArgs('down', { removeVolumes: true })).toEqual(['down', '--remove-orphans', '--volumes']);
		expect(buildComposeOperationArgs('stop', {})).toEqual(['stop']);
		expect(buildComposeOperationArgs('start', {})).toEqual(['start']);
		expect(buildComposeOperationArgs('restart', {})).toEqual(['restart']);
		expect(buildComposeOperationArgs('pull', {})).toEqual(['pull']);
		expect(buildComposeOperationArgs('pull', { serviceName: 'web' })).toEqual(['pull', 'web']);
	});
});

describe('shouldRunSeparateBuildStep', () => {
	it('runs for local socket (no env) and direct when a no-cache rebuild is requested', () => {
		expect(shouldRunSeparateBuildStep(true, true, undefined)).toBe(true);
		expect(shouldRunSeparateBuildStep(true, true, 'socket')).toBe(true);
		expect(shouldRunSeparateBuildStep(true, true, 'direct')).toBe(true);
	});

	it('never runs for Hawser (its agent has no build op) - a no-cache request is a no-op there', () => {
		expect(shouldRunSeparateBuildStep(true, true, 'hawser-standard')).toBe(false);
		expect(shouldRunSeparateBuildStep(true, true, 'hawser-edge')).toBe(false);
	});

	it('does not run without both build and noBuildCache (back-compat: normal deploys unaffected)', () => {
		expect(shouldRunSeparateBuildStep(false, true, 'socket')).toBe(false);
		expect(shouldRunSeparateBuildStep(true, false, 'socket')).toBe(false);
		expect(shouldRunSeparateBuildStep(false, false, 'socket')).toBe(false);
		expect(shouldRunSeparateBuildStep(undefined, undefined, 'socket')).toBe(false);
	});
});
