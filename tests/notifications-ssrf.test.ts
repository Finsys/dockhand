/**
 * SSRF protection for the notification subsystem.
 *
 * Every notification channel dispatches through notificationFetch, which
 * validates the target URL before making any request. Notification endpoints
 * use a deliberately permissive policy (isSafeNotificationUrl): loopback and
 * cloud-metadata hosts are blocked, but ordinary LAN ranges are allowed so a
 * self-hosted receiver on the local network still works.
 */

import { describe, test, expect } from 'bun:test';
import { isSafeNotificationUrl } from '../src/lib/server/url-safety';
import { validateRepositoryForSave } from '../src/lib/server/backups/helpers';
import { notificationFetch } from '../src/lib/server/notifications/shared';

describe('isSafeNotificationUrl — notification endpoint guard', () => {
	test('blocks loopback and cloud-metadata hosts', () => {
		const blocked = [
			'http://169.254.169.254/',       // cloud metadata
			'http://localhost/hook',
			'http://127.0.0.1/hook',
			'http://[::1]/hook',
			'http://0.0.0.0/hook',
		];
		for (const url of blocked) {
			expect(isSafeNotificationUrl(url).ok).toBe(false);
		}
	});

	test('allows ordinary LAN hosts (self-hosted receivers)', () => {
		const allowed = [
			'http://10.0.0.5/hook',
			'http://192.168.1.10/hook',
			'http://172.16.0.1/hook',
		];
		for (const url of allowed) {
			expect(isSafeNotificationUrl(url).ok).toBe(true);
		}
	});

	test('rejects non-http(s) schemes', () => {
		expect(isSafeNotificationUrl('file:///etc/passwd').ok).toBe(false);
		expect(isSafeNotificationUrl('gopher://example.com/x').ok).toBe(false);
	});

	test('accepts a normal public https URL', () => {
		expect(isSafeNotificationUrl('https://hooks.example.com/services/abc').ok).toBe(true);
	});

	// A public DNS name starting "fc"/"fd" must not be mistaken for an fc00::/fd00::
	// IPv6 unique-local literal. (ULA itself is a LAN range, so the permissive
	// notification policy allows it - the strict-policy block is asserted below.)
	test('public hosts starting fc/fd are allowed (not treated as IPv6 ULA)', () => {
		for (const url of ['https://fcm.googleapis.com/x', 'https://fc2.com/x', 'https://fdroid.link/x']) {
			expect(isSafeNotificationUrl(url).ok).toBe(true);
		}
	});
});

import { ipCategory } from '../src/lib/server/url-safety';

describe('ipCategory — fc/fd anchoring', () => {
	test('real IPv6 unique-local / link-local literals are private', () => {
		for (const h of ['fc00::1', 'fd12:3456::1', 'fe80::1']) {
			expect(ipCategory(h)).toBe('private');
		}
	});

	test('public DNS names starting fc/fd are not IP literals', () => {
		for (const h of ['fcm.googleapis.com', 'fc2.com', 'fdroid.link', 'fd7host.example.com']) {
			expect(ipCategory(h)).toBe(null);
		}
	});
});

