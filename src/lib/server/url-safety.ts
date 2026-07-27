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

export function ipCategory(host: string): IpCategory | null {
	const h = host.toLowerCase().replace(/^\[|\]$/g, '');
	// IPv6 loopback, then link-local / unique-local (treated as private).
	if (h === '::1') return 'loopback';
	if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return 'private';
	// IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) — judge the embedded v4.
	const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	const v4 = mapped ? mapped[1] : h;
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
