/**
 * Safe cookie header parsing for WebSocket upgrades.
 *
 * Extracted from ws-auth so it can be unit-tested without pulling in the
 * DB/SvelteKit graph (#1224).
 */

export function safeDecode(v: string): string {
	// Browsers freely send cookies with stray `%` from third-party trackers and
	// legacy code. decodeURIComponent throws URIError on `%` not followed by two
	// hex digits, which would crash the entire WS upgrade — including the
	// session cookie we actually care about. Fall back to the raw value (#1224).
	try {
		return decodeURIComponent(v);
	} catch {
		return v;
	}
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
	if (!header) return {};
	const out: Record<string, string> = {};
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const k = part.slice(0, eq).trim();
		let v = part.slice(eq + 1).trim();
		if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		if (k) out[k] = safeDecode(v);
	}
	return out;
}
