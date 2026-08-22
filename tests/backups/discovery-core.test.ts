/**
 * Unit tests for backups/discovery-core.ts — the pure mount → volume-bind
 * mapping. No docker, no DB.
 */
import { describe, it, expect } from 'bun:test';
import {
	discoverVolumesFromMounts,
	filterSelectedVolumes,
	discoverVolumes,
	DiscoveryInspectError,
	type Mount,
} from '../../src/lib/server/backups/discovery-core';

const vol = (name: string): Mount => ({ Type: 'volume', Name: name, Destination: `/data/${name}` });
const bind = (source: string, dest: string): Mount => ({ Type: 'bind', Source: source, Destination: dest });

describe('discoverVolumesFromMounts — named volumes', () => {
	it('maps a named volume to a :ro bind keyed on its name', () => {
		const r = discoverVolumesFromMounts([{ name: 'app', mounts: [vol('data')] }]);
		expect(r.volumes).toEqual([{ key: 'data', bind: 'data:/volumes/data:ro', name: 'data', type: 'volume', source: 'data' }]);
		expect(r.skipped).toEqual([]);
	});
	it('de-duplicates a volume shared across containers (captured once)', () => {
		const r = discoverVolumesFromMounts([
			{ name: 'a', mounts: [vol('shared')] },
			{ name: 'b', mounts: [vol('shared')] },
		]);
		expect(r.volumes.map((v) => v.name)).toEqual(['shared']);
	});
});

describe('discoverVolumesFromMounts — bind mounts', () => {
	it('maps a bind to a sanitized /volumes key', () => {
		const r = discoverVolumesFromMounts([{ name: 'a', mounts: [bind('/srv/host', '/etc/app')] }]);
		expect(r.volumes).toEqual([{ key: 'etc_app__host', bind: '/srv/host:/volumes/etc_app__host:ro', name: '/etc/app', type: 'bind', source: '/srv/host' }]);
	});
	it('de-duplicates identical (source,destination) bind pairs', () => {
		const r = discoverVolumesFromMounts([
			{ name: 'a', mounts: [bind('/srv/x', '/data')] },
			{ name: 'b', mounts: [bind('/srv/x', '/data')] },
		]);
		expect(r.volumes).toHaveLength(1);
	});
	it('captures distinct binds that map to the same destination under unique keys', () => {
		// Two different sources → same container dest must both be captured, and get
		// DISTINCT /volumes keys so restic doesn't overwrite one with the other.
		const r = discoverVolumesFromMounts([
			{ name: 'a', mounts: [bind('/srv/one', '/data')] },
			{ name: 'b', mounts: [bind('/srv/two', '/data')] },
		]);
		expect(r.volumes).toHaveLength(2);
		const keys = r.volumes.map((v) => v.key);
		expect(new Set(keys).size).toBe(2); // unique keys
	});
	it('sanitizes shell-unsafe characters in the key', () => {
		const r = discoverVolumesFromMounts([{ name: 'a', mounts: [bind('/srv/x', '/data/$(id)')] }]);
		expect(r.volumes[0].key).toMatch(/^[A-Za-z0-9._-]+$/);
	});
	it('a named volume and a bind whose slug equals the volume name get DISTINCT keys (no shadow)', () => {
		// A bind to /data slugs to key "data"; a named volume "data" would ALSO claim key
		// "data" -> both map to /volumes/data, the second :ro helper bind shadows the first,
		// and restic captures only one (silent data loss). safeKey must disambiguate them.
		const r = discoverVolumesFromMounts([
			{ name: 'a', mounts: [bind('/host/data', '/data'), vol('data')] },
		]);
		expect(r.volumes).toHaveLength(2);
		const keys = r.volumes.map((v) => v.key);
		expect(new Set(keys).size).toBe(2);                 // no collision
		expect(new Set(r.volumes.map((v) => `/volumes/${v.key}`)).size).toBe(2); // distinct mount paths
		// the named volume keeps its name/source (restore rebinds by source, not key)
		const namedVol = r.volumes.find((v) => v.type === 'volume');
		expect(namedVol?.name).toBe('data');
		expect(namedVol?.source).toBe('data');
	});
});

