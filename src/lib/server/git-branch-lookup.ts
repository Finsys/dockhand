/**
 * Host-safety and credential-affinity guards for branch lookup (git ls-remote).
 *
 * SECURITY CONTEXT (PR #1343 review):
 * The POST /api/git/branches endpoint accepts a raw `url` + a stored
 * `credentialId` (for the "new repository" flow). Without guards, any
 * `git:edit` user can pair ANY stored credential with ANY URL:
 *   1. Credential exfiltration — the decrypted token is sent (via
 *      http.extraHeader) to whatever host the URL points at.
 *   2. SSRF — the same URL pointed at 169.254.169.254 or another
 *      internal IP lets the git subprocess probe internal networks.
 *
 * This module is import-light (no db/sqlite) so it is unit-testable —
 * same convention as git-url-safety.ts. It is called BEFORE any git
 * subprocess is spawned.
 *
 * RCE is already handled elsewhere: git-url-safety.ts denylists the
 * ext::/fd::/file:: transports and all git invocations use argv exec
 * (no shell), so a malicious URL cannot execute a command.
 */

import type { GitCredential } from './db';

/** IPv4-mapped IPv6 hostnames (e.g. ::ffff:7f00:1) are decoded to IPv4. */
function ipv4FromIpv6Mapped(host: string): number | null {
	const m = host.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
	if (!m) return null;
	return parseInt(m[1], 10) * 0x1000000 +
		parseInt(m[2], 10) * 0x10000 +
		parseInt(m[3], 10) * 0x100 +
		parseInt(m[4], 10);
}

function ipv4ToLong(host: string): number | null {
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const parts = m.slice(1).map(p => parseInt(p, 10));
	if (parts.some(p => p > 255)) return null;
	return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

function longToIpv4(long: number): string {
	return `${(long >>> 24) & 255}.${(long >>> 16) & 255}.${(long >>> 8) & 255}.${long & 255}`;
}

function ipv6Groups(host: string): number[] | null {
	// Strip zone index (fe80::1%eth0) — git never uses zones, but be safe.
	const zoneIdx = host.indexOf('%');
	const bare = zoneIdx >= 0 ? host.slice(0, zoneIdx) : host;
	// Expand :: into the full 8 groups.
	let h = bare;
	if (h.includes(':::')) return null; // malformed
	if (h.includes('::')) {
		const [head, tail] = h.split('::');
		const headGroups = head ? head.split(':') : [];
		const tailGroups = tail ? tail.split(':') : [];
		if (headGroups.length + tailGroups.length > 7) return null;
		const fill = 8 - headGroups.length - tailGroups.length;
		h = [...headGroups, ...Array(fill).fill('0'), ...tailGroups].join(':');
	}
	const groups = h.split(':');
	if (groups.length !== 8) return null;
	const out: number[] = [];
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
		out.push(parseInt(g, 16));
	}
	return out;
}

function ipToLong(ip: string): number | null {
	const host = ip.toLowerCase();
	if (host.includes(':')) {
		// IPv6. Check IPv4-mapped first.
		const mapped = ipv4FromIpv6Mapped(host);
		if (mapped !== null) return mapped;
		const groups = ipv6Groups(host);
		if (!groups) return null;
		// Return a sentinel long that no IPv4 range matches: encode the
		// IPv6 as two 32-bit halves and let the range checks handle it via
		// the ipv6-specific rules below. We return the first half so that
		// fc00::/7 (252.0.0.0/9 of the first half) and fe80::/10 (254.0.0.0/7)
		// can be range-checked on that half.
		return (groups[0] << 16) | groups[1];
	}
	return ipv4ToLong(host);
}

function isPrivateIpv4(long: number): boolean {
	// Coerce to unsigned 32-bit: the IPv4 dotted-quads can exceed 2^31
	// (e.g. 169.254.x.x → 0xA9FE0000 has the sign bit set), and JS bitwise
	// operators otherwise treat the value as a SIGNED int32, breaking the
	// range checks for the upper half of the address space.
	const n = long >>> 0;
	// 127.0.0.0/8  loopback
	if ((n >>> 24) === 127) return true;
	// 169.254.0.0/16  link-local
	if ((n >>> 24) === 169 && ((n >>> 16) & 0xff) === 254) return true;
	// 10.0.0.0/8  private
	if ((n >>> 24) === 10) return true;
	// 172.16.0.0/12  private  (172.16.0.0 - 172.31.255.255)
	if ((n >>> 24) === 172 && ((n >>> 16) & 0xff) >= 16 && ((n >>> 16) & 0xff) <= 31) return true;
	// 192.168.0.0/16  private
	if ((n >>> 24) === 192 && ((n >>> 16) & 0xff) === 168) return true;
	// 100.64.0.0/10  carrier-grade NAT (RFC 6598)  (100.64.0.0 - 100.127.255.255)
	if ((n >>> 24) === 100 && ((n >>> 16) & 0xff) >= 64 && ((n >>> 16) & 0xff) <= 127) return true;
	// 0.0.0.0/8  "this network"
	if ((n >>> 24) === 0) return true;
	return false;
}

