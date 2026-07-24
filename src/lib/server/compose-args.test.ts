import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildComposeOperationArgs, shouldRunSeparateBuildStep } from './compose-args';

describe('buildComposeOperationArgs', () => {
	it('does not pass --build or --no-cache on plain up', () => {
		const args = buildComposeOperationArgs('up', {});

		assert.deepEqual(args, ['up', '-d', '--remove-orphans']);
	});

	it('passes --build on up when build is requested without disabling cache', () => {
		const args = buildComposeOperationArgs('up', { build: true });

		assert.deepEqual(args, ['up', '-d', '--remove-orphans', '--build']);
	});

	it('never leaks --no-cache into up, even when noBuildCache is requested', () => {
		const args = buildComposeOperationArgs('up', { build: true, noBuildCache: true });

		assert.ok(!args.includes('--no-cache'), `expected no --no-cache in: ${args.join(' ')}`);
	});

	it('omits --build on up when noBuildCache is requested (separate build step handles it)', () => {
		const args = buildComposeOperationArgs('up', { build: true, noBuildCache: true });

		assert.ok(!args.includes('--build'), `expected no --build in: ${args.join(' ')}`);
	});

	it('includes --force-recreate, --pull and the service name on up', () => {
		const args = buildComposeOperationArgs('up', {
			forceRecreate: true,
			pullPolicy: 'always',
			serviceName: 'web'
		});

		assert.deepEqual(args, ['up', '-d', '--remove-orphans', '--force-recreate', '--pull', 'always', 'web']);
	});

	it('build operation passes --no-cache when requested', () => {
		const args = buildComposeOperationArgs('build', { noBuildCache: true });

		assert.deepEqual(args, ['build', '--no-cache']);
	});

	it('build operation omits --no-cache when not requested', () => {
		const args = buildComposeOperationArgs('build', { noBuildCache: false });

		assert.deepEqual(args, ['build']);
	});

	it('build operation scopes to a single service', () => {
		const args = buildComposeOperationArgs('build', { noBuildCache: true, serviceName: 'web' });

		assert.deepEqual(args, ['build', '--no-cache', 'web']);
	});

	it('down passes --volumes only when removeVolumes is requested', () => {
		assert.deepEqual(buildComposeOperationArgs('down', {}), ['down', '--remove-orphans']);
		assert.deepEqual(buildComposeOperationArgs('down', { removeVolumes: true }), ['down', '--remove-orphans', '--volumes']);
	});

	it('pull scopes to a single service when requested', () => {
		assert.deepEqual(buildComposeOperationArgs('pull', {}), ['pull']);
		assert.deepEqual(buildComposeOperationArgs('pull', { serviceName: 'web' }), ['pull', 'web']);
	});
});

describe('shouldRunSeparateBuildStep', () => {
	it('runs the build step for local socket deployments (no env)', () => {
		assert.equal(shouldRunSeparateBuildStep(true, true, undefined), true);
	});

	it('runs the build step for direct TCP deployments', () => {
		assert.equal(shouldRunSeparateBuildStep(true, true, 'direct'), true);
	});

	it('does not run the build step for hawser-standard deployments', () => {
		assert.equal(shouldRunSeparateBuildStep(true, true, 'hawser-standard'), false);
	});

	it('does not run the build step for hawser-edge deployments', () => {
		assert.equal(shouldRunSeparateBuildStep(true, true, 'hawser-edge'), false);
	});

	it('does not run the build step when noBuildCache is not requested', () => {
		assert.equal(shouldRunSeparateBuildStep(true, false, 'socket'), false);
	});

	it('does not run the build step when build is not requested', () => {
		assert.equal(shouldRunSeparateBuildStep(false, true, 'socket'), false);
	});
});
