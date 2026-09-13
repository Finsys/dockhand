/**
 * Unit tests for backup volume/bind normalization + discovery (src/lib/utils/mounts.ts).
 *
 * Regression guard: backup UI surfaces used to open-code "Docker mounts ->
 * pickable volume list" and drifted — one dropped bind mounts entirely, one
 * never set a mount type so every row rendered as a named volume. These tests
 * lock the single shared normalizer's behavior.
 *
 * Discovery guard: EnvironmentBackupsTab used to build its whole list (stacks +
 * containers) from container labels via groupContainersForBackup — which can't
 * see a stack's sourceType and misses stopped stacks. It now takes stacks from
 * /api/stacks and only STANDALONE containers from standaloneContainers(); these
 * tests pin that standalone slice (never a stack member).
 */
import { describe, test, expect } from 'bun:test';
import {
	normalizeMounts,
	normalizeStackMounts,
	mountTypeFromHostPath,
	volumeInfoFromBind,
	groupContainersForBackup,
	volumesForStack,
	standaloneContainers
} from '../src/lib/utils/mounts';

/** The shape /api/containers actually returns (docker.ts list mapper):
 *  lowercase `labels`, `mounts: [{ type, source, destination }]`. Tests below
 *  use this shape so they can't pass on a shape the API never sends. */
const PROJECT = 'com.docker.compose.project';

describe('mountTypeFromHostPath', () => {
	test('absolute host path is a bind mount', () => {
		expect(mountTypeFromHostPath('/docker/data/backup-test/container-bind')).toBe('bind');
	});
	test('bare name (no leading slash) is a named volume', () => {
		expect(mountTypeFromHostPath('bt-container-vol')).toBe('volume');
	});
});