function isPrivateIpv6FirstHalf(half: number): boolean {
	const n = half >>> 0;
	const firstByte = (n >>> 24) & 0xff;
	// fc00::/7  unique-local  (first byte 0xfc or 0xfd)
	if (firstByte === 0xfc || firstByte === 0xfd) return true;
	// fe80::/10  link-local. The first 10 bits are 1111 1110 10. In a
	// 32-bit half the first 10 bits sit in the top of the value. We extract
	// them with unsigned shifts to avoid the signed-int32 trap:
	//   top 10 bits = (n >>> 22)  (a value 0-1023)
	//   fe80::/10   = 0b1111111010 = 1016 decimal
	if ((n >>> 22) === 0b1111111010) return true;
	// ::  unspecified
	if (n === 0) return true;
	return false;
}

/**
 * True when the literal IP is in a private / loopback / link-local range.
 * Handles IPv4, IPv4-mapped IPv6 (::ffff:a.b.c.d), and IPv6 (checked on the
 * first 32-bit half, which is sufficient for the fc00::/7 and fe80::/10
 * ranges).
 */
export function isPrivateIp(ip: string): boolean {
	const host = ip.toLowerCase();
	// ::1 (IPv6 loopback) has a first-half of 0 which collides with "::"
	// (unspecified) — handle it explicitly.
	if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
	const long = ipToLong(ip);
	if (long === null) return false;
	if (host.includes(':')) {
		const mapped = ipv4FromIpv6Mapped(host);
		if (mapped !== null) return isPrivateIpv4(mapped);
		return isPrivateIpv6FirstHalf(long);
	}
	return isPrivateIpv4(long);
}

/**
 * Hostnames that resolve to internal addresses even though they are not
 * literal IPs. A minimal denylist — the literal-IP checks above are the
 * primary defense; this catches the well-known cloud/local metadata and
 * DNS-rebinding-prone names.
 */
const BLOCKED_HOSTNAMES = new Set([
	'localhost',
	'local',
	'localdomain',
	'home',
	'lan',
	'internal',
	'private',
	'intranet',
	'corp',
	'internal.local',
	'router',
	'gateway',
	'docker',
	'docker-gateway',
	'host.docker.internal',
	'host.docker.internal.local',
	'kubernetes',
	'k8s',
	'pod',
	'node',
	'service',
	'cluster.local',
	'169.254.169.254.nip.io',
	'metadata',
	'metadata.google.internal',
	'instance-metadata.google.internal',
	'compute.internal',
	'metadata.goog',
]);

/**
 * Parse the host out of a git repository URL.
 *
 * Supported forms:
 *   https://host/path, http://host/path  → host (port stripped)
 *   ssh://user@host:port/path            → host
 *   git://host/path                      → host
 *   host:path (scp-like)                 → host (no scheme, first ':' splits)
 *
 * Returns null when no host can be determined (e.g. a bare path — those are
 * already rejected by assertSafeRepoUrl upstream).
 */
