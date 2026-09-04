import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import {
	composeFilePathList,
	composeSiblingRelPath,
	firstComposePathOutsideDir,
	parseComposePathsColumn,
	resolveEffectiveComposeFiles,
	shouldUseExplicitFFlags,
	validateComposeContentsInput,
	validateComposePathsInput
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
			['compose.yaml', 'compose.override.yml'],
			['compose.yml', 'compose.override.yml'],
			['docker-compose.yaml', 'docker-compose.override.yml'],
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

	it('does not auto-discover overrides for a multi-file set', () => {
		const primary = join(stackDir, 'compose.yaml');
		const prod = join(stackDir, 'prod.yaml');
		const override = join(stackDir, 'compose.override.yaml');

		const files = resolveEffectiveComposeFiles({
			composePaths: [primary, prod],
			diskExists: (p) => p === primary || p === prod || p === override
		});

		// Explicit `docker compose -f a -f b` never auto-loads compose.override.yaml.
		// Appending it would hand the IMPLICIT override last-file-wins precedence
		// over the explicitly selected prod.yaml.
		assert.deepEqual(composeFilePathList(files), [primary, prod]);
		assert.equal(files[1].role, 'additional');
	});

	it('treats an explicit single-file list as authoritative', () => {
		const primary = join(stackDir, 'compose.yaml');
		const override = join(stackDir, 'compose.override.yml');
		const files = resolveEffectiveComposeFiles({
			composePaths: [primary],
			diskExists: (p) => p === primary || p === override
		});

		assert.deepEqual(composeFilePathList(files), [primary]);
	});

	it('matches Compose by selecting only one override alias', () => {
		const primary = join(stackDir, 'compose.yaml');
		const yamlOverride = join(stackDir, 'compose.override.yaml');
		const ymlOverride = join(stackDir, 'compose.override.yml');
		const files = resolveEffectiveComposeFiles({
			composePath: primary,
			diskExists: (p) => p === primary || p === yamlOverride || p === ymlOverride
		});

		assert.deepEqual(composeFilePathList(files), [primary, ymlOverride]);
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

describe('firstComposePathOutsideDir', () => {
	it('accepts paths inside the base dir and empty sets', () => {
		assert.equal(firstComposePathOutsideDir(null, 'apps/web'), null);
		assert.equal(firstComposePathOutsideDir([], 'apps/web'), null);
		assert.equal(
			firstComposePathOutsideDir(['apps/web/compose.yaml', 'apps/web/override.yaml'], 'apps/web'),
			null
		);
		assert.equal(
			firstComposePathOutsideDir(['compose.yaml'], ''),
			null,
			'baseDir "" means the repo root'
		);
	});

	it('rejects paths outside the base dir, including sibling prefix tricks', () => {
		assert.equal(firstComposePathOutsideDir(['shared/common.yaml'], 'apps/web'), 'shared/common.yaml');
		assert.equal(
			firstComposePathOutsideDir(['apps/web2/compose.yaml'], 'apps/web'),
			'apps/web2/compose.yaml',
			'sibling sharing a string prefix must be rejected'
		);
	});
});

describe('validateComposePathsInput', () => {
	it('accepts undefined, null, and arrays of non-empty strings', () => {
		assert.equal(validateComposePathsInput(undefined), null);
		assert.equal(validateComposePathsInput(null), null);
		assert.equal(validateComposePathsInput(['compose.yaml', 'override.yaml']), null);
		assert.equal(validateComposePathsInput(['/stacks/1/myapp/compose.yaml']), null);
	});

	it('rejects non-arrays, non-strings, and empty strings', () => {
		assert.match(validateComposePathsInput('ab')!, /array/);
		assert.match(validateComposePathsInput(['a', 42])!, /non-empty/);
		assert.match(validateComposePathsInput([''])!, /non-empty/);
		assert.match(validateComposePathsInput(['  '])!, /non-empty/);
	});

	it('rejects traversal and non-stack filenames (arbitrary file read guard)', () => {
		assert.match(validateComposePathsInput(['/etc/passwd'])!, /not an allowed stack filename/);
		assert.match(validateComposePathsInput(['../../etc/passwd'])!, /traversal/);
		assert.match(validateComposePathsInput(['compose.yaml', '/etc/cron.d/evil'])!, /not an allowed stack filename/);
		assert.match(validateComposePathsInput(['stacks/1/app/..\\..\\secrets.yml'])!, /traversal/);
	});
});

describe('validateComposeContentsInput', () => {
	it('accepts undefined, null, and path-to-string maps', () => {
		assert.equal(validateComposeContentsInput(undefined), null);
		assert.equal(validateComposeContentsInput(null), null);
		assert.equal(validateComposeContentsInput({ 'compose.yaml': 'services: {}' }), null);
	});

	it('rejects non-objects, non-string content, and empty keys', () => {
		assert.match(validateComposeContentsInput('x')!, /object/);
		assert.match(validateComposeContentsInput([1])!, /object/);
		assert.match(validateComposeContentsInput({ 'compose.yaml': 5 })!, /string content/);
		assert.match(validateComposeContentsInput({ ' ': 'x' })!, /non-empty/);
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
		assert.equal(
			shouldUseExplicitFFlags([{ path: join(stackDir, 'compose.yaml'), role: 'primary', source: 'auto' }]),
			false
		);
	});

	it('requires -f for a user-selected standard compose basename', () => {
		for (const name of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
			assert.equal(
				shouldUseExplicitFFlags([{ path: join(stackDir, name), role: 'primary', source: 'user' }]),
				true,
				`expected ${name} to preserve the explicit selection`
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
