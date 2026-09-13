/**
 * Security guards for user-supplied git repository URLs on the branch-lookup
 * and env-preview flows (POST /api/git/branches, POST /api/git/preview-env).
 *
 * Two guards protect these endpoints:
 *
 *  1. SSRF — the URL is handed to a git subprocess whose libcurl resolves
 *     EVERY legal IP encoding (decimal 2130706433, octal 0177.0.0.1, short
 *     form 127.1, hex 0x7f000001, un-compressed v4-mapped IPv6). Hand-rolled
 *     IP normalization is a rabbit hole — the SSRF check therefore delegates
 *     to isSafeNotificationUrl (src/lib/server/url-safety.ts), which is
 *     URL()-based, canonicalizes all of the encodings above, and is the same
 *     battle-tested guard our secret-provider hosts use. We only prepend a
 *     scheme so that ssh:// and scp-like URLs (which are valid git remotes
 *     but not valid URL() inputs) can be canonicalized.
 *
 *  2. Transport denylist — assertSafeRepoUrl (git-url-safety.ts) rejects the
 *     ext::/fd::/file:: transports and local paths. listRemoteBranches calls
 *     it explicitly so the denylist holds on every path into a git
 *     subprocess, not only via buildRepoUrl.
 *
 * Import-light (no db/sqlite) so it stays unit-testable.
 */

import { isSafeNotificationUrl } from './url-safety';
import { assertSafeRepoUrl } from './git-url-safety';
import type { GitCredential } from './db';

/**
 * Parse the host out of a git repository URL.
 *
 * Supported forms:
 *   https://host[:port]/path, http://...   → host (port stripped)
 *   ssh://[user@]host[:port]/path          → host
 *   git://host[:port]/path                 → host
 *   [user@]host:path (scp-like)            → host
 *   [fe80::1] / [fe80::1]:port            → fe80::1
 *
 * Returns null when no host can be determined (bare path — already rejected
 * by assertSafeRepoUrl upstream, or a scheme we don't accept).
 */
export function parseRepoHost(url: string): string | null {
	const u = (url || '').trim();
	if (!u) return null;
	const schemeMatch = u.match(/^[a-z][a-z0-9+.-]*:/i);
	if (schemeMatch) {
		const scheme = schemeMatch[0].slice(0, -1).toLowerCase();
		if (!['http', 'https', 'ssh', 'git'].includes(scheme)) return null;
		const rest = u.slice(schemeMatch[0].length).replace(/^\/\//, '');
		// IPv6 in brackets: [fe80::1] or [fe80::1]:8080 — strip brackets.
		const bracket = rest.match(/^\[([0-9a-fA-F:.]+)\]/);
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

// ---------------------------------------------------------------------------
// Shared host safety check — ONE canonicalization path for every scheme.
//
// isSafeNotificationUrl is URL()-based: new URL() canonicalizes every
// legal IP encoding (decimal 2130706433, hex 0x7f000001, octal, short-form
// 127.1, v4-mapped IPv6) BEFORE the range check, and its hostname
// denylist covers internal hostnames. For non-http(s) git schemes we can't
// hand the original URL to it (URL() rejects ssh:// / git:// and scp-like
// syntax), so we canonicalize the PARSED host (port already stripped by
// parseRepoHost, brackets stripped for IPv6) under an https:// scheme and
// run it through the same battle-tested check. This closes the encoded-IP
// bypass on the ssh/git path: ipCategory matches only a plain dotted-quad,
// so decimal/hex/short-form hosts sailed through it.
// ---------------------------------------------------------------------------
function assertHostSafeFromParse(parsedHost: string): void {
	// IPv6 literals need brackets for URL() to accept them — but ONLY if the
	// host actually contains a colon. Wrapping a plain IPv4 literal
	// (10.0.0.5) in brackets produces an invalid URL() input, which would
	// be rejected as "not a valid URL" and block every LAN IP.
	const host = parsedHost.includes(':') ? `[${parsedHost}]` : parsedHost;
	const check = isSafeNotificationUrl(`https://${host}/`);
	if (!check.ok) {
		throw new Error(
			`Repository URL host is not allowed (loopback, cloud-metadata or other reserved/dangerous target): ${check.reason}`
		);
	}
}

/**
 * Guard 1: reject a git repository URL that points at a dangerous target
 * (SSRF defense), or a hostname that resolves to internal infrastructure.
 *
 * Policy (shared isSafeNotificationUrl / dangerousHostReason, src/lib/server/
 * url-safety.ts): loopback (127.x/::1), cloud-metadata / link-local
 * (169.254.169.254), multicast/reserved and localhost are REJECTED.
 * Ordinary private-LAN ranges (10.x / 192.168.x / 172.16-31.x) are INTENTIONALLY
 * ALLOWED so self-hosted Git servers on the RFC1918 LAN keep working — this
 * is Dockhand's self-hosted-service policy (same as the notification
 * receivers and backup repos). Do NOT "fix" this into the strict
 * isSafeWebhookUrl / privateIpReason policy (that blocks all private) —
 * doing so would break self-hosted Git on a LAN.
 *
 * Every scheme is judged on the CANONICALIZED host through
 * isSafeNotificationUrl (see assertHostSafeFromParse): http(s) via the
 * original URL, ssh/git/scp-like via the parsed host. localhost is blocked
 * explicitly so ssh://localhost and scp-like localhost stay covered by one
 * code path.
 */
export function assertSafeRepoTarget(url: string): void {
	assertSafeRepoUrl(url); // transport denylist (ext::/fd::/file::/local paths)
	const host = parseRepoHost(url);
	if (!host) {
		throw new Error('Invalid repository URL for branch lookup');
	}
	if (host === 'localhost' || host.endsWith('.localhost')) {
		throw new Error('Repository URL host is not allowed for branch lookup');
	}
	assertHostSafeFromParse(host);
}

