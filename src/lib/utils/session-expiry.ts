// Decide whether a fetch response should trigger a session-expiry re-check (#1577).
// Pure so the path/status logic in +layout.svelte's fetch interceptor is unit-testable.
// A true result means "this looks like it could be an expired session" - the caller then
// confirms with the server before actually redirecting, so a proxied upstream-auth 401
// (e.g. bad registry credentials on /api/registry/image) is not treated as expiry until
// the session check says the user is really logged out.

export function extractPath(input: RequestInfo | URL, origin: string): string | null {
	try {
		let url: string;
		if (typeof input === 'string') url = input;
		else if (input instanceof Request) url = input.url;
		else url = String(input);
		return new URL(url, origin).pathname;
	} catch {
		return null;
	}
}

// Only a 401 on an /api/* path that is NOT one of the auth endpoints (session/login/logout,
// which legitimately 401 during normal auth flow) is a session-expiry candidate.
export function isSessionExpiryCandidate(status: number, path: string | null): boolean {
	if (status !== 401 || !path) return false;
	if (!path.startsWith('/api/')) return false;
	if (path.startsWith('/api/auth/')) return false;
	return true;
}
