import { describe, test, expect } from 'bun:test';
import { parseImageNameAndTag } from '../src/lib/server/scheduler/tasks/update-utils';

describe('parseImageNameAndTag', () => {
	test('adds latest tag when no tag specified', () => {
		expect(parseImageNameAndTag('nginx')).toEqual(['nginx', 'latest']);
	});

	test('splits simple name:tag', () => {
		expect(parseImageNameAndTag('nginx:1.25')).toEqual(['nginx', '1.25']);
		expect(parseImageNameAndTag('redis:alpine')).toEqual(['redis', 'alpine']);
	});

	test('handles registry with port and tag', () => {
		expect(parseImageNameAndTag('registry.example.com:5000/myimage:v1')).toEqual([
			'registry.example.com:5000/myimage',
			'v1'
		]);
	});

	test('handles registry with port and no tag', () => {
		expect(parseImageNameAndTag('registry.example.com:5000/myimage')).toEqual([
			'registry.example.com:5000/myimage',
			'latest'
		]);
	});

	test('handles digest-based images', () => {
		const digest = 'nginx@sha256:abc123def456';
		expect(parseImageNameAndTag(digest)).toEqual([digest, '']);
	});

	test('handles dockhand-pending suffix', () => {
		expect(parseImageNameAndTag('nginx:latest-dockhand-pending')).toEqual([
			'nginx',
			'latest-dockhand-pending'
		]);
	});

	test('handles namespaced images', () => {
		expect(parseImageNameAndTag('library/nginx:latest')).toEqual(['library/nginx', 'latest']);
		expect(parseImageNameAndTag('ghcr.io/finsys/dockhand:v1.0.0')).toEqual([
			'ghcr.io/finsys/dockhand',
			'v1.0.0'
		]);
	});

	test('handles latest tag explicitly', () => {
		expect(parseImageNameAndTag('nginx:latest')).toEqual(['nginx', 'latest']);
	});
});
