import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import {
	composeFilePathList,
	parseComposePathsColumn,
	resolveEffectiveComposeFiles,
	shouldUseExplicitFFlags
} from '../src/lib/server/compose-files';

const stackDir = '/stack';

function existsComposeAndOverride(path: string): boolean {
	return path.endsWith('compose.yaml') || path.endsWith('compose.override.yaml');
}

describe('parseComposePathsColumn', () => {
	it('returns an empty array for null or undefined', () => {
		assert.deepEqual(parseComposePathsColumn(null), []);
		assert.deepEqual(parseComposePathsColumn(undefined), []);
	});

	it('parses a valid JSON array of strings', () => {
		assert.deepEqual(
			parseComposePathsColumn('["compose.yaml","compose.override.yaml"]'),
			['compose.yaml', 'compose.override.yaml']
		);
	});

	it('returns an empty array for invalid JSON', () => {
		assert.deepEqual(parseComposePathsColumn('{not json'), []);
	});

	it('returns an empty array for non-array JSON', () => {
		assert.deepEqual(parseComposePathsColumn('"compose.yaml"'), []);
	});

	it('returns an empty array when the array contains non-strings', () => {
		assert.deepEqual(parseComposePathsColumn('[42, true]'), []);
	});
});

describe('resolveEffectiveComposeFiles', () => {
	it('auto-discovers a standard override next to the primary file', () => {
		const primary = join(stackDir, 'compose.yaml');
		const override = join(stackDir, 'compose.override.yaml');

		const files = resolveEffectiveComposeFiles({
			composePath: primary,
			diskExists: existsComposeAndOverride
		});

		assert.deepEqual(composeFilePathList(files), [primary, override]);
		assert.equal(files[1].role, 'override');
		assert.equal(files[1].source, 'auto');
	});

	it('does not duplicate an override already listed in composePaths', () => {
		const primary = join(stackDir, 'compose.yaml');
		const override = join(stackDir, 'compose.override.yaml');

		const files = resolveEffectiveComposeFiles({
			composePaths: [primary, override],
			diskExists: existsComposeAndOverride
		});

		assert.deepEqual(composeFilePathList(files), [primary, override]);
		assert.equal(files[1].role, 'additional');
		assert.equal(files[1].source, 'user');
	});

	it('dedupes repeated user paths', () => {
		const primary = join(stackDir, 'compose.yaml');

		const files = resolveEffectiveComposeFiles({
			composePaths: [primary, primary],
			diskExists: (p) => p.endsWith('compose.yaml')
		});

		assert.deepEqual(composeFilePathList(files), [primary]);
	});

	it('discovers overrides next to every standard compose basename', () => {
		const cases: Array<[string, string]> = [
			['compose.yaml', 'compose.override.yaml'],
			['compose.yml', 'compose.override.yml'],
			['docker-compose.yaml', 'docker-compose.override.yaml'],
			['docker-compose.yml', 'docker-compose.override.yml']
		];

		for (const [primaryName, overrideName] of cases) {
			const primary = join(stackDir, primaryName);
			const override = join(stackDir, overrideName);
			const files = resolveEffectiveComposeFiles({
				composePath: primary,
				diskExists: (p) => p === primary || p === override
			});

			assert.deepEqual(
				composeFilePathList(files),
				[primary, override],
				`expected ${primaryName} to auto-discover ${overrideName}`
			);
			assert.equal(files[1].role, 'override');
			assert.equal(files[1].source, 'auto');
		}
	});

	it('excludes overrides that do not exist on disk', () => {
		const primary = join(stackDir, 'compose.yaml');

		const files = resolveEffectiveComposeFiles({
			composePath: primary,
			diskExists: () => false
		});

		assert.deepEqual(composeFilePathList(files), [primary]);
	});

	it('falls back to composePath when composePaths is empty', () => {
		const primary = join(stackDir, 'compose.yaml');

		const files = resolveEffectiveComposeFiles({
			composePaths: [],
			composePath: primary,
			diskExists: () => false
		});

		assert.deepEqual(composeFilePathList(files), [primary]);
	});

	it('returns an empty list when neither path is given', () => {
		assert.deepEqual(resolveEffectiveComposeFiles({}), []);
	});
});

describe('shouldUseExplicitFFlags', () => {
	it('requires explicit -f when multiple files are resolved', () => {
		const primary = join(stackDir, 'compose.yaml');
		const override = join(stackDir, 'compose.override.yaml');
		const files = resolveEffectiveComposeFiles({
			composePaths: [primary, override],
			diskExists: existsComposeAndOverride
		});

		assert.equal(shouldUseExplicitFFlags(files), true);
	});

	it('omits -f for a single standard compose basename', () => {
		for (const name of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
			assert.equal(
				shouldUseExplicitFFlags([{ path: join(stackDir, name), role: 'primary', source: 'user' }]),
				false,
				`expected ${name} to auto-discover without -f`
			);
		}
	});

	it('requires -f for a single non-standard compose basename', () => {
		const files = [{ path: join(stackDir, 'immich.yaml'), role: 'primary' as const, source: 'user' as const }];
		assert.equal(shouldUseExplicitFFlags(files), true);
	});

	it('returns false for no files', () => {
		assert.equal(shouldUseExplicitFFlags([]), false);
	});
});
