import { describe, expect, test } from 'bun:test';
import { containerMountBindings, containerMountOptions } from '../src/lib/utils/container-mounts';

const structured = {
	HostConfig: {
		Binds: null,
		Mounts: [
			{ Type: 'bind', Source: '/srv/app/config', Target: '/config', BindOptions: { Propagation: 'rprivate', NonRecursive: true } },
			{ Type: 'bind', Source: '/srv/app/data', Target: '/data', ReadOnly: true }
		]
	},
	Mounts: [
		{ Type: 'bind', Source: '/srv/app/config', Destination: '/config', RW: true },
		{ Type: 'bind', Source: '/srv/app/data', Destination: '/data', RW: false }
	]
};

describe('container edit mounts', () => {
	test('shows --mount binds and preserves their options on an unrelated edit', () => {
		const displayed = containerMountBindings(structured);
		expect(displayed).toEqual(['/srv/app/config:/config:rw', '/srv/app/data:/data:ro']);
		expect(containerMountOptions(structured, displayed)).toEqual({ volumeBinds: [], mounts: structured.HostConfig.Mounts });
		expect(containerMountOptions(structured)).toEqual({ volumeBinds: [], mounts: structured.HostConfig.Mounts });
	});

	test('preserves storage when an older editor submits null for its empty volume list', () => {
		expect(containerMountOptions(structured, null)).toEqual({ volumeBinds: [], mounts: structured.HostConfig.Mounts });
	});

	test('applies explicit source changes, removals and read-only changes without duplicate targets', () => {
		const changed = containerMountOptions(structured, ['/srv/replacement/config:/config:rw', '/srv/app/data:/data:rw']);
		expect(changed).toEqual({ volumeBinds: ['/srv/replacement/config:/config:rw', '/srv/app/data:/data:rw'], mounts: [] });
		expect(containerMountOptions(structured, [])).toEqual({ volumeBinds: [], mounts: [] });
		expect(containerMountOptions(structured, ['/srv/app/config:/config'])).toEqual({ volumeBinds: [], mounts: [structured.HostConfig.Mounts[0]] });
	});

	test('keeps legacy bind flags and anonymous volume identities', () => {
		const inspect = { HostConfig: { Binds: ['/old:/data:ro,z'] }, Mounts: [
			{ Type: 'bind', Source: '/old', Destination: '/data', RW: false },
			{ Type: 'volume', Name: 'anonymous-id', Source: '/var/lib/docker/volumes/anonymous-id/_data', Destination: '/config', RW: true }
		] };
		expect(containerMountBindings(inspect)).toEqual(['/old:/data:ro,z', 'anonymous-id:/config:rw']);
		expect(containerMountOptions(inspect)).toEqual({ volumeBinds: ['/old:/data:ro,z', 'anonymous-id:/config:rw'], mounts: [] });
		expect(containerMountOptions(inspect, null)).toEqual({ volumeBinds: ['/old:/data:ro,z', 'anonymous-id:/config:rw'], mounts: [] });
	});

	test('retains structured volume options and resolves anonymous sources to their existing names', () => {
		const mount = { Type: 'volume', Target: '/config/', VolumeOptions: { NoCopy: true, Subpath: 'artwork' } };
		const inspect = { HostConfig: { Mounts: [mount] }, Mounts: [{ Type: 'volume', Name: 'existing-volume', Destination: '/config' }] };
		expect(containerMountOptions(inspect, ['existing-volume:/config:rw'])).toEqual({ volumeBinds: [], mounts: [{ ...mount, Source: 'existing-volume' }] });
		expect(containerMountOptions(inspect)).toEqual({ volumeBinds: [], mounts: [{ ...mount, Source: 'existing-volume' }] });
		expect(mount).not.toHaveProperty('Source');
	});

	test('refuses to recreate an anonymous volume whose existing name is missing', () => {
		const inspect = { HostConfig: { Mounts: [{ Type: 'volume', Target: '/data' }] } };
		expect(() => containerMountOptions(inspect)).toThrow('volume name missing');
		expect(() => containerMountOptions(inspect, null)).toThrow('volume name missing');
		expect(containerMountOptions(inspect, [])).toEqual({ volumeBinds: [], mounts: [] });
	});

	test('keeps mount types that the volume form does not edit', () => {
		const mount = { Type: 'tmpfs', Target: '/run', TmpfsOptions: { SizeBytes: 4096 } };
		expect(containerMountOptions({ HostConfig: { Mounts: [mount] } }, null)).toEqual({ volumeBinds: [], mounts: [mount] });
		expect(containerMountOptions({})).toEqual({ volumeBinds: [], mounts: [] });
	});
});
