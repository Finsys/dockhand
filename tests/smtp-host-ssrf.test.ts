import { describe, test, expect } from 'bun:test';
import { smtpHostReason } from '../src/lib/server/notifications/smtp-core';

// The SMTP host guard blocks link-local cloud metadata and reserved ranges, and allows a
// private-LAN mail server and a relay on the same host (loopback).
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

	test('allows a relay on the same host (loopback by IP and by name)', () => {
		expect(smtpHostReason('127.0.0.1')).toBeNull();
		expect(smtpHostReason('localhost')).toBeNull();
		expect(smtpHostReason('[::1]')).toBeNull();
		expect(smtpHostReason('::1%lo0')).toBeNull();
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
		expect(smtpHostReason(' 169.254.169.254 ')).not.toBeNull();
		expect(smtpHostReason(' 224.0.0.1 ')).not.toBeNull();
		// a near miss: a public host whose name merely contains the digits is allowed
		expect(smtpHostReason('smtp-10-0-0-1.example.com')).toBeNull();
	});
});
