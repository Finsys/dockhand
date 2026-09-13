import { describe, test, expect } from 'bun:test';
import { ipToNumber, ipv6ToBigInt, compareIps } from '../src/lib/utils/ip';

describe('ipToNumber', () => {
	test('converts standard IPv4 addresses', () => {
		expect(ipToNumber('0.0.0.0')).toBe(0);
		expect(ipToNumber('0.0.0.1')).toBe(1);
		expect(ipToNumber('10.0.0.1')).toBe(167772161);
		expect(ipToNumber('192.168.1.0')).toBe(3232235776);
	});

	test('strips CIDR notation', () => {
		expect(ipToNumber('192.168.1.0/24')).toBe(ipToNumber('192.168.1.0'));
		expect(ipToNumber('10.0.0.0/8')).toBe(ipToNumber('10.0.0.0'));
	});

	test('returns Infinity for null/undefined/empty', () => {
		expect(ipToNumber(null)).toBe(Infinity);
		expect(ipToNumber(undefined)).toBe(Infinity);
		expect(ipToNumber('-')).toBe(Infinity);
	});

	test('returns Infinity for non-IPv4 strings', () => {
		expect(ipToNumber('not-an-ip')).toBe(Infinity);
		expect(ipToNumber('2001:db8::1')).toBe(Infinity);
	});

	test('sorts correctly when used as comparator', () => {
		const ips = ['192.168.1.10', '10.0.0.1', '172.16.0.1', '192.168.1.2'];
		const sorted = [...ips].sort((a, b) => ipToNumber(a) - ipToNumber(b));
		expect(sorted).toEqual(['10.0.0.1', '172.16.0.1', '192.168.1.2', '192.168.1.10']);
	});
});

describe('ipv6ToBigInt', () => {
	test('parses full and compressed forms to the same value', () => {
		const full = ipv6ToBigInt('2001:0db8:0000:0000:0000:0000:0000:0001');
		expect(ipv6ToBigInt('2001:db8::1')).toBe(full);
		expect(ipv6ToBigInt('2001:db8::1/64')).toBe(full); // CIDR stripped
	});

	test('handles :: at the start and end', () => {
		expect(ipv6ToBigInt('::1')).toBe(1n);
		expect(ipv6ToBigInt('::')).toBe(0n);
		expect(ipv6ToBigInt('fe80::')).toBe(ipv6ToBigInt('fe80:0:0:0:0:0:0:0'));
	});

	test('handles an IPv4 tail (IPv4-mapped)', () => {
		expect(ipv6ToBigInt('::ffff:192.168.0.1')).toBe(ipv6ToBigInt('::ffff:c0a8:1'));
	});

	test('orders IPv6 numerically, not lexically', () => {
		// The #1453 case: the last hextet differs; string sort mis-orders 0x9 vs 0x10.
		expect(ipv6ToBigInt('2001:db8::9')! < ipv6ToBigInt('2001:db8::10')!).toBe(true);
		expect(ipv6ToBigInt('2001:db8::2')! < ipv6ToBigInt('2001:db8::a')!).toBe(true);
	});

	test('rejects invalid input', () => {
		expect(ipv6ToBigInt('192.168.0.1')).toBeNull(); // no colon
		expect(ipv6ToBigInt('2001::db8::1')).toBeNull(); // two '::'
		expect(ipv6ToBigInt('gggg::1')).toBeNull(); // non-hex
		expect(ipv6ToBigInt('1:2:3:4:5:6:7:8:9')).toBeNull(); // too many groups
		expect(ipv6ToBigInt('')).toBeNull();
	});
});

describe('compareIps (#1453 mixed v4/v6 ordering)', () => {
	test('orders IPv6 subnets numerically (the reported bug)', () => {
		const subnets = ['2001:db8::10/64', '2001:db8::2/64', '2001:db8::a/64', '2001:db8::1/64'];
		const sorted = [...subnets].sort(compareIps);
		expect(sorted).toEqual([
			'2001:db8::1/64',
			'2001:db8::2/64',
			'2001:db8::a/64',
			'2001:db8::10/64'
		]);
	});

	test('IPv4 sorts before IPv6, each family numerically', () => {
		const mixed = ['fd00::1', '10.0.0.5', 'fd00::2', '10.0.0.1', '2001:db8::1'];
		const sorted = [...mixed].sort(compareIps);
		expect(sorted).toEqual(['10.0.0.1', '10.0.0.5', '2001:db8::1', 'fd00::1', 'fd00::2']);
	});

	test('empty / invalid values sort last', () => {
		const list = ['fd00::1', '-', '10.0.0.1', undefined, null, 'garbage'];
		const sorted = [...list].sort(compareIps);
		expect(sorted.slice(0, 2)).toEqual(['10.0.0.1', 'fd00::1']);
		// the three empty/invalid entries trail, order among them not significant
		expect(new Set(sorted.slice(2))).toEqual(new Set(['-', undefined, null, 'garbage']));
	});

	test('is a stable transitive comparator (returns -1/0/1 semantics)', () => {
		expect(compareIps('10.0.0.1', '10.0.0.1')).toBe(0);
		expect(compareIps('10.0.0.1', '10.0.0.2')).toBeLessThan(0);
		expect(compareIps('2001:db8::2', '2001:db8::1')).toBeGreaterThan(0);
	});
});