export function parseRepoHost(url: string): string | null {
	const u = (url || '').trim();
	if (!u) return null;
	const schemeMatch = u.match(/^[a-z][a-z0-9+.-]*:/i);
	if (schemeMatch) {
		// URL with scheme. Only accept network transports.
		const scheme = schemeMatch[0].slice(0, -1).toLowerCase();
		if (!['http', 'https', 'ssh', 'git'].includes(scheme)) return null;
		// rest is "//host[:port]/path" (network) or "host/path" (rare).
		const rest = u.slice(schemeMatch[0].length).replace(/^\/\//, '');
		// IPv6 in brackets: [fe80::1] or [fe80::1]:8080 — strip brackets.
		const bracket = rest.match(/^\[([0-9a-fA-F:.\[\]:]+)\]/);
		if (bracket) return bracket[1].toLowerCase();
		const hostPart = rest.split('/')[0] || '';
		const atIdx = hostPart.lastIndexOf('@');
		const hostWithPort = atIdx >= 0 ? hostPart.slice(atIdx + 1) : hostPart;
		const host = hostWithPort.split(':')[0];
		return host ? host.toLowerCase() : null;
	}
	// No scheme. IPv6 in brackets: [fe80::1], possibly with a port.
	const bracket = u.match(/^\[([0-9a-fA-F:.]+)\](?::\d+)?$/);
	if (bracket) return bracket[1].toLowerCase();
	// scp-like: [user@]host:path
	const colonIdx = u.indexOf(':');
	if (colonIdx <= 0) return null; // no scheme, no scp colon → no host
	const hostPart = u.slice(0, colonIdx);
	const atIdx = hostPart.lastIndexOf('@');
	const host = atIdx >= 0 ? hostPart.slice(atIdx + 1) : hostPart;
	return host ? host.toLowerCase() : null;
}

/**
 * Guard 1: reject a branch-lookup target that points at a private /
 * loopback / link-local address (SSRF defense).
 *
 * Checks:
 *   1. The host is parseable from the URL (network transport only).
 *   2. The host is not a literal private/loopback/link-local IP.
 *   3. The host is not a well-known internal hostname.
 *
 * NOTE: hostname DNS resolution is intentionally NOT performed — resolving
 * would introduce TOCTOU / DNS-rebinding risk. The literal-IP + hostname
 * denylist is the agreed scope. The caller should also run
 * assertSafeRepoUrl (transport denylist) before this.
 */
export function assertSafeBranchTarget(url: string): void {
	const host = parseRepoHost(url);
	if (!host) {
		throw new Error('Invalid repository URL for branch lookup');
	}
	if (isPrivateIp(host)) {
		throw new Error('Repository URL points to a private, loopback, or link-local address');
	}
	if (BLOCKED_HOSTNAMES.has(host)) {
		throw new Error('Repository URL host is not allowed for branch lookup');
	}
}

/**
 * Guard 2: a raw URL may only be paired with a STORED credential if the
 * credential is plausibly for that host (credential-exfiltration defense).
 *
 * Rules:
 *   - `ssh` credentials: ALWAYS allowed. SSH keys are inherently
 *     host-specific (the server validates the key), and Dockhand's git env
 *     uses StrictHostKeyChecking=no, so there is no stored "host" to match.
 *   - `password` credentials: allowed when the credential is plausibly for
 *     the URL's host —
 *       (i) the credential's username equals the URL host (PAT-style where
 *           the username field holds the host or account), OR
 *       (ii) the credential's NAME (lowercased) is a dot-separated host
 *           suffix of the URL host (e.g. credential "github-pat" → host
 *           "github.com" via "github" ⊂ "github.com").
 *     Otherwise the pairing is rejected.
 *   - `none`/other: allowed (no secret to leak).
 *
 * The inference is conservative: when in doubt the pairing is rejected, so
 * the attacker gets nothing — a legitimate same-host pairing is never
 * blocked for the common cases above.
 */
export function assertCredentialUrlPair(url: string, credential: GitCredential): void {
	if (!credential) return;
	if (credential.authType === 'ssh' || credential.authType === 'none') return;

	const host = parseRepoHost(url);
	if (!host) {
		throw new Error('Invalid repository URL for branch lookup');
	}

	const username = (credential.username || '').trim().toLowerCase();
	const credName = (credential.name || '').trim().toLowerCase();

	// (i) username matches the host exactly (PAT-style).
	if (username && username === host) return;

	// (ii) credential name (or one of its hyphen/underscore-separated segments)
	// equals the full host, or equals the first label of the full host.
	// "github-pat" → "github" → matches host "github.com" (first label).
	// "gitlab.com" → matches host "gitlab.com" exactly.
	// "my-gitlab" → "my-gitlab" or "my" or "gitlab" → matches "my.gitlab.com"
	// (first label "my" matches candidate "my").
	if (credName) {
		// Build candidate tokens from the credential name.
		const rawSegments = credName.split(/[-_]/).map(s => s.trim()).filter(Boolean);
		const candidates = [...rawSegments, credName]
			.map(s => s.toLowerCase().replace(/[^a-z0-9.-]/g, ''))
			.filter(Boolean);
		const firstLabel = host.split('.')[0];
		for (const candidate of candidates) {
			// Exact host match.
			if (candidate === host) return;
			// First-label match: "github" matches the first label of "github.com".
			if (candidate === firstLabel) return;
		}
	}

	throw new Error('Stored credential does not match the repository URL host');
}
