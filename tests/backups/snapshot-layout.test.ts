/**
 * Unit tests for the SnapshotLayout contract — the typed metadata.json that capture
 * PRODUCES and restore CONSUMES. The whole point is that a build->serialize->parse
 * round-trip is lossless, and a malformed/mislocated/wrong-version payload parses to
 * null (an explicit "unreadable" branch) rather than a cascade of undefineds.
 */
import { describe, test, expect } from 'bun:test';
import {
	buildSnapshotLayout,
	serializeLayout,
	parseSnapshotLayout,
	redactSnapshotLayout,
	SNAPSHOT_LAYOUT_VERSION,
	type SnapshotLayout,
} from '../../src/lib/server/backups/snapshot-layout';

const stackLayout = (): SnapshotLayout =>
	buildSnapshotLayout({
		type: 'stack',
		targetName: 'immich',
		environmentId: 3,
		backupTime: '2026-08-02T10:00:00.000Z',
		volumes: [
			{ key: 'data', name: 'data', source: 'data', type: 'volume' },
			{ key: 'cfg', name: '/config', source: '/host/appdata/config', type: 'bind' },
		],
		stack: {
			composeFileName: 'immich.yaml',
			fileList: [{ path: 'immich.yaml', bytes: 120 }, { path: 'hwaccel.yml', bytes: 40 }],
			excludedBindDirs: ['data'],
			secrets: [{ key: 'DB_PASSWORD', value: 'enc:v1:abc' }],
		},
	});

describe('buildSnapshotLayout', () => {
	test('stamps the current version', () => {
		expect(stackLayout().version).toBe(SNAPSHOT_LAYOUT_VERSION);
	});
	test('no hasStackFiles field — presence is derived from stack', () => {
		const l = stackLayout();
		expect('hasStackFiles' in l).toBe(false);
		expect(l.stack !== undefined).toBe(true); // this IS hasStackFiles
	});
});

describe('round-trip build -> serialize -> parse', () => {
	test('stack layout survives losslessly', () => {
		const parsed = parseSnapshotLayout(serializeLayout(stackLayout()));
		expect(parsed).toEqual(stackLayout());
	});

	test('bind volume source (host path) is preserved', () => {
		const parsed = parseSnapshotLayout(serializeLayout(stackLayout()));
		const bind = parsed?.volumes.find((v) => v.type === 'bind');
		expect(bind?.source).toBe('/host/appdata/config');
	});

	test('container layout (no stack) round-trips with stack undefined', () => {
		const c = buildSnapshotLayout({
			type: 'container', targetName: 'nginx', environmentId: null,
			backupTime: '2026-08-02T10:00:00.000Z', volumes: [], container: { Id: 'abc' },
		});
		const parsed = parseSnapshotLayout(serializeLayout(c));
		expect(parsed?.type).toBe('container');
		expect(parsed?.stack).toBeUndefined();
		expect(parsed?.container).toEqual({ Id: 'abc' });
	});
});

describe('parseSnapshotLayout rejects bad payloads (-> null, never throws)', () => {
	test('invalid JSON -> null', () => {
		expect(parseSnapshotLayout('{not json')).toBeNull();
	});
	test('empty string -> null', () => {
		expect(parseSnapshotLayout('')).toBeNull();
	});
	test('wrong type value -> null', () => {
		expect(parseSnapshotLayout(JSON.stringify({ version: 1, type: 'bogus', targetName: 'x' }))).toBeNull();
	});
	test('missing targetName -> null', () => {
		expect(parseSnapshotLayout(JSON.stringify({ version: 1, type: 'stack' }))).toBeNull();
	});
	test('a FUTURE version we cannot read -> null', () => {
		expect(parseSnapshotLayout(JSON.stringify({ version: 999, type: 'stack', targetName: 'x' }))).toBeNull();
	});
});

describe('pre-contract beta snapshots (missing version) are accepted as v1', () => {
	test('a payload with no version but valid shape parses', () => {
		const legacy = JSON.stringify({
			type: 'stack', targetName: 'old', environmentId: 1,
			backupTime: '2026-07-01T00:00:00.000Z',
			volumes: [{ key: 'data', name: 'data', source: 'data', type: 'volume' }],
			hasStackFiles: true, composeFileName: 'docker-compose.yml', // old flat fields ignored
		});
		const parsed = parseSnapshotLayout(legacy);
		expect(parsed).not.toBeNull();
		expect(parsed?.version).toBe(SNAPSHOT_LAYOUT_VERSION);
		expect(parsed?.type).toBe('stack');
		expect(parsed?.volumes.length).toBe(1);
	});
});

