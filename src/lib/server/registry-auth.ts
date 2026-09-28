import { isSafeNotificationUrl } from './url-safety';

/**
 * Encode the AuthConfig JSON as base64url **with `=` padding** for the
 * Docker X-Registry-Auth header. The Docker daemon decodes the header with
 * Go's `base64.URLEncoding.DecodeString`, which is base64url with padding —
 * unpadded base64url (Node's default 'base64url' Buffer encoding) is
 * silently treated as malformed, causing the daemon to fall back to
 * anonymous and trip the registry rate limit (#1105).
 *
 * Reference: moby/api/pkg/authconfig/authconfig.go uses
 * `base64.URLEncoding.EncodeToString` / `DecodeString`.
 */
export function encodeRegistryAuth(authConfig: object): string {
	const unpadded = Buffer.from(JSON.stringify(authConfig)).toString('base64url');
	return unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
}

/**
 * SSRF guard for a registry HOST derived from a user-controlled image reference
 * (e.g. `169.254.169.254:80/x/y:latest` in a container image or compose stack).
 * The update-check path fetches `https://<registry>/v2/...`, so a crafted image
 * name could point the server at loopback/metadata. A registry legitimately lives
 * on a LAN (self-hosted Harbor / `registry:5000`), so allow private ranges but
 * block loopback + cloud metadata (169.254.169.254) + reserved. Returns { ok } or
 * { ok:false, reason }. `registry` is a bare host[:port], no scheme.
 */
export function isSafeRegistryHost(registry: string): { ok: boolean; reason?: string } {
	return isSafeNotificationUrl(`https://${registry}`);
}

/**
 * Whether Basic credentials may be re-attached when a registry token request
 * redirects. True only when the host is unchanged. A Harbor behind a
 * TLS-terminating proxy advertises an `http://` realm that 301s to `https://`
 * on the SAME host; undici strips Authorization across that origin change,
 * turning a valid login into an anonymous 401. Re-attaching on a same-host
 * scheme/port change matches docker/curl. A host CHANGE must never re-send
 * creds (leak risk), so those are refused. (#1428)
 */
export function canReattachAuthOnRedirect(from: string, to: string): boolean {
	try {
		return new URL(from).hostname === new URL(to).hostname;
	} catch {
		return false;
	}
}

/** Injectable fetch, so the redirect-follow loop is unit-testable without a network. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; redirect?: 'manual' }) => Promise<Response>;

/**
 * Host-safety check for a registry token URL, applied to the initial URL and every
 * redirect hop (the realm and any redirect target are host-controlled, so each hop
 * is re-checked, not just the outer registry host). Registries live on public or
 * LAN hosts, so this uses the permissive policy (block loopback/metadata/reserved,
 * allow private ranges). Throws on a blocked host; callers degrade a thrown token
 * fetch to anonymous/null.
 */
function assertSafeRegistryUrl(u: string): void {
	const r = isSafeNotificationUrl(u);
	if (!r.ok) throw new Error(`registry token URL blocked: ${r.reason}`);
}

/**
 * Fetch a registry token URL, manually following up to a few same-host redirects
 * with the Authorization header re-attached. `authHeader` is the full header value
 * (e.g. `Basic abc...`) or null for anonymous. Cross-host redirects drop the header
 * (see canReattachAuthOnRedirect). Manual redirect handling is what fixes #1428:
 * undici's automatic follow strips Authorization across an http->https origin change.
 * Every hop (incl. the initial URL) passes assertSafeRegistryUrl.
 */
export async function fetchRegistryToken(
	tokenUrl: string,
	authHeader: string | null,
	fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<Response> {
	let url = tokenUrl;
	assertSafeRegistryUrl(url);
	for (let hop = 0; hop < 4; hop++) {
		const headers: Record<string, string> = { 'User-Agent': 'Dockhand/1.0' };
		if (authHeader) headers['Authorization'] = authHeader;
		const res = await fetchImpl(url, { headers, redirect: 'manual' });
		const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
		if (!location) return res;
		await res.body?.cancel().catch(() => {});
		const next = new URL(location, url).toString();
		assertSafeRegistryUrl(next);
		// Drop credentials if the redirect leaves the original host.
		if (!canReattachAuthOnRedirect(url, next)) authHeader = null;
		url = next;
	}
	// Too many hops: one final attempt so the caller sees a real status.
	const headers: Record<string, string> = { 'User-Agent': 'Dockhand/1.0' };
	if (authHeader) headers['Authorization'] = authHeader;
	return fetchImpl(url, { headers });
}
