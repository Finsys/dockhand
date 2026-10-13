import { describe, test, expect } from 'bun:test';
import {
	isSameNetwork,
	additionalNetworkNames,
	isPrimaryNetworkName,
	endpointSettingsFromInspect,
	mapContainerNetworks
} from '../src/lib/utils/network-identity';

// Verbatim from a live Podman 5.4.2 daemon: the container inspect names the default
// bridge "podman" while GET /networks and HostConfig.NetworkMode call it "bridge", both
// with the same id. Docker reports "bridge" everywhere, so its ids never disagree.
const PODMAN_ID = '2f259bab93aaaaa2c0fd1b2b4d9d0c3e2a1b7c8d9e0f1a2b3c4d5e6f70819203';
const DOCKER_BRIDGE_ID = '060ef0955e4e0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293';

describe('isSameNetwork', () => {
	test('the Podman alias resolves to one network via its id', () => {
		expect(
			isSameNetwork({ name: 'podman', id: PODMAN_ID }, { name: 'bridge', id: PODMAN_ID })
		).toBe(true);
	});

	test('different networks with different ids stay different', () => {
		expect(
			isSameNetwork({ name: 'bridge', id: PODMAN_ID }, { name: 'app-net', id: DOCKER_BRIDGE_ID })
		).toBe(false);
	});

	test('falls back to the name when either side has no id', () => {
		expect(isSameNetwork({ name: 'app-net' }, { name: 'app-net', id: PODMAN_ID })).toBe(true);
		expect(isSameNetwork({ name: 'app-net' }, { name: 'other', id: PODMAN_ID })).toBe(false);
		expect(isSameNetwork({ name: 'app-net' }, { name: 'app-net' })).toBe(true);
	});

	test('an empty or blank id counts as absent, not as a match', () => {
		expect(isSameNetwork({ name: 'a', id: '' }, { name: 'b', id: '' })).toBe(false);
		expect(isSameNetwork({ name: 'a', id: '   ' }, { name: 'a', id: null })).toBe(true);
	});

	test('the same id wins even when the names look unrelated', () => {
		expect(isSameNetwork({ name: 'podman', id: PODMAN_ID }, { name: 'anything', id: PODMAN_ID })).toBe(
			true
		);
	});
});

describe('additionalNetworkNames - #1619', () => {
	test('the Podman default bridge is not reported as an extra network', () => {
		// The reported bug: inspect says "podman", NetworkMode says "bridge", so a
		// name-only comparison listed the primary under "Additional networks".
		const attached = [{ name: 'podman', id: PODMAN_ID }];
		const known = [{ name: 'bridge', id: PODMAN_ID }];
		expect(additionalNetworkNames(attached, 'bridge', known)).toEqual([]);
	});

	test('a genuine extra network is still reported', () => {
		const attached = [
			{ name: 'podman', id: PODMAN_ID },
			{ name: 'app-net', id: 'aaa111' }
		];
		const known = [
			{ name: 'bridge', id: PODMAN_ID },
			{ name: 'app-net', id: 'aaa111' }
		];
		expect(additionalNetworkNames(attached, 'bridge', known)).toEqual(['app-net']);
	});

	test('Docker is unaffected: names already agree', () => {
		const attached = [
			{ name: 'bridge', id: DOCKER_BRIDGE_ID },
			{ name: 'app-net', id: 'bbb222' }
		];
		const known = [
			{ name: 'bridge', id: DOCKER_BRIDGE_ID },
			{ name: 'app-net', id: 'bbb222' }
		];
		expect(additionalNetworkNames(attached, 'bridge', known)).toEqual(['app-net']);
	});

	test('without the network list it behaves as before, matching on name', () => {
		// No id for the primary to compare against, so the old rule applies. On Podman
		// this still lists the alias - the caller is expected to pass the known list.
		const attached = [{ name: 'app-net', id: 'aaa111' }];
		expect(additionalNetworkNames(attached, 'bridge')).toEqual(['app-net']);
		expect(additionalNetworkNames([{ name: 'bridge', id: 'x' }], 'bridge')).toEqual([]);
	});

	test('an unknown primary (not in the list) still excludes its name', () => {
		const attached = [
			{ name: 'bridge', id: 'aaa111' },
			{ name: 'app-net', id: 'bbb222' }
		];
		expect(additionalNetworkNames(attached, 'bridge', [])).toEqual(['app-net']);
	});

	test('a container on no networks', () => {
		expect(additionalNetworkNames([], 'bridge', [{ name: 'bridge', id: PODMAN_ID }])).toEqual([]);
	});

	test('host and none modes leave every attachment listed', () => {
		// These never appear in the network list, so nothing is excluded by id.
		const attached = [{ name: 'app-net', id: 'aaa111' }];
		expect(additionalNetworkNames(attached, 'host', [])).toEqual(['app-net']);
	});
});