describe('volumeInfoFromBind — subset-backup identifier (regression)', () => {
	// The bug: EditContainerModal built the picker list with name = containerPath
	// for EVERY mount. For a named volume that's the destination (/data/a), not the
	// volume name (dhvt-vol-a) the server filters on — so a subset selection saved
	// the wrong key and the backup captured nothing. name MUST equal what
	// normalizeMounts()/discovery produce for the same volume.
	test('named volume: name is the volume NAME (hostPath), not the destination', () => {
		expect(volumeInfoFromBind({ hostPath: 'dhvt-vol-a', containerPath: '/data/a' })).toEqual({
			key: 'dhvt-vol-a', name: 'dhvt-vol-a', mountPoint: '/data/a', mountType: 'volume'
		});
	});

	test('bind: name is the container destination, source is the host path', () => {
		expect(volumeInfoFromBind({ hostPath: '/tmp/dhvt-bind', containerPath: '/data/bind' })).toEqual({
			key: 'data_bind__dhvt-bind', name: '/data/bind', mountPoint: '/data/bind', mountType: 'bind', source: '/tmp/dhvt-bind'
		});
	});

	test('bind: docker.sock is flagged unbackupable (EditContainerModal picker path)', () => {
		const out = volumeInfoFromBind({ hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' });
		expect(out.unbackupable).toBe(true);
		// a real data bind is not flagged
		expect(volumeInfoFromBind({ hostPath: '/srv/app-data', containerPath: '/app/data' }).unbackupable).toBeUndefined();
	});

	test('its name matches normalizeMounts() for the SAME named volume (both sides agree)', () => {
		const fromBind = volumeInfoFromBind({ hostPath: 'shared-vol', containerPath: '/data' });
		const fromMounts = normalizeMounts([{ type: 'volume', name: 'shared-vol', destination: '/data' }])[0];
		expect(fromBind.name).toBe(fromMounts.name); // 'shared-vol' on both — the filter can match
	});

	test('a bare .map(volumeInfoFromBind) passes the array index as `taken` and crashes (#1456)', () => {
		// EditContainerModal built the picker list with `.map(volumeInfoFromBind)`. .map passes
		// (element, index, array), so the numeric index landed in the `taken` Set param and
		// `taken.has(...)` threw "o.has is not a function", crashing the whole Backups tab. The
		// call site MUST wrap it (`.map((v) => volumeInfoFromBind(v))`). This documents the trap.
		const binds = [
			{ hostPath: '/opt/appdata/chaptarr', containerPath: '/config' },
			{ hostPath: 'named-vol', containerPath: '/data' }
		];
		expect(() => binds.map(volumeInfoFromBind)).toThrow(); // the bug: index-as-taken
		// The correct call site wraps the callback so `taken` keeps its default Set.
		const out = binds.map((v) => volumeInfoFromBind(v));
		expect(out[0].mountType).toBe('bind');
		expect(out[1].mountType).toBe('volume');
	});

	// The fnstudio-factory bug: normalizeMounts() (the picker's source) keyed a bind
	// on its host SOURCE, but the engine's selectedVolumes filter matches on the
	// container DESTINATION — so every bind picked as a subset was silently dropped
	// ("Volumes to backup: none"). Both picker normalizers must agree with the engine.
	test('bind name matches normalizeMounts() AND volumeInfoFromBind() (all three agree)', () => {
		const fromMounts = normalizeMounts([{ type: 'bind', source: '/docker/data/x/keys', destination: '/app/keys' }])[0];
		const fromBind = volumeInfoFromBind({ hostPath: '/docker/data/x/keys', containerPath: '/app/keys' });
		expect(fromMounts.name).toBe('/app/keys'); // container destination — what the engine filters on
		expect(fromMounts.name).toBe(fromBind.name); // both picker paths key identically
		expect(fromMounts.source).toBe('/docker/data/x/keys'); // host path retained for display
	});
});

describe('normalizeMounts', () => {
	test('keeps both volume and bind, with correct mountType', () => {
		const mounts = [
			{ Type: 'volume', Name: 'bt-container-vol', Destination: '/data/vol' },
			{ Type: 'bind', Source: '/docker/data/backup-test/container-bind', Destination: '/data/bind' }
		];
		const out = normalizeMounts(mounts);
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({ key: 'bt-container-vol', name: 'bt-container-vol', mountPoint: '/data/vol', mountType: 'volume' });
		// bind name is the container DESTINATION (display); key encodes destination + source tail.
		expect(out[1]).toEqual({ key: 'data_bind__container-bind', name: '/data/bind', mountPoint: '/data/bind', mountType: 'bind', source: '/docker/data/backup-test/container-bind' });
	});

	test('does NOT drop bind mounts (the EnvironmentBackupsTab bug)', () => {
		const out = normalizeMounts([
			{ Type: 'bind', Source: '/host/path', Destination: '/data/bind' }
		]);
		expect(out).toHaveLength(1);
		expect(out[0].mountType).toBe('bind');
	});

	test('tolerates lowercase (our normalized) keys', () => {
		const out = normalizeMounts([
			{ type: 'volume', name: 'v1', destination: '/data' }
		]);
		expect(out[0]).toEqual({ key: 'v1', name: 'v1', mountPoint: '/data', mountType: 'volume' });
	});

	test('skips non-volume/bind mounts (tmpfs, npipe, etc.)', () => {
		const out = normalizeMounts([
			{ Type: 'tmpfs', Destination: '/tmp' },
			{ Type: 'volume', Name: 'keep', Destination: '/data' }
		]);
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe('keep');
	});

	test('bind name is the destination; a bind with no destination falls back to source', () => {
		expect(normalizeMounts([{ Type: 'bind', Source: '/only/source', Destination: '/d' }])[0].name).toBe('/d');
		expect(normalizeMounts([{ Type: 'bind', Source: '/only/source' }])[0].name).toBe('/only/source');
		expect(normalizeMounts([{ Type: 'volume', Destination: '/only/dest' }])[0].name).toBe('/only/dest');
	});

	test('handles null / undefined / non-array input', () => {
		expect(normalizeMounts(null)).toEqual([]);
		expect(normalizeMounts(undefined)).toEqual([]);
		// @ts-expect-error deliberately wrong type
		expect(normalizeMounts('nope')).toEqual([]);
	});
});

describe('normalizeStackMounts', () => {
	test('merges multiple containers and dedupes by volume identity', () => {
		const containers = [
			{ mounts: [
				{ type: 'volume', name: 'shared-vol', destination: '/data' },
				{ type: 'bind', source: '/host/a', destination: '/a' }
			] },
			{ mounts: [
				{ type: 'volume', name: 'shared-vol', destination: '/data' }, // dup: same name -> one
				{ type: 'bind', source: '/host/b', destination: '/b' }
			] }
		];
		const out = normalizeStackMounts(containers);
		expect(out.map(v => v.name).sort()).toEqual(['/a', '/b', 'shared-vol']);
		expect(out.filter(v => v.name === 'shared-vol')).toHaveLength(1);
	});

	// #1373: two containers bind DIFFERENT host paths to the SAME container path. They are
	// different volumes - both must appear, each with a distinct, independently-selectable key.
	test('keeps two binds that share a destination but have different sources (#1373)', () => {
		const out = normalizeStackMounts([
			{ mounts: [{ type: 'bind', source: '/mnt/cache/appdata/gitea/data', destination: '/data' }] },
			{ mounts: [{ type: 'bind', source: '/mnt/cache/appdata/gitea-runner/data', destination: '/data' }] }
		]);
		expect(out).toHaveLength(2);                               // neither dropped
		expect(out.map(v => v.name)).toEqual(['/data', '/data']);  // same display destination
		expect(new Set(out.map(v => v.key)).size).toBe(2);         // distinct, selectable keys
		expect(out.map(v => v.source).sort()).toEqual([
			'/mnt/cache/appdata/gitea-runner/data', '/mnt/cache/appdata/gitea/data'
		]);
	});

	// An identical (source,destination) bind across containers is the SAME volume -> deduped once.
	test('dedupes an identical bind (same source AND destination) across containers', () => {
		const out = normalizeStackMounts([
			{ mounts: [{ type: 'bind', source: '/host/shared', destination: '/data' }] },
			{ mounts: [{ type: 'bind', source: '/host/shared', destination: '/data' }] }
		]);
		expect(out).toHaveLength(1);
	});

	test('accepts PascalCase Mounts key', () => {
		const out = normalizeStackMounts([{ Mounts: [{ Type: 'bind', Source: '/host/x', Destination: '/x' }] }]);
		expect(out).toHaveLength(1);
		expect(out[0].mountType).toBe('bind');
	});
});

// --------------------------------------------------------------------------
// Discovery layer — the recurring "no volumes detected" bug lived HERE, in the
// group/filter step that every live backup surface used to open-code. These
// lock the single shared primitive so occurrence #3 can't slip in.
// --------------------------------------------------------------------------

describe('groupContainersForBackup', () => {
	test('groups stack containers by project label, keeps standalone separate', () => {
		const containers = [
			{ name: 'web-1', labels: { [PROJECT]: 'shop' }, mounts: [{ type: 'volume', source: 'shop_db', destination: '/data' }] },
			{ name: 'worker-1', labels: { [PROJECT]: 'shop' }, mounts: [{ type: 'bind', source: '/host/logs', destination: '/logs' }] },
			{ name: 'lonely', labels: {}, mounts: [{ type: 'volume', source: 'lonely_vol', destination: '/v' }] }
		];
		const items = groupContainersForBackup(containers);
		// stacks first (alphabetical), then containers
		expect(items.map(i => `${i.type}:${i.name}`)).toEqual(['stack:shop', 'container:lonely']);
		const shop = items.find(i => i.name === 'shop')!;
		// both containers' mounts merged into the one stack item (bind keys on destination)
		expect(shop.volumes.map(v => v.name).sort()).toEqual(['/logs', 'shop_db']);
	});

	test('a stack container with volume AND bind surfaces both with correct mountType (regression shape)', () => {
		const items = groupContainersForBackup([
			{ name: 'app-1', labels: { [PROJECT]: 'mystack' }, mounts: [
				{ type: 'volume', source: 'mystack_data', destination: '/data' },
				{ type: 'bind', source: '/docker/mystack/conf', destination: '/conf' }
			] }
		]);
		expect(items).toHaveLength(1);
		const byName = Object.fromEntries(items[0].volumes.map(v => [v.name, v.mountType]));
		expect(byName['mystack_data']).toBe('volume');
		expect(byName['/conf']).toBe('bind'); // bind keys on destination
	});

	test('dedupes a shared volume across a stack\'s containers', () => {
		const items = groupContainersForBackup([
			{ name: 'a', labels: { [PROJECT]: 's' }, mounts: [{ type: 'volume', source: 'shared', destination: '/d' }] },
			{ name: 'b', labels: { [PROJECT]: 's' }, mounts: [{ type: 'volume', source: 'shared', destination: '/d' }] }
		]);
		expect(items[0].volumes.filter(v => v.name === 'shared')).toHaveLength(1);
	});

	test('sorts stacks before containers, each alphabetical', () => {
		const items = groupContainersForBackup([
			{ name: 'zeta', labels: {}, mounts: [] },
			{ name: 'alpha', labels: {}, mounts: [] },
			{ name: 'b-1', labels: { [PROJECT]: 'bravo' }, mounts: [] },
			{ name: 'a-1', labels: { [PROJECT]: 'apex' }, mounts: [] }
		]);
		expect(items.map(i => i.name)).toEqual(['apex', 'bravo', 'alpha', 'zeta']);
	});

	test('tolerates Docker-raw shape (Names / Labels / Mounts)', () => {
		const items = groupContainersForBackup([
			{ Names: ['/raw-1'], Labels: { [PROJECT]: 'rawstack' }, Mounts: [{ Type: 'volume', Name: 'rawvol', Destination: '/d' }] }
		]);
		expect(items).toEqual([{ name: 'rawstack', type: 'stack', volumes: [{ key: 'rawvol', name: 'rawvol', mountPoint: '/d', mountType: 'volume' }] }]);
	});

	test('empty / null input yields []', () => {
		expect(groupContainersForBackup([])).toEqual([]);
		expect(groupContainersForBackup(null)).toEqual([]);
		expect(groupContainersForBackup(undefined)).toEqual([]);
	});
});

describe('volumesForStack', () => {
	const containers = [
		{ name: 'web-1', labels: { [PROJECT]: 'shop' }, mounts: [{ type: 'volume', source: 'shop_db', destination: '/data' }] },
		{ name: 'worker-1', labels: { [PROJECT]: 'shop' }, mounts: [{ type: 'bind', source: '/host/logs', destination: '/logs' }] },
		{ name: 'other-1', labels: { [PROJECT]: 'other' }, mounts: [{ type: 'volume', source: 'other_vol', destination: '/o' }] }
	];

	test('matching project label returns the stack\'s merged volumes (THE regression: was empty)', () => {
		const out = volumesForStack(containers, 'shop');
		expect(out.length).toBeGreaterThan(0);
		expect(out.map(v => v.name).sort()).toEqual(['/logs', 'shop_db']); // bind keys on destination
	});

	test('does not leak another stack\'s volumes', () => {
		expect(volumesForStack(containers, 'shop').some(v => v.name === 'other_vol')).toBe(false);
	});

	test('unknown / not-yet-deployed stack returns [] (the only legitimate empty)', () => {
		expect(volumesForStack(containers, 'nope')).toEqual([]);
		expect(volumesForStack([], 'shop')).toEqual([]);
		expect(volumesForStack(null, 'shop')).toEqual([]);
	});
});

describe('standaloneContainers', () => {
	// EnvironmentBackupsTab takes STACKS from /api/stacks (sourceType-aware, sees
	// stopped stacks) and only STANDALONE containers from here — so this must NOT
	// return anything carrying a compose-project label (that's a stack member).
	const containers = [
		{ name: 'web-1', labels: { [PROJECT]: 'shop' }, mounts: [{ type: 'volume', source: 'shop_db', destination: '/data' }] },
		{ name: 'redis', labels: {}, mounts: [{ type: 'volume', source: 'redis_data', destination: '/data' }] },
		{ name: 'pihole', labels: {}, mounts: [{ type: 'bind', source: '/host/pihole', destination: '/etc/pihole' }] }
	];

	test('returns ONLY containers without a compose-project label', () => {
		const out = standaloneContainers(containers);
		expect(out.map(i => i.name)).toEqual(['pihole', 'redis']); // web-1 (stack member) excluded, sorted
		expect(out.every(i => i.type === 'container')).toBe(true);
	});

	test('normalizes each container\'s mounts (volume + bind both kept)', () => {
		const out = standaloneContainers(containers);
		const redis = out.find(i => i.name === 'redis')!;
		const pihole = out.find(i => i.name === 'pihole')!;
		expect(redis.volumes.map(v => v.name)).toEqual(['redis_data']);
		expect(pihole.volumes.map(v => v.name)).toEqual(['/etc/pihole']); // bind NOT dropped (keys on destination)
	});

	test('excludes ALL stack members even if that leaves nothing', () => {
		expect(standaloneContainers([
			{ name: 'a-1', labels: { [PROJECT]: 's' }, mounts: [] },
			{ name: 'b-1', labels: { [PROJECT]: 's' }, mounts: [] }
		])).toEqual([]);
	});

	test('tolerates Docker-raw shape (Names / Labels / Mounts)', () => {
		const out = standaloneContainers([
			{ Names: ['/raw'], Labels: {}, Mounts: [{ Type: 'volume', Name: 'rawvol', Destination: '/d' }] }
		]);
		expect(out).toEqual([{ name: 'raw', type: 'container', volumes: [{ key: 'rawvol', name: 'rawvol', mountPoint: '/d', mountType: 'volume' }] }]);
	});

	test('empty / null input yields []', () => {
		expect(standaloneContainers([])).toEqual([]);
		expect(standaloneContainers(null)).toEqual([]);
		expect(standaloneContainers(undefined)).toEqual([]);
	});
});

describe('normalizeMounts — unbackupable flag (socket / host system binds)', () => {
	// The picker lists these but disables them and excludes them from "backup all".
	// Flag must mirror the engine's isUnbackupableBindSource so UI and engine agree.
	test('flags docker.sock bind, leaves data binds and named volumes unflagged', () => {
		const out = normalizeMounts([
			{ type: 'bind', source: '/var/run/docker.sock', destination: '/var/run/docker.sock' },
			{ type: 'bind', source: '/srv/app-data', destination: '/app/data' },
			{ type: 'volume', name: 'appvol', destination: '/vol' }
		]);
		const sock = out.find((v) => v.source === '/var/run/docker.sock');
		const data = out.find((v) => v.mountPoint === '/app/data');
		const named = out.find((v) => v.name === 'appvol');
		expect(sock?.unbackupable).toBe(true);
		// unflagged rows leave the field undefined (not false) so it stays absent in JSON
		expect(data?.unbackupable).toBeUndefined();
		expect(named?.unbackupable).toBeUndefined();
	});
});
