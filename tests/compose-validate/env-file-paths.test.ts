import { describe, test, expect } from 'bun:test';
import { extractMaterializableEnvFiles } from '../../src/lib/server/compose-validate/env-file-paths';

// Compose Validate runs `docker compose config` in a scratch temp dir. A referenced env_file
// that lives in the user's stack dir is absent there, so config falsely reports "not found".
// extractMaterializableEnvFiles finds the temp-dir-safe paths to pre-create as empty files.

describe('extractMaterializableEnvFiles', () => {
	test('list form: env_file: [.env]', () => {
		const doc = { services: { web: { env_file: ['.env'] } } };
		expect(extractMaterializableEnvFiles(doc)).toEqual(['.env']);
	});

	test('string form: env_file: prod.env', () => {
		const doc = { services: { web: { env_file: 'prod.env' } } };
		expect(extractMaterializableEnvFiles(doc)).toEqual(['prod.env']);
	});

	test('map form: env_file: [{path, required}]', () => {
		const doc = { services: { web: { env_file: [{ path: 'a.env', required: false }, { path: 'b.env' }] } } };
		expect(extractMaterializableEnvFiles(doc).sort()).toEqual(['a.env', 'b.env']);
	});

	test('nested relative path (config/.env) is kept', () => {
		const doc = { services: { web: { env_file: ['config/.env'] } } };
		expect(extractMaterializableEnvFiles(doc)).toEqual(['config/.env']);
	});

	test('dedupes across services', () => {
		const doc = { services: { a: { env_file: '.env' }, b: { env_file: ['.env', 'x.env'] } } };
		expect(extractMaterializableEnvFiles(doc).sort()).toEqual(['.env', 'x.env']);
	});

	test('absolute paths are EXCLUDED (cannot / must not materialize)', () => {
		const doc = { services: { web: { env_file: ['/etc/app.env', 'C:\\app.env'] } } };
		expect(extractMaterializableEnvFiles(doc)).toEqual([]);
	});

	test('parent-escaping paths are EXCLUDED', () => {
		const doc = { services: { web: { env_file: ['../secret.env', 'a/../../b.env'] } } };
		expect(extractMaterializableEnvFiles(doc)).toEqual([]);
	});

	test('no services / no env_file -> empty', () => {
		expect(extractMaterializableEnvFiles({})).toEqual([]);
		expect(extractMaterializableEnvFiles({ services: { web: { image: 'nginx' } } })).toEqual([]);
		expect(extractMaterializableEnvFiles(null)).toEqual([]);
	});

	test('blank / non-string entries are ignored', () => {
		const doc = { services: { web: { env_file: ['', '  ', 42, { required: true }] } } };
		expect(extractMaterializableEnvFiles(doc as any)).toEqual([]);
	});
});