describe('discoverVolumesFromMounts — unsupported mounts are SKIPPED, not dropped silently', () => {
	it('reports tmpfs / cluster / unknown as skipped with a reason', () => {
		const r = discoverVolumesFromMounts([{
			name: 'a',
			mounts: [
				{ Type: 'tmpfs', Destination: '/tmp' },
				{ Type: 'cluster', Destination: '/csi' },
				{ Type: 'weird', Destination: '/x' },
				vol('keep'),
			],
		}]);
		expect(r.volumes.map((v) => v.name)).toEqual(['keep']);
		expect(r.skipped.map((s) => s.type).sort()).toEqual(['cluster', 'tmpfs', 'weird']);
		for (const s of r.skipped) expect(s.reason).toContain('not backed up');
	});
	it('skips malformed mounts (volume w/o name, bind w/o source) without capturing', () => {
		const r = discoverVolumesFromMounts([{
			name: 'a',
			mounts: [
				{ Type: 'volume' }, // no Name
				{ Type: 'bind', Destination: '/x' }, // no Source
			],
		}]);
		expect(r.volumes).toEqual([]);
	});
});

describe('filterSelectedVolumes', () => {
	const discovered = [
		{ key: 'data', bind: 'data:/volumes/data:ro', name: 'data', type: 'volume' as const, source: 'data' },
		{ key: 'etc_app', bind: '/srv:/volumes/etc_app:ro', name: '/etc/app', type: 'bind' as const, source: '/srv' },
	];
	it('null selection = all volumes', () => {
		expect(filterSelectedVolumes(discovered, null)).toEqual(discovered);
	});
	it('matches by name (volume name or bind destination)', () => {
		expect(filterSelectedVolumes(discovered, ['data']).map((v) => v.key)).toEqual(['data']);
		expect(filterSelectedVolumes(discovered, ['/etc/app']).map((v) => v.key)).toEqual(['etc_app']);
	});
	it('matches by key too', () => {
		expect(filterSelectedVolumes(discovered, ['etc_app']).map((v) => v.key)).toEqual(['etc_app']);
	});
	it('empty selection = back up nothing', () => {
		expect(filterSelectedVolumes(discovered, [])).toEqual([]);
	});
});

describe('discoverVolumesFromMounts — sockets and host system paths are skipped', () => {
	it('skips /var/run/docker.sock (not a backup target, even under "backup all")', () => {
		const r = discoverVolumesFromMounts([
			{ name: 'dockhand', mounts: [bind('/var/run/docker.sock', '/var/run/docker.sock'), bind('/srv/app-data', '/app/data')] },
		]);
		expect(r.volumes.map((v) => v.name)).toEqual(['/app/data']);
		expect(r.skipped.some((s) => s.destination === '/var/run/docker.sock' && /socket or host system path/.test(s.reason))).toBe(true);
	});

	it('skips host system paths (/proc, /sys) but keeps real data binds', () => {
		const r = discoverVolumesFromMounts([
			{ name: 'monitor', mounts: [bind('/proc', '/host/proc'), bind('/sys', '/host/sys'), bind('/srv/metrics', '/data')] },
		]);
		expect(r.volumes.map((v) => v.name)).toEqual(['/data']);
		expect(r.skipped.filter((s) => /socket or host system path/.test(s.reason)).length).toBe(2);
	});
});

describe('discoverVolumes — FAIL CLOSED on any inspect failure', () => {
	const containers = [{ id: 'c1', name: 'web' }, { id: 'c2', name: 'db' }];

	it('aggregates mounts across all containers when every inspect succeeds', async () => {
		const inspect = async (id: string): Promise<Mount[]> =>
			id === 'c1' ? [vol('web-data')] : [vol('db-data')];
		const r = await discoverVolumes(containers, null, null, inspect);
		expect(r.volumes.map((v) => v.name).sort()).toEqual(['db-data', 'web-data']);
	});

	it('throws DiscoveryInspectError if ONE container fails to inspect (never a partial backup)', async () => {
		const inspect = async (id: string): Promise<Mount[]> => {
			if (id === 'c2') throw new Error('daemon hiccup');
			return [vol('web-data')];
		};
		await expect(discoverVolumes(containers, null, null, inspect)).rejects.toThrow(DiscoveryInspectError);
		// and the error names the offending container
		await expect(discoverVolumes(containers, null, null, inspect)).rejects.toThrow(/db/);
	});

	it('applies the selection filter after a fully-successful discovery', async () => {
		const inspect = async (id: string): Promise<Mount[]> =>
			id === 'c1' ? [vol('keep')] : [vol('drop')];
		const r = await discoverVolumes(containers, null, ['keep'], inspect);
		expect(r.volumes.map((v) => v.name)).toEqual(['keep']);
	});
});
