/**
 * Shared types + helpers used by every notification provider.
 *
 * Imported by the router (./index.ts) and by every per-provider file
 * (discord.ts, slack.ts, …). Keeps the providers free of cross-imports —
 * each provider only depends on this module.
 */

import { isSafeNotificationUrl } from '../url-safety';

export interface NotificationPayload {
	title: string;
	message: string;
	type?: 'info' | 'success' | 'warning' | 'error';
	environmentId?: number;
	environmentName?: string;
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