describe('isPrimaryNetworkName - keeps the primary findable on Podman (#1619)', () => {
	test('the aliased sole network is the primary, so its aliases and IPs are read', () => {
		// Podman: inspect key "podman", NetworkMode "bridge". Without this the loop found
		// no primary and the next save dropped the network's aliases and static IPs.
		expect(isPrimaryNetworkName('podman', 'bridge', ['podman'])).toBe(true);
	});

	test('the plain cases still match by name', () => {
		expect(isPrimaryNetworkName('bridge', 'bridge', ['bridge'])).toBe(true);
		expect(isPrimaryNetworkName('app-net', 'app-net', ['app-net', 'other'])).toBe(true);
		expect(isPrimaryNetworkName('default', 'bridge', ['default', 'other'])).toBe(true);
	});

	test('with several networks it never guesses which is primary', () => {
		// Nothing identifies the alias here, so an extra must not be mistaken for the
		// primary and have its aliases written onto a different network.
		expect(isPrimaryNetworkName('podman', 'bridge', ['podman', 'app-net'])).toBe(false);
		expect(isPrimaryNetworkName('app-net', 'bridge', ['bridge', 'app-net'])).toBe(false);
	});

	test('a non-primary network is not promoted just because it is listed', () => {
		expect(isPrimaryNetworkName('app-net', 'other-net', ['app-net', 'more'])).toBe(false);
	});

	test('the sole-network rule only fires for that one network', () => {
		expect(isPrimaryNetworkName('somethingelse', 'bridge', ['podman'])).toBe(false);
	});
});

describe('endpointSettingsFromInspect - what a recreate must carry per endpoint', () => {
	const CID = '5b95abf1d9036e9d82069283abe9f672e02ef6673dd9912924867990af4f3c27';

	test('keeps user aliases and drops the ids Docker seeds', () => {
		expect(
			endpointSettingsFromInspect(
				{ Aliases: ['web', CID, CID.substring(0, 12)], IPAMConfig: null },
				CID
			)
		).toEqual({ aliases: ['web'] });
	});

	test('carries static IPs alongside the aliases', () => {
		expect(
			endpointSettingsFromInspect(
				{ Aliases: ['db'], IPAMConfig: { IPv4Address: '172.31.99.5', IPv6Address: 'fd00::5' } },
				CID
			)
		).toEqual({ aliases: ['db'], ipv4Address: '172.31.99.5', ipv6Address: 'fd00::5' });
	});

	test('falls back to DNSNames when Aliases is empty', () => {
		// Podman populates DNSNames rather than Aliases on some versions.
		expect(endpointSettingsFromInspect({ Aliases: [], DNSNames: ['svc'] }, CID)).toEqual({
			aliases: ['svc']
		});
	});

	test('an endpoint with nothing user-set returns null, so no empty entry is stored', () => {
		expect(endpointSettingsFromInspect({ Aliases: [CID], IPAMConfig: null }, CID)).toBeNull();
		expect(endpointSettingsFromInspect({}, CID)).toBeNull();
		expect(endpointSettingsFromInspect(null, CID)).toBeNull();
	});

	test('a DHCP address is not mistaken for a static one', () => {
		// The live IPAddress lives outside IPAMConfig; only IPAMConfig is user intent.
		expect(
			endpointSettingsFromInspect({ Aliases: [], IPAddress: '172.31.99.9' } as never, CID)
		).toBeNull();
	});
});

