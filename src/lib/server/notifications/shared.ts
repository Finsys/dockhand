/**
 * Shared types + helpers used by every notification provider.
 *
 * Imported by the router (./index.ts) and by every per-provider file
 * (discord.ts, slack.ts, …). Keeps the providers free of cross-imports —
 * each provider only depends on this module.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isSafeNotificationUrl, ipCategory, embeddedV4 } from '../url-safety';

export interface NotificationPayload {
	title: string;
	message: string;
	type?: 'info' | 'success' | 'warning' | 'error';
	environmentId?: number;
	environmentName?: string;
	eventType?: string;
	/**
	 * Files to attach. Only SMTP can carry these - a webhook channel has nowhere to put
	 * them, so a payload that NEEDS an attachment must be sent to an SMTP channel.
	 */
	attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}

export interface NotificationResult {
	success: boolean;
	error?: string;
}

/**
 * Timeout for an outbound notification request, overridable via
 * NOTIFICATION_TIMEOUT_MS. Falls back to 10s if unset or invalid (a bad value
 * must not silently disable the timeout).
 */
const NOTIFICATION_TIMEOUT_MS = (() => {
	const parsed = Number(process.env.NOTIFICATION_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();

/**
 * fetch() for notification destinations, hardened against SSRF.
 *
 * Notification endpoints are user- (or attacker-) configured, so before we make
 * the request we:
 *   1. Reject the target if its literal host is loopback/private/link-local/
 *      metadata, or the scheme isn't http(s) — throwing so the caller records a
 *      failed send rather than silently reaching an internal address.
 *   2. Pass `redirect: 'manual'` so a 3xx to a private host is NOT auto-followed;
 *      a redirect response is surfaced as a failed send (the endpoint tried to
 *      bounce us somewhere we won't follow).
 * Also applies a per-request timeout — a hung endpoint must not pin the request
 * indefinitely and block the rest of the dispatch.
 */
export async function notificationFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
	const target = typeof input === 'string' ? input : input.toString();
	const safe = isSafeNotificationUrl(target);
	if (!safe.ok) {
		throw new Error(`Notification endpoint rejected: ${safe.reason ?? 'unsafe URL'}`);
	}
	const resolvedReason = await resolvedHostReason(new URL(target).hostname);
	if (resolvedReason) {
		throw new Error(`Notification endpoint rejected: ${resolvedReason}`);
	}
	const response = await fetch(input, {
		...init,
		redirect: 'manual',
		signal: init.signal ?? AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS)
	});
	// With redirect:'manual', a 3xx means the endpoint tried to send us
	// elsewhere. We refuse to follow it (that target is unvalidated and could be
	// a private host), so treat it as a blocked/failed send.
	if (response.status >= 300 && response.status < 400) {
		await drainResponse(response);
		throw new Error(`Notification endpoint rejected: refusing to follow redirect (status ${response.status})`);
	}
	return response;
}

/** Cloud metadata endpoints (AWS/GCP/Azure, AWS ECS task metadata, AWS IPv6). */
const METADATA_ADDRESSES = new Set(['169.254.169.254', '169.254.170.2', 'fd00:ec2::254']);

/**
 * The literal-host checks cannot see where a NAME points. Resolve it and refuse it when
 * any address is loopback (unless allowLoopback, used by SMTP), reserved or a cloud metadata
 * endpoint. The rest of 169.254/16
 * stays allowed: Podman maps host.containers.internal there. A name that does not
 * resolve is left to the connection to fail. IP literals are judged by the callers.
 */
export async function resolvedHostReason(
	host: string,
	lookupAll: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
	{ allowLoopback = false }: { allowLoopback?: boolean } = {}
): Promise<string | null> {
	const name = host.trim().replace(/^\[|\]$/g, '');
	if (!name || isIP(name.replace(/%.*$/, ''))) return null;
	let addresses: string[];
	try {
		addresses = await lookupAll(name);
	} catch {
		return null;
	}
	for (const address of addresses) {
		const cat = ipCategory(address);
		const a = address.toLowerCase();
		if ((cat === 'loopback' && !allowLoopback) || cat === 'reserved' || METADATA_ADDRESSES.has(embeddedV4(a) ?? a)) {
			return `${name} resolves to a blocked address (${address})`;
		}
	}
	return null;
}

/** Drain a response body to release the underlying socket/TLS connection. */
export async function drainResponse(response: Response): Promise<void> {
	if (!response.bodyUsed) {
		try { await response.arrayBuffer(); } catch {}
	}
}

/** Append `[env name]` to a title when present. Used by every provider. */
export function titleWithEnv(payload: NotificationPayload): string {
	return payload.environmentName ? `${payload.title} [${payload.environmentName}]` : payload.title;
}

/**
 * Move `user:pass@` userinfo off a URL authority into a Basic Authorization header:
 * fetch() refuses URLs that carry credentials (#1611). user/pass are percent-decoded,
 * so `/ ? # %` (and ideally `@ :`) inside them must be encoded. Throws on malformed encoding.
 */
export function splitBasicAuth(authority: string): { host: string; authHeader: string | null } {
	// URL parsing ends the authority at a backslash, so an '@' after one is path, not userinfo.
	const backslash = authority.indexOf('\\');
	const at = authority.lastIndexOf('@', backslash === -1 ? authority.length : backslash);
	if (at === -1) return { host: authority, authHeader: null };
	const userinfo = authority.slice(0, at);
	const host = authority.slice(at + 1);
	const colon = userinfo.indexOf(':');
	let user: string;
	let pass: string;
	try {
		user = decodeURIComponent(colon === -1 ? userinfo : userinfo.slice(0, colon));
		pass = colon === -1 ? '' : decodeURIComponent(userinfo.slice(colon + 1));
	} catch {
		throw new Error('malformed percent-encoding in URL credentials');
	}
	if (!user && !pass) return { host, authHeader: null };
	return { host, authHeader: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}
