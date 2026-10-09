/**
 * Canonicalising an IPv4 host before the host policy reads it.
 *
 * A resolver accepts an address in several forms - `127.1`, `2130706433`,
 * `017700000001` and `0x7f.0.0.1` all reach 127.0.0.1 - so the policy has to judge the
 * address the resolver will use rather than the spelling it was given. The URL parser
 * normalises this only for a special scheme (http, https), so canonicalisation lives
 * here, inside ipCategory, where every caller gets it.
 */
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { canonicalV4, ipCategory, dangerousHostReason } from '../src/lib/server/url-safety';

describe('canonicalV4', () => {
	test('a dotted quad is already canonical', () => {
		expect(canonicalV4('127.0.0.1')).toBe('127.0.0.1');
		expect(canonicalV4('192.168.1.7')).toBe('192.168.1.7');
		expect(canonicalV4('0.0.0.0')).toBe('0.0.0.0');
		expect(canonicalV4('255.255.255.255')).toBe('255.255.255.255');
	});

	test('a single number is the whole 32-bit address', () => {
		expect(canonicalV4('2130706433')).toBe('127.0.0.1');
		expect(canonicalV4('2852039166')).toBe('169.254.169.254');
		expect(canonicalV4('0')).toBe('0.0.0.0');
		expect(canonicalV4('4294967295')).toBe('255.255.255.255');
	});

	test('a short form lets the last part absorb the remaining octets', () => {
		expect(canonicalV4('127.1')).toBe('127.0.0.1');
		expect(canonicalV4('10.1')).toBe('10.0.0.1');
		expect(canonicalV4('192.168.257')).toBe('192.168.1.1');
	});

	test('octal and hexadecimal parts are read in their own base', () => {
		expect(canonicalV4('017700000001')).toBe('127.0.0.1');
		expect(canonicalV4('0x7f000001')).toBe('127.0.0.1');
		expect(canonicalV4('0x7f.0.0.1')).toBe('127.0.0.1');
		expect(canonicalV4('0177.0.0.1')).toBe('127.0.0.1');
		expect(canonicalV4('0xa9fea9fe')).toBe('169.254.169.254');
	});

	// Over-blocking would break a self-hosted deployment, so anything that is not an
	// IPv4 address in one of these forms has to come back untouched.
	test('a hostname is returned unchanged', () => {
		for (const h of ['nas.local', 'example.com', 'backup-server', 'v1.2.3', 'abc', '']) {
			expect(canonicalV4(h)).toBe(h);
		}
	});

	test('an IPv6 literal is returned unchanged', () => {
		for (const h of ['::1', 'fd00::1', '[fd00::1]', 'fe80::1%eth0', '64:ff9b:1::1']) {
			expect(canonicalV4(h)).toBe(h);
		}
	});

	test('a malformed or out-of-range address is returned unchanged', () => {
		for (const h of ['1.2.3.4.5', '999.1.1.1', '256.0.0.1', '1.2.3.', '.1.2.3', '0x', '08', '1..2', '-1', '1e3']) {
			expect(canonicalV4(h)).toBe(h);
		}
	});

	// The two overflow cases differ because resolvers treat them differently: measured
	// with ssh, `127.16777216` does not resolve at all, while a lone number is taken
	// modulo 2^32 by inet_aton. So the first must be left alone (rewriting it would
	// block a host nobody could reach) and the second must wrap.
	test('a multi-part value that overflows its span is not rewritten', () => {
		expect(canonicalV4('127.16777216')).toBe('127.16777216');
		expect(canonicalV4('192.168.65536')).toBe('192.168.65536');
	});

	test('a lone number past 2^32 wraps, the way the resolver reads it', () => {
		expect(canonicalV4('4294967296')).toBe('0.0.0.0');
		expect(canonicalV4('4294967297')).toBe('0.0.0.1');
		expect(canonicalV4('0x17f000001')).toBe('127.0.0.1');
		expect(canonicalV4('0177777777777')).toBe('255.255.255.255');
		expect(canonicalV4('6442450945')).toBe('128.0.0.1');
	});

	// Past 2^53 a float silently loses the low bits, which are the whole address.
	test('a value too large for a float is still read exactly', () => {
		expect(canonicalV4('18446744073709551617')).toBe('0.0.0.1');
		expect(canonicalV4('99999999999999999999')).toBe('99.15.255.255');
	});
});

describe('the host policy reads the normalized address', () => {
	test('every spelling of loopback is categorised as loopback', () => {
		// Each of these was checked against ssh, which resolves them all to 127.0.0.1.
		for (const h of ['127.0.0.1', '127.1', '2130706433', '017700000001', '0x7f.0.0.1', '0x17f000001']) {
			expect(ipCategory(h)).toBe('loopback');
			expect(dangerousHostReason(h)).toBeTruthy();
		}
	});

	test('every spelling of the cloud metadata address is blocked', () => {
		for (const h of ['169.254.169.254', '2852039166', '0xa9fea9fe']) {
			expect(ipCategory(h)).toBe('metadata');
			expect(dangerousHostReason(h)).toBeTruthy();
		}
	});

	// A backup repo or a notification receiver on the LAN is the normal self-hosted
	// case, so these have to keep working - normalization must not widen what is refused.
	test('an ordinary LAN address and a hostname still pass', () => {
		for (const h of ['192.168.1.7', '10.0.0.5', '172.16.0.1', 'nas.local', 'example.com']) {
			expect(dangerousHostReason(h)).toBeNull();
		}
	});
});
