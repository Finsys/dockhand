import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { formatCertName, daysUntilExpiry, expiryLine } from '../src/lib/server/x509-display-core';

// The shape Node reports in x509.validTo, which is what the caller passes in.
const NOW = new Date('Jan  1 00:00:00 2026 GMT').getTime();

describe('formatCertName', () => {
	test('a certificate with no distinguished name reads as none, not a crash', () => {
		// Node leaves subject/issuer undefined for an empty DN, which is what newer
		// Let's Encrypt profiles issue.
		expect(formatCertName(undefined)).toBe('(none)');
		expect(formatCertName(null)).toBe('(none)');
	});

	test('an empty or blank name reads as none rather than an empty log line', () => {
		expect(formatCertName('')).toBe('(none)');
		expect(formatCertName('   ')).toBe('(none)');
		expect(formatCertName('\n')).toBe('(none)');
	});

	test('a multi-line name collapses onto one line', () => {
		expect(formatCertName('CN=example.test\nO=Example\nC=PL')).toBe(
			'CN=example.test, O=Example, C=PL'
		);
	});

	test('a single-line name is passed through', () => {
		expect(formatCertName('CN=example.test')).toBe('CN=example.test');
	});

	test('a non-string never reaches replace', () => {
		expect(formatCertName(42 as never)).toBe('(none)');
		expect(formatCertName({} as never)).toBe('(none)');
	});
});

describe('daysUntilExpiry', () => {
	test('counts whole days ahead', () => {
		expect(daysUntilExpiry('Jan 31 00:00:00 2026 GMT', NOW)).toBe(30);
	});

	test('an expired certificate counts negative, which drives the expiry warning', () => {
		expect(daysUntilExpiry('Dec 30 00:00:00 2025 GMT', NOW)).toBe(-2);
	});

	test('an unparseable or missing validTo reports unknown instead of NaN days', () => {
		expect(daysUntilExpiry(undefined, NOW)).toBeNull();
		expect(daysUntilExpiry('not a date', NOW)).toBeNull();
		expect(daysUntilExpiry(42 as never, NOW)).toBeNull();
	});

	test('an openssl date with a padded day-of-month parses', () => {
		// x509.validTo pads single digits: "Jul  9 23:59:59 2026 GMT".
		expect(daysUntilExpiry('Jan  9 00:00:00 2026 GMT', NOW)).toBe(8);
	});
});

describe('expiryLine', () => {
	test('a healthy certificate is logged without a warning', () => {
		expect(expiryLine(64)).toEqual({ text: 'cert expires in 64 day(s)', warn: false });
	});

	test('the last 30 days warn, since that is when renewal matters', () => {
		expect(expiryLine(29)).toEqual({ text: 'WARNING: certificate expires in 29 day(s)', warn: true });
		expect(expiryLine(0)).toEqual({ text: 'WARNING: certificate expires in 0 day(s)', warn: true });
		expect(expiryLine(30).warn).toBe(false);
	});

	test('an expired certificate warns and reads as days ago, not negative days', () => {
		expect(expiryLine(-2)).toEqual({ text: 'WARNING: certificate expired 2 day(s) ago', warn: true });
	});

	test('an unknown expiry says so rather than reporting NaN days', () => {
		expect(expiryLine(null)).toEqual({ text: 'cert expiry:  (unknown)', warn: false });
	});
});

describe('the copy in server.js', () => {
	// server.js runs against ./build and cannot import from src, so it carries an
	// inline duplicate - and that duplicate is the one that actually serves. Compare
	// behaviour rather than text, so reformatting one copy is not a false alarm.
	const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

	function inlineFns(): {
		formatCertName: (n: unknown) => string;
		daysUntilExpiry: (v: unknown, now: number) => number | null;
		expiryLine: (d: number | null) => { text: string; warn: boolean };
	} {
		const grab = (name: string) => {
			const start = serverSrc.indexOf(`const ${name} = (`);
			expect(start).toBeGreaterThan(-1);
			const end = serverSrc.indexOf('\n\t};', start);
			expect(end).toBeGreaterThan(start);
			return serverSrc.slice(start, end + 4);
		};
		const factory = new Function(
			`${grab('formatCertName')}\n${grab('daysUntilExpiry')}\n${grab('expiryLine')}\n` +
				'return { formatCertName, daysUntilExpiry, expiryLine };'
		);
		return factory();
	}

	test('formatCertName behaves identically to the core module', () => {
		const inline = inlineFns().formatCertName;
		for (const input of [undefined, null, '', '   ', '\n', 'CN=a\nO=b', 'CN=a', 42, {}]) {
			expect(inline(input)).toBe(formatCertName(input as never));
		}
	});

	test('daysUntilExpiry behaves identically to the core module', () => {
		const inline = inlineFns().daysUntilExpiry;
		for (const input of [undefined, 'not a date', 'Jan 31 00:00:00 2026 GMT', 'Dec 30 00:00:00 2025 GMT']) {
			expect(inline(input, NOW)).toBe(daysUntilExpiry(input as never, NOW));
		}
	});

	test('expiryLine behaves identically to the core module', () => {
		const inline = inlineFns().expiryLine;
		for (const days of [null, -2, 0, 29, 30, 64]) {
			expect(inline(days)).toEqual(expiryLine(days));
		}
	});
});
