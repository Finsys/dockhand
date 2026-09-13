/**
 * Unit tests for backups/restore-core.ts — resolving a snapshot volume `key`
 * back to the live bind an in-place restore writes to. No docker, no DB.
 *
 * The safety property under test: a BIND key must resolve to its ABSOLUTE host
 * path, never a slug. A slug source would make docker auto-create a fresh named
 * volume, so the restore would write to an orphan and never touch the real host
 * path — silent data loss. When the source can't be recovered we must THROW.
 */
import { describe, it, expect } from 'bun:test';
import { resolveBindFromMetadata, type SnapshotMetadata } from '../../src/lib/server/backups/restore-core';
import { BackupError } from '../../src/lib/server/backups/models';

describe('resolveBindFromMetadata — enriched volumes[]', () => {
	it('a bind key resolves to <absoluteHostSource>:/volumes/<key>:rw (never a slug)', () => {
		const meta: SnapshotMetadata = {
			volumes: [{ key: 'data_config', name: '/data/config', source: '/data/config', type: 'bind' }],
		};
		const { bind, include } = resolveBindFromMetadata(meta, 'data_config');
		expect(bind).toBe('/data/config:/volumes/data_config:rw');
		expect(include).toBe('/volumes/data_config');
		// the source (part before the first colon) must be an absolute host path
		expect(bind.split(':')[0].startsWith('/')).toBe(true);
	});

	it('a named-volume key resolves to <name>:/volumes/<name>:rw', () => {
		const meta: SnapshotMetadata = {
			volumes: [{ key: 'pgdata', name: 'pgdata', source: 'pgdata', type: 'volume' }],
		};
		expect(resolveBindFromMetadata(meta, 'pgdata')).toEqual({
			bind: 'pgdata:/volumes/pgdata:rw',
			include: '/volumes/pgdata',
			source: 'pgdata',
			type: 'volume',
		});
	});

	it('THROWS if an enriched bind entry has a non-absolute source (never slug-binds)', () => {
		const meta: SnapshotMetadata = {
			volumes: [{ key: 'data_config', name: '/data/config', source: 'data_config', type: 'bind' }],
		};
		expect(() => resolveBindFromMetadata(meta, 'data_config')).toThrow(BackupError);
	});
});

describe('resolveBindFromMetadata — recovery from stored docker inspect Mounts', () => {
	it('recovers a bind source from container.Mounts by matching the destination slug', () => {
		const meta: SnapshotMetadata = {
			container: { Mounts: [{ Type: 'bind', Source: '/srv/app', Destination: '/etc/app' }] },
		};
		// safeKey('/etc/app') === 'etc_app'
		expect(resolveBindFromMetadata(meta, 'etc_app')).toEqual({
			bind: '/srv/app:/volumes/etc_app:rw',
			include: '/volumes/etc_app',
			source: '/srv/app',
			type: 'bind',
		});
	});

	it('recovers a named volume source from container.Mounts by name', () => {
		const meta: SnapshotMetadata = {
			container: { Mounts: [{ Type: 'volume', Name: 'pgdata', Destination: '/var/lib/pg' }] },
		};
		expect(resolveBindFromMetadata(meta, 'pgdata')).toEqual({
			bind: 'pgdata:/volumes/pgdata:rw',
			include: '/volumes/pgdata',
			source: 'pgdata',
			type: 'volume',
		});
	});
});

describe('resolveBindFromMetadata — fail loud when a bind source cannot be recovered', () => {
	it('THROWS for a bind key present only as a legacy destination string (no source stored)', () => {
		// Pre-enrichment snapshots stored volumes as string[] of names/destinations.
		// '/data/config' slugs to 'data_config' but carries no source ⇒ must refuse.
		const meta: SnapshotMetadata = { volumes: ['/data/config'] };
		expect(() => resolveBindFromMetadata(meta, 'data_config')).toThrow(BackupError);
		expect(() => resolveBindFromMetadata(meta, 'data_config')).toThrow(/cannot resolve the original location/);
	});

	it('THROWS for a bind key from an inspect Mount with no Source', () => {
		const meta: SnapshotMetadata = {
			container: { Mounts: [{ Type: 'bind', Destination: '/etc/app' }] },
		};
		expect(() => resolveBindFromMetadata(meta, 'etc_app')).toThrow(BackupError);
	});
});

describe('resolveBindFromMetadata — named-volume fallback (key === name, no ambiguity)', () => {
	it('a legacy named-volume key (string equals key) binds directly', () => {
		const meta: SnapshotMetadata = { volumes: ['pgdata'] };
		expect(resolveBindFromMetadata(meta, 'pgdata')).toEqual({
			bind: 'pgdata:/volumes/pgdata:rw',
			include: '/volumes/pgdata',
			source: 'pgdata',
			type: 'volume',
		});
	});

	it('with no metadata at all, a bare key binds directly as a named volume', () => {
		expect(resolveBindFromMetadata(null, 'pgdata')).toEqual({
			bind: 'pgdata:/volumes/pgdata:rw',
			include: '/volumes/pgdata',
			source: 'pgdata',
			type: 'volume',
		});
	});
});
