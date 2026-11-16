import { describe, test, expect } from 'bun:test';
import { smtpHostReason } from '../src/lib/server/notifications/smtp-core';

// The SMTP host guard mirrors the MQTT channel's policy: block loopback, link-local
// cloud metadata and reserved ranges, but allow a private-LAN mail server.
describe('smtpHostReason', () => {
	test('allows ordinary public mail hosts', () => {
		expect(smtpHostReason('smtp.gmail.com')).toBeNull();
		expect(smtpHostReason('smtp.example.com')).toBeNull();
		expect(smtpHostReason('mail.fastmail.com')).toBeNull();
	});

	test('allows a private-LAN mail server (self-hosted is normal)', () => {
		expect(smtpHostReason('10.0.0.1')).toBeNull();
		expect(smtpHostReason('192.168.1.25')).toBeNull();
		expect(smtpHostReason('172.16.5.5')).toBeNull();
		expect(smtpHostReason('mail.lan')).toBeNull();
	});

	test('blocks cloud metadata (the reported SSRF target)', () => {
		expect(smtpHostReason('169.254.169.254')).not.toBeNull();
		expect(smtpHostReason('169.254.169.254')).toContain('metadata');
	});

	test('blocks loopback by IP and by name', () => {
		expect(smtpHostReason('127.0.0.1')).not.toBeNull();
		expect(smtpHostReason('0.0.0.0')).not.toBeNull();
		expect(smtpHostReason('localhost')).not.toBeNull();
		expect(smtpHostReason('db.localhost')).not.toBeNull();
		expect(smtpHostReason('[::1]')).not.toBeNull();
		expect(smtpHostReason('::1')).not.toBeNull();
	});

	test('blocks reserved / multicast', () => {
		expect(smtpHostReason('224.0.0.1')).not.toBeNull();
	});

	test('treats an empty host as invalid', () => {
		expect(smtpHostReason('')).toBe('missing SMTP host');
		expect(smtpHostReason(null)).toBe('missing SMTP host');
		expect(smtpHostReason(undefined)).toBe('missing SMTP host');
		expect(smtpHostReason('   ')).toBe('missing SMTP host');
	});

	test('is case- and whitespace-insensitive (no bypass via casing/padding)', () => {
		expect(smtpHostReason('  LOCALHOST  ')).not.toBeNull();
		expect(smtpHostReason(' 169.254.169.254 ')).not.toBeNull();
		// a near miss: a public host whose name merely contains the digits is allowed
		expect(smtpHostReason('smtp-10-0-0-1.example.com')).toBeNull();
	});
});
