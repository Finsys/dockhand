import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSelfUpdateCreateConfig } from '../src/lib/server/self-update-core';

// Pins the self-update wiring: the create config must carry the Podman HostConfig
// fixups, not just the pure strip function in isolation. A Podman inspect reports
// MemorySwappiness=0 for a container with no memory limits, and crun rejects it at START
// on cgroup v2 - so the built config must NOT carry the field.
describe('buildSelfUpdateCreateConfig', () => {
	const podmanInspect = {
		Config: { Image: 'fnsys/dockhand:old', Hostname: 'abc123' },
		HostConfig: {
			MemorySwappiness: 0, // Podman default for a no-limit container
			RestartPolicy: { Name: 'unless-stopped' },
			Binds: ['/host:/data']
		},
		Mounts: []
	};

	it('drops the default MemorySwappiness so Podman cgroup v2 can start the container', () => {
		const cfg = buildSelfUpdateCreateConfig(podmanInspect, 'fnsys/dockhand:new');
		assert.equal('MemorySwappiness' in cfg.HostConfig, false);
	});

	it('keeps the rest of HostConfig and sets the new image', () => {
		const cfg = buildSelfUpdateCreateConfig(podmanInspect, 'fnsys/dockhand:new');
		assert.equal(cfg.Image, 'fnsys/dockhand:new');
		assert.deepEqual(cfg.HostConfig.RestartPolicy, { Name: 'unless-stopped' });
		assert.deepEqual(cfg.HostConfig.Binds, ['/host:/data']);
	});

	it('keeps a real user-set MemorySwappiness (not a default)', () => {
		const cfg = buildSelfUpdateCreateConfig(
			{ Config: {}, HostConfig: { MemorySwappiness: 60 }, Mounts: [] },
			'img:new'
		);
		assert.equal(cfg.HostConfig.MemorySwappiness, 60);
	});

	it('drops NanoCpus/period-quota conflict (Podman reports both)', () => {
		const cfg = buildSelfUpdateCreateConfig(
			{ Config: {}, HostConfig: { NanoCpus: 500000000, CpuPeriod: 100000, CpuQuota: 50000 }, Mounts: [] },
			'img:new'
		);
		assert.equal(cfg.HostConfig.NanoCpus, 500000000);
		assert.equal('CpuPeriod' in cfg.HostConfig, false);
		assert.equal('CpuQuota' in cfg.HostConfig, false);
	});

	it('restores keep-id userns from the Podman annotation (was lowered to "private")', () => {
		const cfg = buildSelfUpdateCreateConfig(
			{
				Config: { Annotations: { 'io.podman.annotations.userns': 'keep-id' } },
				HostConfig: { UsernsMode: 'private' },
				Mounts: []
			},
			'img:new'
		);
		assert.equal(cfg.HostConfig.UsernsMode, 'keep-id');
	});

	it('clears Entrypoint, Cmd, Hostname, MacAddress', () => {
		const cfg = buildSelfUpdateCreateConfig(
			{
				Config: { Entrypoint: ['/old'], Cmd: ['x'], Hostname: 'h', MacAddress: '02:42:00:00:00:01' },
				HostConfig: {},
				Mounts: []
			},
			'img:new'
		);
		assert.equal('Entrypoint' in cfg, false);
		assert.equal('Cmd' in cfg, false);
		assert.equal('Hostname' in cfg, false);
		assert.equal('MacAddress' in cfg, false);
	});
});
