/**
 * URL-safety primitives shared across subsystems (backup destinations,
 * notification channels, and anything else that fetches a user-configured URL).
 *
 * Neutral home: these functions have no dependency on the backup engine or the
 * notification router — both import DOWN into here rather than sideways into
 * each other. Pure functions, safe to unit-test in isolation.
 */

/**
 * SSRF guard for user-configured webhook URLs. Rejects non-http(s) schemes and
 * hosts that are loopback / private / link-local / metadata IPs. Returns { ok }
 * or { ok:false, reason }. NOTE: this checks the LITERAL host in the URL; a
 * hostname that resolves to a private IP via DNS is not caught here — full
 * DNS-rebinding protection (resolve + re-check at fetch time) is a follow-up.
 */
export function isSafeWebhookUrl(raw: string): { ok: boolean; reason?: string } {
	let u: URL;
	try { u = new URL(raw); } catch { return { ok: false, reason: 'not a valid URL' }; }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		return { ok: false, reason: `scheme ${u.protocol} not allowed (use http/https)` };
	}
	const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
	if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'localhost blocked' };
	const ipReason = privateIpReason(host);
	if (ipReason) return { ok: false, reason: ipReason };
	return { ok: true };
}

/**
 * SSRF guard for user-configured NOTIFICATION endpoints. Deliberately more
 * permissive than isSafeWebhookUrl: it blocks only loopback and cloud-metadata
 * (169.254.169.254) hosts — the addresses with no legitimate notification use
 * and the highest SSRF value — while allowing ordinary LAN ranges (10.x,
 * 192.168.x, 172.16-31.x) so a self-hosted ntfy/gotify/webhook receiver on the
 * local network still works. Same literal-host caveat as isSafeWebhookUrl.
 */
export function isSafeNotificationUrl(raw: string): { ok: boolean; reason?: string } {
	let u: URL;
	try { u = new URL(raw); } catch { return { ok: false, reason: 'not a valid URL' }; }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		return { ok: false, reason: `scheme ${u.protocol} not allowed (use http/https)` };
	}
	const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'localhost blocked' };
	const reason = dangerousHostReason(host);
	if (reason) return { ok: false, reason };
	return { ok: true };
}

/**
 * Classify an IP-literal host into a range category, or null if it is not an IP
 * literal or is an ordinary public address. Splitting loopback/metadata from the
 * broader private ranges lets callers choose their own policy: backup
 * destinations block everything private; notifications block only the dangerous
 * subset (loopback + cloud metadata) so a LAN endpoint on 10.x/192.168.x still
 * works. Non-IP hostnames return null (not literals to judge here).
 */
export type IpCategory = 'loopback' | 'metadata' | 'private' | 'reserved';

/**
 * Expand an IPv6 literal to exactly 8 numeric hextets, or null if it is not a
 * parseable IPv6 address. `new URL()` normalizes and compresses (`::`) v6 hosts, so
 * embedded-v4 extraction must work off the FULL hextet vector, not the compressed
 * text. A trailing dotted quad (`::ffff:1.2.3.4`) is folded into its two hextets.
 */
