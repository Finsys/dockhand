import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAdditionalVolumeBinds, dedupeVolumesForRecreate } from '../src/lib/server/mount-dedupe';

describe('getAdditionalVolumeBinds', () => {
	it('skips volume mounts when the target already exists in HostConfig.Mounts', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{
				Binds: ['/volume1/backups:/backup'],
				Mounts: [{ Target: '/data' }]
			},
			[
				{ Type: 'volume', Name: 'docsight_docsis_data', Destination: '/data' },
				{ Type: 'bind', Name: 'ignored', Destination: '/backup' }
			]
		);

		assert.deepEqual(additionalBinds, []);
	});

	it('adds volume mounts that are missing from HostConfig', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{
				Binds: ['/volume1/backups:/backup'],
				Mounts: []
			},
			[{ Type: 'volume', Name: 'docsight_docsis_data', Destination: '/data' }]
		);

		assert.deepEqual(additionalBinds, ['docsight_docsis_data:/data']);
	});

	it('skips bind mounts (only adds volume type)', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{ Binds: [], Mounts: [] },
			[
				{ Type: 'bind', Name: 'host-path', Destination: '/config' },
				{ Type: 'tmpfs', Name: null, Destination: '/tmp' }
			]
		);

		assert.deepEqual(additionalBinds, []);
	});

	it('skips volume mounts already in Binds', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{
				Binds: ['myvolume:/data'],
				Mounts: []
			},
			[{ Type: 'volume', Name: 'myvolume', Destination: '/data' }]
		);

		assert.deepEqual(additionalBinds, []);
	});

	it('handles null Binds and Mounts gracefully', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{ Binds: null, Mounts: null },
			[{ Type: 'volume', Name: 'vol1', Destination: '/data' }]
		);

		assert.deepEqual(additionalBinds, ['vol1:/data']);
	});

	it('handles empty mounts array', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{ Binds: [], Mounts: [] },
			[]
		);

		assert.deepEqual(additionalBinds, []);
	});

	it('handles null mounts array', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{ Binds: [], Mounts: [] },
			null as any
		);

		assert.deepEqual(additionalBinds, []);
	});

	it('skips volume mounts without Name', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{ Binds: [], Mounts: [] },
			[{ Type: 'volume', Name: null, Destination: '/data' }]
		);

		assert.deepEqual(additionalBinds, []);
	});

	it('skips volume mounts without Destination', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{ Binds: [], Mounts: [] },
			[{ Type: 'volume', Name: 'vol1', Destination: null }]
		);

		assert.deepEqual(additionalBinds, []);
	});

	it('deduplicates across both Binds and Mounts targets', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{
				Binds: ['/host/path:/config'],
				Mounts: [{ Target: '/data' }]
			},
			[
				{ Type: 'volume', Name: 'config-vol', Destination: '/config' },
				{ Type: 'volume', Name: 'data-vol', Destination: '/data' },
				{ Type: 'volume', Name: 'logs-vol', Destination: '/logs' }
			]
		);

		assert.deepEqual(additionalBinds, ['logs-vol:/logs']);
	});

	it('handles bind strings with options (source:target:ro)', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{
				Binds: ['/host/data:/data:ro'],
				Mounts: []
			},
			[{ Type: 'volume', Name: 'data-vol', Destination: '/data' }]
		);

		assert.deepEqual(additionalBinds, []);
	});
});

