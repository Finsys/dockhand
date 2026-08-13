// The OIDC discovery URLs to try for an issuer, in order. The spec path is
// `/.well-known/openid-configuration` WITHOUT a trailing slash, so that's tried first. Some
// providers (e.g. FortiAuthenticator #1368) 404 the canonical path and only serve the
// trailing-slash variant, so we fall back to it. A spec-compliant provider answers the first
// URL and the fallback is never requested.
export function oidcDiscoveryUrls(issuerUrl: string): string[] {
	const base = issuerUrl.endsWith('/') ? issuerUrl.slice(0, -1) : issuerUrl;
	const canonical = `${base}/.well-known/openid-configuration`;
	return [canonical, `${canonical}/`];
}

type FetchLike = (url: string) => Promise<{ ok: boolean; statusText: string }>;

/**
 * Fetch the OIDC discovery document, trying each candidate URL in order and returning the first
 * OK response. A not-ok (e.g. 404) falls through to the next URL; a NETWORK error is fatal (the
 * host is unreachable either way) and is rethrown with the issuer + cause surfaced (#1293).
 * Throws with the last not-ok statusText if every candidate was reachable but rejected.
 * `fetchFn` is injected so the retry logic is testable without a process-global fetch mock.
 */
export async function fetchOidcDiscovery<R extends { ok: boolean; statusText: string }>(
	urls: string[],
	fetchFn: (url: string) => Promise<R>
): Promise<R> {
	let lastNotOk = '';
	for (const url of urls) {
		let r: R;
		try {
			r = await fetchFn(url);
		} catch (err: any) {
			const cause = err?.cause?.message || err?.cause?.code || err?.cause;
			throw new Error(
				`Failed to reach OIDC issuer at ${url}: ${err?.message || err}` +
				(cause ? ` (${cause})` : '')
			);
		}
		if (r.ok) return r;
		lastNotOk = r.statusText;
	}
	throw new Error(`Failed to fetch OIDC discovery document: ${lastNotOk}`);
}
