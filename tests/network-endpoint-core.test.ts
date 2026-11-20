import { describe, test, expect } from 'bun:test';
import {
	networkIsUserDefined,
	endpointConfigForNetwork,
	primaryNetworkKey
} from '../src/lib/utils/network-endpoint-core';

const STATIC = {
	aliases: ['bookstack', 'bookstack-db'],
	ipv4Address: '10.0.1.26',
	ipv6Address: 'fd00::26',
	gwPriority: 10
};

describe('networkIsUserDefined', () => {
	test('the built-in modes are not user-defined networks', () => {
		for (const name of ['bridge', 'default', 'host', 'none', 'container:abc', 'service:app']) {
			expect(networkIsUserDefined(name)).toBe(false);
		}
	});

	test('named networks, including Podman\'s default bridge name, are user-defined', () => {
		expect(networkIsUserDefined('app-net')).toBe(true);
		expect(networkIsUserDefined('podman')).toBe(true);
		expect(networkIsUserDefined('  lan  ')).toBe(true);
	});

	test('an empty name is not a network', () => {
		expect(networkIsUserDefined('')).toBe(false);
		expect(networkIsUserDefined(null)).toBe(false);
		expect(networkIsUserDefined(undefined)).toBe(false);
	});
});

describe('endpointConfigForNetwork', () => {
	test('a user-defined network keeps the static IP, aliases and gateway priority', () => {
		expect(endpointConfigForNetwork('app-net', STATIC)).toEqual({
			Aliases: ['bookstack', 'bookstack-db'],
			IPAMConfig: { IPv4Address: '10.0.1.26', IPv6Address: 'fd00::26' },
			GwPriority: 10
		});
	});

	test('the built-in bridge drops everything Docker refuses there', () => {
		// The reported failure: EndpointsConfig.bridge carried 10.0.1.26 and aliases, so
		// Docker rejected the whole recreate with "user-specified IP address is supported
		// on user-defined networks only".
		expect(endpointConfigForNetwork('bridge', STATIC)).toEqual({});
		expect(endpointConfigForNetwork('default', STATIC)).toEqual({});
	});

	test('shared modes and empty names carry no endpoint settings', () => {
		expect(endpointConfigForNetwork('host', STATIC)).toEqual({});
		expect(endpointConfigForNetwork('none', STATIC)).toEqual({});
		expect(endpointConfigForNetwork('container:parent', STATIC)).toEqual({});
		expect(endpointConfigForNetwork('', STATIC)).toEqual({});
	});

	test('a network with no settings gets an empty config, not empty keys', () => {
		expect(endpointConfigForNetwork('app-net')).toEqual({});
		expect(endpointConfigForNetwork('app-net', { aliases: [] })).toEqual({});
	});
});

describe('primaryNetworkKey', () => {
	test('a named network and a shared mode are already their own key', () => {
		expect(primaryNetworkKey('app-net', ['app-net'])).toBe('app-net');
		expect(primaryNetworkKey('host', [])).toBe('host');
		expect(primaryNetworkKey('container:parent', ['app-net'])).toBe('container:parent');
	});

	test('the built-in bridge keeps its key when that is the attachment', () => {
		expect(primaryNetworkKey('bridge', ['bridge'])).toBe('bridge');
		expect(primaryNetworkKey('default', ['bridge'])).toBe('default');
		expect(primaryNetworkKey('', [])).toBe('bridge');
	});

	test('a lone attachment under another name becomes the key (Podman #1619)', () => {
		expect(primaryNetworkKey('bridge', ['podman'])).toBe('podman');
		expect(primaryNetworkKey('default', ['app-net'])).toBe('app-net');
	});

	test('several attachments keep the mode: the extra one must not steal the IP', () => {
		expect(primaryNetworkKey('bridge', ['bridge', 'app-net'])).toBe('bridge');
		expect(primaryNetworkKey('bridge', ['app-net', 'db-net'])).toBe('bridge');
	});
});
