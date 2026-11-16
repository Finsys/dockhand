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
import { notificationFetch, resolvedHostReason } from '../src/lib/server/notifications/shared';
import { ipCategory } from '../src/lib/server/url-safety';
import { smtpHostReason } from '../src/lib/server/notifications/smtp-core';
import { sendMqtt } from '../src/lib/server/notifications/mqtt';
import { sendSmtpNotification } from '../src/lib/server/notifications/smtp';

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

describe('resolvedHostReason - where a notification host name points', () => {
	const dns = (table: Record<string, string[]>) => async (h: string) => {
		if (!(h in table)) throw new Error(`getaddrinfo ENOTFOUND ${h}`);
		return table[h];
	};
	const lookupAll = dns({
		'loop.example': ['127.0.0.1'],
		'loop6.example': ['::1'],
		'mapped.example': ['::ffff:127.0.0.1'],
		'meta.example': ['169.254.169.254'],
		'ecs.example': ['169.254.170.2'],
		'meta6.example': ['fd00:ec2::254'],
		'mixed.example': ['203.0.113.7', '127.0.0.1'],
		'meta-mapped.example': ['::ffff:169.254.169.254'],
		'any6.example': ['::'],
		'podman.example': ['169.254.1.2'],
		'ntfy.lan': ['192.168.1.20'],
		'relay.ts.net': ['100.101.102.103'],
		'ula.lan': ['fd12::20'],
		'public.example': ['203.0.113.7', '2001:db8::7']
	});

	test('a name that points at loopback or a cloud metadata endpoint is refused', async () => {
		for (const h of ['loop.example', 'loop6.example', 'mapped.example', 'meta.example', 'ecs.example', 'meta6.example', 'mixed.example', 'meta-mapped.example', 'any6.example']) {
			expect(await resolvedHostReason(h, lookupAll)).toContain('resolves to a blocked address');
		}
	});

	test('LAN, Tailscale, ULA, public and other link-local names stay allowed', async () => {
		// Podman maps host.containers.internal into 169.254/16; only the metadata endpoints are blocked there.
		for (const h of ['ntfy.lan', 'relay.ts.net', 'ula.lan', 'public.example', 'podman.example']) {
			expect(await resolvedHostReason(h, lookupAll)).toBeNull();
		}
	});

	test('allowLoopback lets loopback through and nothing else', async () => {
		const opt = { allowLoopback: true };
		expect(await resolvedHostReason('loop.example', lookupAll, opt)).toBeNull();
		expect(await resolvedHostReason('loop6.example', lookupAll, opt)).toBeNull();
		for (const h of ['meta.example', 'ecs.example', 'meta6.example', 'meta-mapped.example', 'any6.example']) {
			expect(await resolvedHostReason(h, lookupAll, opt)).toContain('resolves to a blocked address');
		}
	});

	test('IP literals and names that do not resolve are left to the other checks', async () => {
		const never = async () => { throw new Error('looked up'); };
		expect(await resolvedHostReason('127.0.0.1', never)).toBeNull();
		expect(await resolvedHostReason('[::1]', never)).toBeNull();
		expect(await resolvedHostReason('::1%lo0', never)).toBeNull();
		expect(await resolvedHostReason('missing.example', lookupAll)).toBeNull();
	});

	test('fetch and MQTT refuse a name that resolves to loopback before connecting; SMTP allows it', async () => {
		// localhost resolves offline, so this exercises the real resolver and the wiring.
		await expect(notificationFetch('http://localhost.:8080/hook')).rejects.toThrow(/resolves to a blocked address/);
		const payload = { title: 't', message: 'm' } as any;
		expect((await sendMqtt('mqtt://localhost.:1883/t', payload)).error).toMatch(/resolves to a blocked address/);
		// SMTP is the exception: a relay on the same host is allowed, so the guard lets it through.
		const smtp = { host: 'localhost.', port: 1, secure: false, from_email: 'a@b.c', to_emails: ['a@b.c'] } as any;
		expect((await sendSmtpNotification(smtp, payload)).error).not.toMatch(/blocked/);
	});
});

describe('IPv6 zone ids', () => {
	test('a zone id does not hide a loopback address', () => {
		expect(ipCategory('::1%lo0')).toBe('loopback');
		expect(ipCategory('[::1%1]')).toBe('loopback');
		expect(smtpHostReason('::ffff:169.254.169.254')).toContain('metadata');
		expect(ipCategory('fe80::1%eth0')).toBe('private');
	});
});
