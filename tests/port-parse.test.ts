import { describe, test, expect } from 'bun:test';
import { parseHostPort, validatePort, validateIp, expandPortBindings, formatHostPort } from '../src/lib/utils/port-parse';

describe('parseHostPort', () => {
	test('empty string', () => {
		expect(parseHostPort('')).toEqual({ hostIp: '', hostPort: '' });
		expect(parseHostPort('  ')).toEqual({ hostIp: '', hostPort: '' });
	});

	test('simple port number', () => {
		expect(parseHostPort('8080')).toEqual({ hostIp: '', hostPort: '8080' });
		expect(parseHostPort('443')).toEqual({ hostIp: '', hostPort: '443' });
	});

	test('port range', () => {
		expect(parseHostPort('8000-8005')).toEqual({ hostIp: '', hostPort: '8000-8005' });
	});

	test('IPv4:port', () => {
		expect(parseHostPort('127.0.0.1:8080')).toEqual({ hostIp: '127.0.0.1', hostPort: '8080' });
		expect(parseHostPort('0.0.0.0:3000')).toEqual({ hostIp: '0.0.0.0', hostPort: '3000' });
		expect(parseHostPort('192.168.1.100:443')).toEqual({ hostIp: '192.168.1.100', hostPort: '443' });
	});

	test('IPv4 with port range', () => {
		expect(parseHostPort('127.0.0.1:8000-8005')).toEqual({ hostIp: '127.0.0.1', hostPort: '8000-8005' });
	});

	test('bracketed IPv6:port', () => {
		expect(parseHostPort('[::1]:8080')).toEqual({ hostIp: '::1', hostPort: '8080' });
		expect(parseHostPort('[::]:3000')).toEqual({ hostIp: '::', hostPort: '3000' });
		expect(parseHostPort('[fe80::1]:443')).toEqual({ hostIp: 'fe80::1', hostPort: '443' });
	});

	test('unbracketed IPv6 is treated as bare IP (use brackets for IPv6:port)', () => {
		// Bare multi-colon strings are ambiguous — treated as IPv6 address, no port
		expect(parseHostPort('::1:8080')).toEqual({ hostIp: '::1:8080', hostPort: '' });
		expect(parseHostPort('::1')).toEqual({ hostIp: '::1', hostPort: '' });
	});

	test('whitespace trimming', () => {
		expect(parseHostPort(' 8080 ')).toEqual({ hostIp: '', hostPort: '8080' });
		expect(parseHostPort(' 127.0.0.1:8080 ')).toEqual({ hostIp: '127.0.0.1', hostPort: '8080' });
	});
});

describe('validatePort', () => {
	test('empty is valid (random allocation)', () => {
		expect(validatePort('')).toBe('');
	});

	test('valid single ports', () => {
		expect(validatePort('1')).toBe('');
		expect(validatePort('80')).toBe('');
		expect(validatePort('8080')).toBe('');
		expect(validatePort('65535')).toBe('');
	});

	test('valid port ranges', () => {
		expect(validatePort('8000-8005')).toBe('');
		expect(validatePort('1-65535')).toBe('');
	});

	test('invalid port numbers', () => {
		expect(validatePort('0')).not.toBe('');
		expect(validatePort('65536')).not.toBe('');
		expect(validatePort('99999')).not.toBe('');
		expect(validatePort('abc')).not.toBe('');
		expect(validatePort('-1')).not.toBe('');
	});

	test('invalid port ranges', () => {
		expect(validatePort('8005-8000')).not.toBe(''); // start >= end
		expect(validatePort('0-100')).not.toBe(''); // start out of range
		expect(validatePort('100-70000')).not.toBe(''); // end out of range
	});
});

describe('validateIp', () => {
	test('empty is valid (all interfaces)', () => {
		expect(validateIp('')).toBe('');
	});

	test('valid IPv4', () => {
		expect(validateIp('127.0.0.1')).toBe('');
		expect(validateIp('0.0.0.0')).toBe('');
		expect(validateIp('192.168.1.100')).toBe('');
		expect(validateIp('255.255.255.255')).toBe('');
	});

	test('valid IPv6', () => {
		expect(validateIp('::1')).toBe('');
		expect(validateIp('::')).toBe('');
		expect(validateIp('fe80::1')).toBe('');
	});

	test('invalid IPs', () => {
		expect(validateIp('256.0.0.1')).not.toBe('');
		expect(validateIp('not-an-ip')).not.toBe('');
		expect(validateIp('192.168.1')).not.toBe('');
	});
});

describe('expandPortBindings', () => {
	test('single port mapping', () => {
		const result = expandPortBindings('8080', '80', 'tcp', '');
		expect(result).toEqual({
			'80/tcp': { HostPort: '8080' }
		});
	});

	test('single port with IP', () => {
		const result = expandPortBindings('8080', '80', 'tcp', '127.0.0.1');
		expect(result).toEqual({
			'80/tcp': { HostIp: '127.0.0.1', HostPort: '8080' }
		});
	});

	test('empty host port (random allocation)', () => {
		const result = expandPortBindings('', '80', 'tcp', '');
		expect(result).toEqual({
			'80/tcp': { HostPort: '0' }
		});
	});

	test('UDP protocol', () => {
		const result = expandPortBindings('5353', '53', 'udp', '');
		expect(result).toEqual({
			'53/udp': { HostPort: '5353' }
		});
	});

	test('port range expansion', () => {
		const result = expandPortBindings('8000-8002', '9000-9002', 'tcp', '');
		expect(result).toEqual({
			'9000/tcp': { HostPort: '8000' },
			'9001/tcp': { HostPort: '8001' },
			'9002/tcp': { HostPort: '8002' }
		});
	});

	test('port range with IP', () => {
		const result = expandPortBindings('8000-8001', '9000-9001', 'tcp', '192.168.1.1');
		expect(result).toEqual({
			'9000/tcp': { HostIp: '192.168.1.1', HostPort: '8000' },
			'9001/tcp': { HostIp: '192.168.1.1', HostPort: '8001' }
		});
	});

	test('container range with single host port (each gets same host port)', () => {
		const result = expandPortBindings('0', '9000-9002', 'tcp', '');
		expect(result).toEqual({
			'9000/tcp': { HostPort: '0' },
			'9001/tcp': { HostPort: '0' },
			'9002/tcp': { HostPort: '0' }
		});
	});
});

describe('formatHostPort', () => {
	test('no IP', () => {
		expect(formatHostPort('', '8080')).toBe('8080');
	});

	test('IPv4', () => {
		expect(formatHostPort('127.0.0.1', '8080')).toBe('127.0.0.1:8080');
	});

	test('IPv6 gets brackets', () => {
		expect(formatHostPort('::1', '8080')).toBe('[::1]:8080');
		expect(formatHostPort('fe80::1', '443')).toBe('[fe80::1]:443');
	});
});

describe('round-trip: parse then format', () => {
	const cases = [
		'8080',
		'127.0.0.1:8080',
		'0.0.0.0:3000',
		'[::1]:8080',
		'8000-8005',
		'127.0.0.1:8000-8005',
	];

	for (const input of cases) {
		test(`round-trip: ${input}`, () => {
			const parsed = parseHostPort(input);
			const formatted = formatHostPort(parsed.hostIp, parsed.hostPort);
			expect(formatted).toBe(input);
		});
	}
});
