import { describe, test, expect } from 'bun:test';
import { ipToNumber } from '../src/lib/utils/ip';

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
