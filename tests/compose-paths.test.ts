import { describe, expect, test } from 'bun:test';
import { normalizeComposePaths } from '../src/lib/server/compose-paths';

describe('normalizeComposePaths', () => {
	test('keeps ordered compose files and drops blank entries', () => {
		expect(normalizeComposePaths([
			' compose.yaml ',
			'',
			'docker-compose.prod.yaml',
			'   '
		])).toEqual(['compose.yaml', 'docker-compose.prod.yaml']);
	});

	test('falls back to the primary compose path for legacy single-file input', () => {
		expect(normalizeComposePaths(undefined, 'docker-compose.yml')).toEqual(['docker-compose.yml']);
		expect(normalizeComposePaths([], 'docker-compose.yml')).toEqual(['docker-compose.yml']);
	});
});
