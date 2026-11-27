import { describe, test, expect } from 'bun:test';
import { extractMaterializableEnvFiles, loadForScratchCheck, referencesOutsideScratchDir } from '../../src/lib/server/compose-validate/env-file-paths';

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

// Compose Validate runs `docker compose config` inside Dockhand. A reference that leaves the
// scratch dir would read Dockhand's own files (the encryption key, the DB) and echo them back,
// so such a compose is never handed to config.
describe('referencesOutsideScratchDir', () => {
	const svc = (s: Record<string, unknown>) => ({ services: { web: { image: 'nginx', ...s } } });

	test('a plain compose with relative, contained references is fine', () => {
		expect(referencesOutsideScratchDir(svc({}))).toBe(false);
		expect(referencesOutsideScratchDir(svc({ env_file: ['.env', 'conf/app.env'], build: '.' }))).toBe(false);
		expect(referencesOutsideScratchDir(svc({ build: { context: './app', dockerfile: 'Dockerfile' } }))).toBe(false);
	});

	test.each([
		['absolute env_file', svc({ env_file: '/app/data/.encryption_key' })],
		['env_file map form', svc({ env_file: [{ path: '/app/data/db/dockhand.db', required: false }] })],
		['.. env_file', svc({ env_file: ['../../app/data/.encryption_key'] })],
		['interpolated env_file', svc({ env_file: '${KEYFILE}' })],
		['label_file', svc({ label_file: '/etc/passwd' })],
		['build string', svc({ build: '/app/data' })],
		['build context', svc({ build: { context: '../..' } })],
		['dockerfile', svc({ build: { context: '.', dockerfile: '/app/data/.encryption_key' } })],
		['additional_contexts map', svc({ build: { context: '.', additional_contexts: { data: '/app/data' } } })],
		['additional_contexts list', svc({ build: { context: '.', additional_contexts: ['data=/app/data'] } })],
		['extends.file', svc({ extends: { file: '/app/data/x.yml', service: 'a' } })],
		['include string', { include: ['/app/data/x.yml'], services: {} }],
		['include object', { include: [{ path: ['ok.yml', '../x.yml'] }], services: {} }],
		['include env_file', { include: [{ path: 'ok.yml', env_file: '/app/data/.encryption_key' }], services: {} }],
		['remote include', { include: ['oci://registry/x'], services: {} }],
		['secrets file', { services: {}, secrets: { k: { file: '/app/data/.encryption_key' } } }],
		['configs file', { services: {}, configs: { c: { file: '../c' } } }]
	])('%s leaves the scratch dir', (_name, doc) => {
		expect(referencesOutsideScratchDir(doc)).toBe(true);
	});
});

// Compose decodes YAML tags, so the check must read the same path Compose will.
describe('loadForScratchCheck', () => {
	test('a !!binary path does not load, so validate falls back to the local parser', () => {
		const src = 'services:\n  web:\n    image: nginx\n    env_file: !!binary L2FwcC9kYXRhLy5lbmNyeXB0aW9uX2tleQ==\n';
		expect(loadForScratchCheck(src)).toBeNull();
	});

	test('a path pulled in through a merge key is still seen', () => {
		const src = 'x-base: &base\n  env_file: /app/data/.encryption_key\nservices:\n  web:\n    <<: *base\n    image: nginx\n';
		expect(referencesOutsideScratchDir(loadForScratchCheck(src))).toBe(true);
	});

	test('an ordinary compose loads and passes', () => {
		const src = 'services:\n  web:\n    image: nginx\n    ports: ["80:80"]\n    env_file: .env\n';
		const doc = loadForScratchCheck(src);
		expect(doc).not.toBeNull();
		expect(referencesOutsideScratchDir(doc)).toBe(false);
	});
});
