import { describe, expect, test } from 'bun:test';
import {
	assertValidComposePaths,
	getComposePathsValidationError,
	normalizeComposePaths
} from '../src/lib/server/compose-paths';

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

	test('splits string input on newlines and commas', () => {
		expect(normalizeComposePaths('compose.yaml, compose.prod.yaml\ncompose.override.yaml')).toEqual([
			'compose.yaml',
			'compose.prod.yaml',
			'compose.override.yaml'
		]);
	});

	test('normalizes backslashes and redundant path segments', () => {
		expect(normalizeComposePaths(['deploy\\compose.yaml', './compose.override.yaml'])).toEqual([
			'deploy/compose.yaml',
			'compose.override.yaml'
		]);
	});
});

describe('getComposePathsValidationError', () => {
	test('accepts safe relative compose paths', () => {
		expect(getComposePathsValidationError(['compose.yaml', 'deploy/compose.prod.yaml'])).toBe(null);
	});

	test('rejects missing compose paths', () => {
		expect(getComposePathsValidationError([])).toContain('At least one compose file');
	});

	test('rejects absolute Unix paths', () => {
		expect(getComposePathsValidationError(['/etc/passwd'])).toContain('relative');
	});

	test('rejects absolute Windows paths', () => {
		expect(getComposePathsValidationError(['C:\\Users\\me\\compose.yaml'])).toContain('relative');
	});

	test('rejects parent directory traversal', () => {
		expect(getComposePathsValidationError(['../compose.yaml'])).toContain('parent directory');
		expect(getComposePathsValidationError(['compose/../../compose.yaml'])).toContain('parent directory');
	});

	test('rejects current directory paths', () => {
		expect(getComposePathsValidationError(['.'])).toContain('file path');
	});
});

describe('assertValidComposePaths', () => {
	test('throws when compose paths are invalid', () => {
		expect(() => assertValidComposePaths(['../compose.yaml'])).toThrow(/parent directory/);
	});
});
