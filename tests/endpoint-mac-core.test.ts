import { describe, test, expect } from 'bun:test';
import {
	macDerivedFromIp,
	isGeneratedEndpointMac,
	configuredMacAddress,
	endpointWithoutGeneratedMac
} from '../src/lib/server/endpoint-mac-core';

// Every shape below came off a real daemon:
// - Docker 20.10.24 (API 1.41): auto MAC for 172.17.0.4 is 02:42:ac:11:00:04, and
//   Config.MacAddress is OMITTED entirely when the MAC was generated. A user-set MAC is
//   echoed there in the spelling they typed, while the endpoint renders it lowercase.
// - Docker 29.4.0 (API 1.54): Config has no MacAddress key even for --mac-address, and
//   MACs are random rather than IP-derived.
const AUTO_IP = '172.17.0.4';
const AUTO_MAC = '02:42:ac:11:00:04';
const USER_MAC = '02:42:de:ad:be:ef';

describe('macDerivedFromIp', () => {
	test('spells the four octets out in hex', () => {
		expect(macDerivedFromIp('172.17.0.4')).toBe('02:42:ac:11:00:04');
		expect(macDerivedFromIp('172.31.99.2')).toBe('02:42:ac:1f:63:02');
		expect(macDerivedFromIp('10.0.0.255')).toBe('02:42:0a:00:00:ff');
	});

	test('rejects anything that is not a dotted-quad IPv4', () => {
		expect(macDerivedFromIp('')).toBeNull();
		expect(macDerivedFromIp('172.17.0')).toBeNull();
		expect(macDerivedFromIp('172.17.0.256')).toBeNull();
		expect(macDerivedFromIp('172.17.0.x')).toBeNull();
		expect(macDerivedFromIp('fd00::1')).toBeNull();
		expect(macDerivedFromIp(undefined)).toBeNull();
	});
});

describe('isGeneratedEndpointMac', () => {
	test('the real 20.10 auto pair is recognised', () => {
		expect(isGeneratedEndpointMac({ MacAddress: AUTO_MAC, IPAddress: AUTO_IP })).toBe(true);
	});

	test('a user-pinned MAC on the same endpoint is not', () => {
		expect(isGeneratedEndpointMac({ MacAddress: USER_MAC, IPAddress: '172.17.0.3' })).toBe(false);
	});

	test('case and padding do not hide a derived MAC', () => {
		expect(isGeneratedEndpointMac({ MacAddress: ' 02:42:AC:11:00:04 ', IPAddress: AUTO_IP })).toBe(
			true
		);
	});

	test('a MAC with no IP to compare against is left alone', () => {
		expect(isGeneratedEndpointMac({ MacAddress: AUTO_MAC })).toBe(false);
		expect(isGeneratedEndpointMac({ MacAddress: AUTO_MAC, IPAddress: '' })).toBe(false);
	});

	test('an endpoint with no MAC', () => {
		expect(isGeneratedEndpointMac({ IPAddress: AUTO_IP })).toBe(false);
		expect(isGeneratedEndpointMac(null)).toBe(false);
	});
});

describe('endpointWithoutGeneratedMac', () => {
	test('the #1618 case: a derived MAC is not carried to the replacement', () => {
		const out = endpointWithoutGeneratedMac({
			MacAddress: AUTO_MAC,
			IPAddress: AUTO_IP,
			IPAMConfig: null,
			Aliases: ['web']
		});
		expect('MacAddress' in out).toBe(false);
		expect(out.Aliases).toEqual(['web']);
	});

	test('a user-pinned MAC survives, on old and new daemons alike', () => {
		expect(
			endpointWithoutGeneratedMac({ MacAddress: USER_MAC, IPAddress: '172.17.0.3' }).MacAddress
		).toBe(USER_MAC);
		// API 1.44+: random MAC, no relation to the IP, so nothing to strip.
		expect(
			endpointWithoutGeneratedMac({ MacAddress: USER_MAC, IPAddress: '192.168.215.3' }).MacAddress
		).toBe(USER_MAC);
	});

	test('a random auto MAC on a newer daemon is kept - it cannot collide', () => {
		// 29.4.0 assigns these; they do not spell out the IP, so they are indistinguishable
		// from a pinned MAC and harmless to carry.
		const out = endpointWithoutGeneratedMac({
			MacAddress: 'ee:b8:1e:85:d6:27',
			IPAddress: '172.31.99.3'
		});
		expect(out.MacAddress).toBe('ee:b8:1e:85:d6:27');
	});

	test('an endpoint with no MAC at all is untouched', () => {
		expect(endpointWithoutGeneratedMac({ Aliases: ['x'] })).toEqual({ Aliases: ['x'] });
	});

	test('the input endpoint is not mutated', () => {
		const endpoint = { MacAddress: AUTO_MAC, IPAddress: AUTO_IP };
		endpointWithoutGeneratedMac(endpoint);
		expect(endpoint.MacAddress).toBe(AUTO_MAC);
	});

	test('static IP settings ride along untouched - only the MAC is in scope', () => {
		const out = endpointWithoutGeneratedMac({
			MacAddress: AUTO_MAC,
			IPAddress: AUTO_IP,
			IPAMConfig: { IPv4Address: '172.17.0.4' },
			Aliases: ['web'],
			GwPriority: 10
		});
		expect('MacAddress' in out).toBe(false);
		expect(out.IPAMConfig).toEqual({ IPv4Address: '172.17.0.4' });
		expect(out.GwPriority).toBe(10);
	});
});

describe('configuredMacAddress - what the edit form may show as a setting', () => {
	test('Config.MacAddress wins when the daemon reports it', () => {
		expect(configuredMacAddress({ Config: { MacAddress: '02:42:DE:AD:BE:EF' } })).toBe(USER_MAC);
	});

	test('falls back to a pinned endpoint MAC when Config omits the field', () => {
		// The 29.4.0 shape: no Config.MacAddress, but the user did set one.
		expect(
			configuredMacAddress({ Config: {} }, { MacAddress: USER_MAC, IPAddress: '192.168.215.3' })
		).toBe(USER_MAC);
	});

	test('never surfaces a derived MAC as a user setting', () => {
		expect(
			configuredMacAddress({ Config: {} }, { MacAddress: AUTO_MAC, IPAddress: AUTO_IP })
		).toBeNull();
	});

	test('no endpoint and no Config value', () => {
		expect(configuredMacAddress({ Config: {} })).toBeNull();
		expect(configuredMacAddress(undefined)).toBeNull();
	});
});