describe('dedupeVolumesForRecreate', () => {
	it('drops an image-VOLUME path that collides with an existing bind (#1088)', () => {
		const kept = dedupeVolumesForRecreate(
			{ '/tmp': {}, '/keep': {} },
			{ Binds: ['/host/tmp:/tmp'] },
			[],
			[]
		);
		assert.deepEqual(kept, { '/keep': {} });
	});

	it('drops an image-VOLUME path that collides with a tmpfs mount (readonly container)', () => {
		const kept = dedupeVolumesForRecreate(
			{ '/tmp': {} },
			{ Tmpfs: { '/tmp': 'rw' } },
			[],
			[]
		);
		assert.equal(kept, undefined); // all volumes removed -> undefined so recreate omits the field
	});

	// #1363: cups on hawser. The image declares VOLUME /etc/cups; the running container has a
	// NAMED volume at /etc/cups that appears ONLY in inspect.Mounts (not yet in Binds) - the shape
	// a remote/hawser daemon returns. getAdditionalVolumeBinds re-adds it as a bind, and the old
	// dedup (Tmpfs/Binds only) never saw it -> duplicate mount point. Now both are covered.
	it('drops an image-VOLUME path present only in inspect.Mounts as a named volume (#1363)', () => {
		const mounts = [{ Type: 'volume', Name: 'cups-conf', Destination: '/etc/cups' }];
		const additionalBinds = getAdditionalVolumeBinds({ Binds: [], Mounts: [] }, mounts);
		assert.deepEqual(additionalBinds, ['cups-conf:/etc/cups']); // Step B will re-add it

		const kept = dedupeVolumesForRecreate(
			{ '/etc/cups': {}, '/var/log/cups': {} },
			{ Binds: [] },
			mounts,
			additionalBinds
		);
		// /etc/cups dropped (collides with the re-added bind); the un-mounted image volume stays.
		assert.deepEqual(kept, { '/var/log/cups': {} });
	});

	it('drops an image-VOLUME path that collides with an existing HostConfig.Mounts target', () => {
		const kept = dedupeVolumesForRecreate(
			{ '/data': {} },
			{ Mounts: [{ Target: '/data' }] },
			[],
			[]
		);
		assert.equal(kept, undefined);
	});

	it('keeps volumes with no colliding mount', () => {
		const kept = dedupeVolumesForRecreate(
			{ '/anon': {} },
			{ Binds: ['/host:/other'], Tmpfs: { '/tmp': 'rw' } },
			[{ Type: 'volume', Name: 'v', Destination: '/data' }],
			['v:/data']
		);
		assert.deepEqual(kept, { '/anon': {} });
	});

	it('returns undefined for null/empty Volumes', () => {
		assert.equal(dedupeVolumesForRecreate(undefined, { Binds: [] }, [], []), undefined);
		assert.equal(dedupeVolumesForRecreate(null, { Binds: [] }, [], []), undefined);
		assert.equal(dedupeVolumesForRecreate({}, { Binds: [] }, [], []), undefined);
	});
});

describe('#583 trailing-slash mount targets (Duplicate mount point)', () => {
	// The user bind carries a trailing slash ("caddy-logs:/var/log/") but Docker
	// normalizes the same volume's inspect Destination to "/var/log". Recreate must
	// treat them as the same mount point, or it re-adds the volume and the daemon
	// rejects the create with "Duplicate mount point: /var/log".
	it('getAdditionalVolumeBinds does NOT re-add a volume already bound with a trailing slash', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{ Binds: ['caddy-logs:/var/log/'] },
			[{ Type: 'volume', Name: 'caddy-logs', Destination: '/var/log' }]
		);
		assert.deepEqual(additionalBinds, []);
	});

	it('getAdditionalVolumeBinds handles the inverse (bind no slash, inspect Destination with slash)', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{ Binds: ['caddy-logs:/var/log'] },
			[{ Type: 'volume', Name: 'caddy-logs', Destination: '/var/log/' }]
		);
		assert.deepEqual(additionalBinds, []);
	});

	it('getAdditionalVolumeBinds still re-adds a genuinely different, unmounted volume', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{ Binds: ['caddy-logs:/var/log/'] },
			[
				{ Type: 'volume', Name: 'caddy-logs', Destination: '/var/log' },
				{ Type: 'volume', Name: 'caddy-data', Destination: '/data' }
			]
		);
		assert.deepEqual(additionalBinds, ['caddy-data:/data']);
	});

	it('dedupeVolumesForRecreate drops a Config.Volumes entry already bound with a trailing-slash difference', () => {
		const kept = dedupeVolumesForRecreate(
			{ '/var/log': {} },
			{ Binds: ['caddy-logs:/var/log/'] },
			[{ Type: 'volume', Name: 'caddy-logs', Destination: '/var/log' }],
			[]
		);
		assert.equal(kept, undefined);
	});

	it('dedupeVolumesForRecreate drops a trailing-slash Config.Volumes key against a no-slash mount', () => {
		const kept = dedupeVolumesForRecreate(
			{ '/var/log/': {} },
			{ Binds: [] },
			[{ Type: 'volume', Name: 'caddy-logs', Destination: '/var/log' }],
			[]
		);
		assert.equal(kept, undefined);
	});

	it('collapses MULTIPLE trailing slashes (pins the /+$ quantifier)', () => {
		// A regression narrowing normalizeMountTarget to a single-slash strip would keep
		// every other test green but re-add this volume -> duplicate mount.
		const additionalBinds = getAdditionalVolumeBinds(
			{ Binds: ['caddy-logs:/var/log//'] },
			[{ Type: 'volume', Name: 'caddy-logs', Destination: '/var/log' }]
		);
		assert.deepEqual(additionalBinds, []);

		const kept = dedupeVolumesForRecreate(
			{ '/var/log//': {} },
			{ Binds: [] },
			[{ Type: 'volume', Name: 'caddy-logs', Destination: '/var/log' }],
			[]
		);
		assert.equal(kept, undefined);
	});

	it('root "/" is preserved (not stripped to empty)', () => {
		const kept = dedupeVolumesForRecreate(
			{ '/': {} },
			{ Binds: ['somevol:/'] },
			[],
			[]
		);
		assert.equal(kept, undefined);
	});
});
