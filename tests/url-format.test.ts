import { describe, test, expect } from 'bun:test';
import { formatHostPortUrl } from '../src/lib/utils/url';

describe('formatHostPortUrl', () => {
	test('formats IPv4 address', () => {
		expect(formatHostPortUrl('192.168.1.1', 8080)).toBe('http://192.168.1.1:8080');
	});

	test('formats localhost', () => {
		expect(formatHostPortUrl('localhost', 3000)).toBe('http://localhost:3000');
	});

	test('wraps IPv6 address in brackets', () => {
		expect(formatHostPortUrl('2001:db8::1', 8080)).toBe('http://[2001:db8::1]:8080');
	});

	test('does not double-bracket already bracketed IPv6', () => {
		expect(formatHostPortUrl('[2001:db8::1]', 8080)).toBe('http://[2001:db8::1]:8080');
	});

	test('formats hostname', () => {
		expect(formatHostPortUrl('example.com', 443)).toBe('http://example.com:443');
	});
});