describe('ipCategory — IPv6 transition address bypass (NAT64 / 6to4 / Teredo)', () => {
	// new URL() normalizes/compresses a bracketed v6 host; these are the forms it emits.
	const norm = (v6: string) => new URL(`http://[${v6}]`).hostname.replace(/^\[|\]$/g, '');

	test('NAT64 WKP (64:ff9b::/96) embedded loopback/metadata/private is caught', () => {
		expect(ipCategory(norm('64:ff9b::7f00:1'))).toBe('loopback'); // 127.0.0.1
		expect(ipCategory(norm('64:ff9b::a9fe:a9fe'))).toBe('metadata'); // 169.254.169.254
		expect(ipCategory(norm('64:ff9b::a00:1'))).toBe('private'); // 10.0.0.1
	});

	test('NAT64 local prefix (64:ff9b:1::/48) is blocked wholesale (reserved)', () => {
		// The /48 embeds its v4 around the u-byte, not the last 32 bits, so the whole
		// prefix is blocked outright rather than decoded - it has no legitimate use.
		expect(ipCategory(norm('64:ff9b:1::7f00:1'))).toBe('reserved');
		expect(ipCategory(norm('64:ff9b:1::a9fe:a9fe'))).toBe('reserved');
		expect(ipCategory(norm('64:ff9b:1:a00:0:100::'))).toBe('reserved'); // RFC-6052 /48 layout
	});

	test('ISATAP interface-id (::0:5efe:v4 / ::200:5efe:v4, any prefix) is caught', () => {
		expect(ipCategory(norm('::0:5efe:127.0.0.1'))).toBe('loopback');
		expect(ipCategory(norm('::200:5efe:169.254.169.254'))).toBe('metadata');
		expect(ipCategory(norm('::5efe:10.0.0.1'))).toBe('private');
		// ISATAP is defined for any /64 prefix, including a global one.
		expect(ipCategory(norm('2001:db8::5efe:10.0.0.1'))).toBe('private');
	});

	test('6to4 (2002::/16) embedded v4 is caught', () => {
		expect(ipCategory(norm('2002:7f00:1::1'))).toBe('loopback'); // 127.0.0.1
		expect(ipCategory(norm('2002:a9fe:a9fe::1'))).toBe('metadata'); // 169.254.169.254
		expect(ipCategory(norm('2002:c0a8:1::1'))).toBe('private'); // 192.168.0.1
	});

	test('Teredo (2001:0000::/32) inverted client v4 is caught', () => {
		// last two hextets are the client v4, bitwise-inverted: ~0x80ff.~0xfffe = 127.0.0.1
		expect(ipCategory(norm('2001:0:ffff:ffff:ffff:ffff:80ff:fffe'))).toBe('loopback');
	});

	test('a transition prefix wrapping a PUBLIC v4 is NOT over-blocked', () => {
		expect(ipCategory(norm('64:ff9b::8.8.8.8'))).toBe(null); // NAT64 WKP of 8.8.8.8
		expect(ipCategory(norm('2002:0808:0808::1'))).toBe(null); // 6to4 of 8.8.8.8
		expect(ipCategory(norm('::0:5efe:8.8.8.8'))).toBe(null); // ISATAP of 8.8.8.8
	});

	test('a genuine public IPv6 address is not misread as a transition address', () => {
		expect(ipCategory(norm('2606:4700:4700::1111'))).toBe(null); // cloudflare
		expect(ipCategory(norm('2001:4860:4860::8888'))).toBe(null); // google (2001 but not Teredo/ISATAP)
	});
});

describe('validateRepositoryForSave — backup destination SSRF guard', () => {
	test('blocks loopback and cloud-metadata repo hosts', () => {
		expect(validateRepositoryForSave('rest:http://169.254.169.254/repo')).not.toBeNull();
		expect(validateRepositoryForSave('rest:http://127.0.0.1/repo')).not.toBeNull();
	});

	test('allows a self-hosted repo on a LAN host (MinIO/REST on the local network)', () => {
		expect(validateRepositoryForSave('rest:http://192.168.1.106/repo')).toBeNull();
		expect(validateRepositoryForSave('rest:http://10.0.0.5:8000/')).toBeNull();
	});

	test('allows a normal public repo and a local absolute path', () => {
		expect(validateRepositoryForSave('rest:https://backups.example.com/repo')).toBeNull();
		expect(validateRepositoryForSave('/srv/backups')).toBeNull();
	});

	test('rejects an unknown scheme', () => {
		expect(validateRepositoryForSave('gopher://example.com/x')).not.toBeNull();
	});
});

describe('notificationFetch — blocks before making a request', () => {
	test('throws on a cloud-metadata URL (no network access)', async () => {
		await expect(
			notificationFetch('http://169.254.169.254/latest/meta-data/')
		).rejects.toThrow(/Notification endpoint rejected/);
	});

	test('throws on a loopback URL object (no network access)', async () => {
		await expect(
			notificationFetch(new URL('http://127.0.0.1/hook'))
		).rejects.toThrow(/Notification endpoint rejected/);
	});
});