describe('mapContainerNetworks - what a recreate carries over', () => {
	const CID = 'a'.repeat(64);

	test('a second network and its aliases survive, which is the whole point', () => {
		// Reported case: updating a two-network container through the API left it on the
		// primary only, because the mapper never produced the extras.
		const mapped = mapContainerNetworks(
			{
				'mn-a': { Aliases: ['primary-alias'] },
				'mn-b': { Aliases: ['secondary-alias'], IPAMConfig: { IPv4Address: '10.0.1.5' } }
			},
			'mn-a',
			CID
		);
		expect(mapped.primaryAliases).toEqual(['primary-alias']);
		expect(mapped.additionalNetworks).toEqual(['mn-b']);
		expect(mapped.networkConfigs).toEqual({
			'mn-b': { aliases: ['secondary-alias'], ipv4Address: '10.0.1.5' }
		});
	});

	test('a single-network container reports no extras', () => {
		const mapped = mapContainerNetworks({ bridge: { Aliases: ['web'] } }, 'bridge', CID);
		expect(mapped.additionalNetworks).toEqual([]);
		expect(mapped.networkConfigs).toEqual({});
		expect(mapped.primaryAliases).toEqual(['web']);
	});

	test('only one network can win the primary, whichever order they arrive in', () => {
		// "bridge" and "default" both answer to NetworkMode "bridge". Without the
		// first-match rule the second would overwrite the primary's aliases and IP and
		// vanish from the extras entirely.
		const networks = {
			default: { Aliases: ['web-primary'], IPAMConfig: { IPv4Address: '172.20.0.10' } },
			bridge: { Aliases: ['other'], IPAMConfig: { IPv4Address: '172.17.0.5' } }
		};
		const mapped = mapContainerNetworks(networks, 'bridge', CID);
		expect(mapped.primaryAliases).toEqual(['web-primary']);
		expect(mapped.primaryIpv4Address).toBe('172.20.0.10');
		expect(mapped.additionalNetworks).toEqual(['bridge']);

		// Reversed order: the first one still wins, and the other is an extra exactly once.
		const reversed = mapContainerNetworks(
			{ bridge: networks.bridge, default: networks.default },
			'bridge',
			CID
		);
		expect(reversed.primaryAliases).toEqual(['other']);
		expect(reversed.additionalNetworks).toEqual(['default']);
	});

	test('the Podman alias is the primary, not an extra', () => {
		const mapped = mapContainerNetworks({ podman: { Aliases: ['svc'] } }, 'bridge', CID);
		expect(mapped.additionalNetworks).toEqual([]);
		expect(mapped.primaryAliases).toEqual(['svc']);
	});

	test('compose service aliases are added to the primary', () => {
		const mapped = mapContainerNetworks({ 'proj_default': { Aliases: [] } }, 'proj_default', CID, {
			project: 'proj',
			service: 'web'
		});
		expect(mapped.primaryAliases).toEqual(['web', 'proj-web']);
	});

	test('an alias the daemon already lists is not added twice', () => {
		const mapped = mapContainerNetworks({ 'proj_default': { Aliases: ['web'] } }, 'proj_default', CID, {
			project: 'proj',
			service: 'web'
		});
		expect(mapped.primaryAliases).toEqual(['web', 'proj-web']);
	});

	test('a half-known compose identity adds nothing, since neither alias can be built', () => {
		const half = { 'proj_default': { Aliases: ['kept'] } };
		expect(mapContainerNetworks(half, 'proj_default', CID, { project: 'proj' }).primaryAliases).toEqual(['kept']);
		expect(mapContainerNetworks(half, 'proj_default', CID, { service: 'web' }).primaryAliases).toEqual(['kept']);
	});

	test('the primary endpoint is carried through, since the MAC decision reads it', () => {
		const networks = {
			'mn-a': { Aliases: ['web'], MacAddress: '02:42:ac:11:00:02' },
			'mn-b': { Aliases: ['y'] }
		};
		const mapped = mapContainerNetworks(networks, 'mn-a', CID);
		expect(mapped.primaryEndpoint).toEqual(networks['mn-a']);
	});

	test('a static v6 address and gateway priority reach the primary', () => {
		const mapped = mapContainerNetworks(
			{
				'mn-a': {
					Aliases: ['web'],
					IPAMConfig: { IPv4Address: '172.20.0.10', IPv6Address: 'fd00::5' },
					GwPriority: 100
				}
			},
			'mn-a',
			CID
		);
		expect(mapped.primaryIpv4Address).toBe('172.20.0.10');
		expect(mapped.primaryIpv6Address).toBe('fd00::5');
		expect(mapped.primaryGwPriority).toBe(100);
	});

	test('a shared mode listing several networks reports them all as extras', () => {
		// host/none normally list nothing; when more than one is present none of them can
		// claim the primary, so they all come back as extras. createContainer drops them
		// for shared modes anyway, so this only has to be predictable, not clever.
		const mapped = mapContainerNetworks(
			{ 'mn-a': { Aliases: ['x'] }, 'mn-b': { Aliases: ['y'] } },
			'host',
			CID
		);
		expect(mapped.primaryAliases).toBeUndefined();
		expect(mapped.additionalNetworks).toEqual(['mn-a', 'mn-b']);
	});

	test('no networks at all', () => {
		const mapped = mapContainerNetworks({}, 'bridge', CID);
		expect(mapped).toEqual({ additionalNetworks: [], networkConfigs: {} });
	});
});