function expandV6(h: string): number[] | null {
	if (!h.includes(':')) return null;
	let s = h;
	// Fold a trailing dotted IPv4 (v4-mapped/compatible) into two hextets first.
	const dotted = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (dotted) {
		const [a, b, c, d] = [Number(dotted[2]), Number(dotted[3]), Number(dotted[4]), Number(dotted[5])];
		if ([a, b, c, d].some((n) => n > 255)) return null;
		s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = s.split('::');
	if (halves.length > 2) return null; // more than one "::" is invalid
	const parse = (part: string): number[] | null => {
		if (part === '') return [];
		const out: number[] = [];
		for (const g of part.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
			out.push(parseInt(g, 16));
		}
		return out;
	};
	const head = parse(halves[0]);
	const tail = halves.length === 2 ? parse(halves[1]) : [];
	if (head === null || tail === null) return null;
	if (halves.length === 2) {
		const fill = 8 - head.length - tail.length;
		if (fill < 0) return null;
		return [...head, ...new Array(fill).fill(0), ...tail];
	}
	return head.length === 8 ? head : null;
}

/** Two 16-bit hextets -> a dotted-quad IPv4 string. */
function hextetsToV4(hi: number, lo: number): string {
	return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Extract the embedded IPv4 dotted-quad from an IPv4-mapped/compatible IPv6 host OR
 * an IPv6 transition address (NAT64, 6to4, Teredo), or null. These transition
 * mechanisms carry a real IPv4 destination inside the v6 literal, so an SSRF guard
 * that only classifies the v6 prefix would wave through a loopback/metadata/private
 * target encoded this way. The embedded v4 is judged through the same range checks.
 */
function embeddedV4(h: string): string | null {
	const x = expandV6(h);
	if (!x) return null;

	// v4-mapped ::ffff:a.b.c.d (x = 0:0:0:0:0:ffff:HH:LL) and v4-translated
	// ::ffff:0:a.b.c.d, plus the deprecated IPv4-compatible ::a.b.c.d. In every case
	// the last two hextets hold the 32-bit v4.
	const mappedOrCompat =
		(x[0] === 0 && x[1] === 0 && x[2] === 0 && x[3] === 0 && x[4] === 0 && x[5] === 0xffff) || // ::ffff:v4
		(x[0] === 0 && x[1] === 0 && x[2] === 0 && x[3] === 0 && x[4] === 0xffff && x[5] === 0) || // ::ffff:0:v4
		(x[0] === 0 && x[1] === 0 && x[2] === 0 && x[3] === 0 && x[4] === 0 && x[5] === 0); // ::v4 (compat)
	if (mappedOrCompat) return hextetsToV4(x[6], x[7]);

	// NAT64 WKP: 64:ff9b::/96 (RFC 6052) - v4 in the last two hextets.
	if (x[0] === 0x64 && x[1] === 0xff9b && x[2] === 0 && x[3] === 0 && x[4] === 0 && x[5] === 0) {
		return hextetsToV4(x[6], x[7]);
	}

	// 6to4: 2002:V4HI:V4LO::/48 (RFC 3056) - the v4 is hextets 1 and 2.
	if (x[0] === 0x2002) return hextetsToV4(x[1], x[2]);

	// Teredo: 2001:0000::/32 (RFC 4380) - the client v4 is the LAST two hextets,
	// bitwise-inverted (obfuscated).
	if (x[0] === 0x2001 && x[1] === 0) return hextetsToV4(~x[6] & 0xffff, ~x[7] & 0xffff);

	// ISATAP (RFC 5214): the interface id ...:0:5efe:V4 (global-scope) or ...:200:5efe:V4
	// (private-scope EUI) carries the v4 in the last two hextets, under ANY /64 prefix.
	// Deliberately prefix-agnostic (ISATAP is not scoped to a prefix): a genuine public
	// address whose IID happens to be `0:5efe:<v4>` is decoded too and may over-block if
	// that v4 is private - the fail-SAFE direction (it only ever adds a block, never
	// removes one), and vanishingly rare, so accepted.
	if (x[5] === 0x5efe && (x[4] === 0 || x[4] === 0x0200)) return hextetsToV4(x[6], x[7]);

	return null;
}

export function ipCategory(host: string): IpCategory | null {
	const h = host.toLowerCase().replace(/^\[|\]$/g, '');
	// IPv6 loopback / unspecified, then link-local / unique-local (private).
	if (h === '::1') return 'loopback';
	if (h === '::' || h === '::0') return 'reserved'; // unspecified / all-interfaces
	// Require a colon so real IPv6 unique-local/link-local literals match but public
	// DNS names starting "fc"/"fd" (fcm.googleapis.com, fdroid.link) do not.
	if (h.startsWith('fe80:') || /^f[cd][0-9a-f]{0,2}:/.test(h)) return 'private';
	// NAT64 local prefix 64:ff9b:1::/48 (RFC 8215) embeds its v4 around the u-byte
	// (RFC 6052 2.2), not in the last 32 bits - awkward to decode and with no
	// legitimate use as a user-supplied target, so block the whole prefix outright.
	const x6 = expandV6(h);
	if (x6 && x6[0] === 0x64 && x6[1] === 0xff9b && x6[2] === 1) return 'reserved';
	// IPv4-mapped/compatible IPv6 — judge the embedded v4 (see embeddedV4).
	const v4 = embeddedV4(h) ?? h;
	const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		if (a === 127 || a === 0) return 'loopback';
		if (a === 169 && b === 254) return 'metadata'; // link-local / cloud metadata
		if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'private';
		if (a >= 224) return 'reserved'; // multicast/reserved
	}
	return null;
}

/**
 * The shared SSRF policy for user-configured hosts that legitimately live on a
 * LAN in self-hosted deployments (backup repos, notification receivers): block
 * only the addresses with no legitimate use and the highest SSRF value —
 * loopback, cloud metadata (169.254.169.254), and multicast/reserved — while
 * ALLOWING ordinary private ranges (10.x / 192.168.x / 172.16-31.x). Returns a
 * reason string for a blocked literal-IP host, or null. Non-IP hosts return null.
 */
export function dangerousHostReason(host: string): string | null {
	const cat = ipCategory(host);
	if (cat === 'loopback' || cat === 'metadata' || cat === 'reserved') {
		return `${cat} address (${host}) blocked`;
	}
	return null;
}

/**
 * Given a host string that IS an IP literal (v4 or v6), return a reason string
 * if it falls in ANY loopback / private / link-local / metadata / reserved
 * range, else null. This is the STRICT policy (block all private) used by backup
 * destinations. Non-IP hostnames return null.
 */
export function privateIpReason(host: string): string | null {
	const cat = ipCategory(host);
	if (!cat) return null;
	return `private/loopback IP (${host}) blocked`;
}