describe('defensive volume coercion', () => {
	test('a malformed volume entry is dropped, the rest survive', () => {
		const raw = JSON.stringify({
			version: 1, type: 'stack', targetName: 'x', environmentId: null, backupTime: '',
			volumes: [
				{ key: 'good', name: 'good', source: 'good', type: 'volume' },
				{ name: 'no-key', type: 'volume' },        // missing key -> dropped
				{ key: 'bad-type', type: 'nonsense' },      // bad type -> dropped
			],
		});
		const parsed = parseSnapshotLayout(raw);
		expect(parsed?.volumes.map((v) => v.key)).toEqual(['good']);
	});
});

describe('redactSnapshotLayout - never leak secrets to the client', () => {
	const containerLayout = (): SnapshotLayout =>
		buildSnapshotLayout({
			type: 'container',
			targetName: 'db',
			environmentId: 2,
			backupTime: '2026-01-01T00:00:00Z',
			volumes: [{ key: 'data', name: 'db_data', source: 'db_data', type: 'volume' }],
			container: {
				Id: 'abc123',
				Name: '/db',
				Config: {
					Image: 'postgres:16',
					Env: ['POSTGRES_PASSWORD=hunter2', 'API_KEY=sk-secret', 'PATH=/usr/bin'],
					Labels: { 'com.example.token': 'shh', 'com.docker.compose.project': 'app' },
					ExposedPorts: { '5432/tcp': {} },
				},
			},
		});

	test('strips container Config.Env (plaintext secrets) but keeps the rest of the inspect', () => {
		const red = redactSnapshotLayout(containerLayout());
		const c = red.container as any;
		expect(c.Config.Env).toBeUndefined();          // secrets gone
		expect(c.Config.Labels).toBeUndefined();        // labels can hide secrets too
		expect(c.Config.Image).toBe('postgres:16');     // non-secret inspect preserved
		expect(c.Config.ExposedPorts).toEqual({ '5432/tcp': {} });
		expect(c.Id).toBe('abc123');
	});

	test('no secret value appears anywhere in the serialized redacted output', () => {
		const red = redactSnapshotLayout(containerLayout());
		const blob = JSON.stringify(red);
		expect(blob).not.toContain('hunter2');
		expect(blob).not.toContain('sk-secret');
		expect(blob).not.toContain('shh');
	});

	test('stack secrets collapse to secretKeys names only', () => {
		const layout = buildSnapshotLayout({
			type: 'stack',
			targetName: 'immich',
			environmentId: 3,
			backupTime: '2026-01-01T00:00:00Z',
			volumes: [],
			stack: {
				composeFileName: 'compose.yaml',
				fileList: [],
				excludedBindDirs: [],
				secrets: [
					{ key: 'DB_PASSWORD', value: 'enc:v1:ciphertextAAA' },
					{ key: 'JWT_SECRET', value: 'enc:v1:ciphertextBBB' },
				],
			},
		});
		const red = redactSnapshotLayout(layout);
		expect(red.stack?.secretKeys).toEqual(['DB_PASSWORD', 'JWT_SECRET']);
		expect((red.stack as any).secrets).toBeUndefined();
		expect(red.hasStackFiles).toBe(true);
		expect(JSON.stringify(red)).not.toContain('ciphertext');
	});

	test('hasStackFiles is false and stack undefined for a container backup', () => {
		const red = redactSnapshotLayout(containerLayout());
		expect(red.hasStackFiles).toBe(false);
		expect(red.stack).toBeUndefined();
	});

	test('defensive: odd container shapes pass through without throwing', () => {
		for (const c of [undefined, null, 'a-string', 42, {}, { Config: 'not-an-object' }]) {
			const layout = buildSnapshotLayout({
				type: 'container', targetName: 't', environmentId: null,
				backupTime: '', volumes: [], container: c,
			});
			expect(() => redactSnapshotLayout(layout)).not.toThrow();
		}
	});
});
