import { describe, it, expect } from 'bun:test';
import { volumeDedupKey, volumeStorageKey, safeKey } from '../src/lib/utils/volume-identity';
import { discoverVolumesFromMounts } from '../src/lib/server/backups/discovery-core';
import { normalizeStackMounts } from '../src/lib/utils/mounts';

describe('volumeDedupKey', () => {
	it('a named volume is identified by its name', () => {
		expect(volumeDedupKey({ type: 'volume', source: 'db', destination: '/data', name: 'db' })).toBe('vol:db');
	});
	it('a bind is identified by (source, destination) - two /data binds from different hosts differ', () => {
		const a = volumeDedupKey({ type: 'bind', source: '/mnt/gitea/data', destination: '/data' });
		const b = volumeDedupKey({ type: 'bind', source: '/mnt/gitea-runner/data', destination: '/data' });
		expect(a).not.toBe(b);
	});
	it('the same bind (source AND destination) has the same identity', () => {
		const a = volumeDedupKey({ type: 'bind', source: '/host/x', destination: '/data' });
		const b = volumeDedupKey({ type: 'bind', source: '/host/x', destination: '/data' });
		expect(a).toBe(b);
	});
});

describe('volumeStorageKey', () => {
	it('encodes the source tail so two binds sharing a destination get distinct readable keys (#1373)', () => {
		const taken = new Set<string>();
		const a = volumeStorageKey({ type: 'bind', source: '/mnt/cache/appdata/gitea/data', destination: '/data' }, taken);
		const b = volumeStorageKey({ type: 'bind', source: '/mnt/cache/appdata/gitea-runner/data', destination: '/data' }, taken);
		expect(a).toBe('data__gitea_data');
		expect(b).toBe('data__gitea-runner_data');
		expect(a).not.toBe(b);
	});
	it('a named volume keys on its name', () => {
		expect(volumeStorageKey({ type: 'volume', source: 'db', destination: '/data', name: 'db' })).toBe('db');
	});
	it('collision-suffixes when two mounts would slug to the same key', () => {
		const taken = new Set<string>();
		const a = volumeStorageKey({ type: 'bind', source: '/a/data', destination: '/data' }, taken);
		const b = volumeStorageKey({ type: 'bind', source: '/a/data', destination: '/DATA' }, taken); // same tail+dest slug collision path
		expect(a).not.toBe(b);
	});
	it('produces a shell-safe key', () => {
		const k = volumeStorageKey({ type: 'bind', source: '/srv/$(id)', destination: '/data/$(x)' });
		expect(k).toMatch(/^[A-Za-z0-9._-]+$/);
	});
});

describe('safeKey', () => {
	it('slugs unsafe chars and suffixes collisions', () => {
		const taken = new Set<string>();
		expect(safeKey('/etc/app', taken)).toBe('etc_app');
		expect(safeKey('/etc/app', taken)).toBe('etc_app_2');
	});
});

// The whole point of the extraction: server discovery and the UI picker compute IDENTICAL keys
// for the same mounts, so the picker can't drift from what a backup actually captures (#1373).
describe('server discovery and UI picker agree on keys', () => {
	it('two containers, two /data binds from different sources -> same keys on both sides', () => {
		const containers = [
			{ name: 'gitea', mounts: [{ Type: 'bind', Source: '/mnt/cache/appdata/gitea/data', Destination: '/data' }] },
			{ name: 'gitea-runner', mounts: [{ Type: 'bind', Source: '/mnt/cache/appdata/gitea-runner/data', Destination: '/data' }] },
		];
		const serverKeys = discoverVolumesFromMounts(containers).volumes.map((v) => v.key).sort();
		const uiKeys = normalizeStackMounts(
			containers.map((c) => ({ Mounts: c.mounts }))
		).map((v) => v.key).sort();
		expect(uiKeys).toEqual(serverKeys);
		expect(serverKeys).toEqual(['data__gitea-runner_data', 'data__gitea_data']);
	});

	it('a mixed named-volume + bind stack agrees on keys across both sides', () => {
		const containers = [
			{ name: 'a', mounts: [{ Type: 'volume', Name: 'shared', Destination: '/data' }, { Type: 'bind', Source: '/host/conf', Destination: '/conf' }] },
			{ name: 'b', mounts: [{ Type: 'volume', Name: 'shared', Destination: '/data' }] },
		];
		const serverKeys = discoverVolumesFromMounts(containers).volumes.map((v) => v.key).sort();
		const uiKeys = normalizeStackMounts(containers.map((c) => ({ Mounts: c.mounts }))).map((v) => v.key).sort();
		expect(uiKeys).toEqual(serverKeys);
	});
});
