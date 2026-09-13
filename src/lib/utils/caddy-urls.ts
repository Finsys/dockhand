/**
 * caddy-docker-proxy label -> public URL extraction (#1390).
 *
 * caddy-docker-proxy (https://github.com/lucaslorentz/caddy-docker-proxy) turns
 * container labels into a Caddyfile. The site address - the clickable URL - is the
 * VALUE of the bare `caddy` key (or `caddy_<N>` for isolated groups):
 *
 *   caddy: whoami.example.com                 -> https://whoami.example.com
 *   caddy: example.com, example.org           -> two URLs (comma-separated addresses)
 *   caddy_0: site-a.com                        -> grouped/isolated addresses
 *   caddy_1: site-b.com
 *   caddy: example.com/api/*                    -> https://example.com/api (path kept)
 *
 * Only the site-address key matters here; directive labels (`caddy.reverse_proxy`,
 * `caddy_0.tls`, ...) carry a dot after the prefix and are ignored.
 *
 * SCHEME: Caddy serves HTTPS automatically, so the default is https. It is http only
 * when the address says so explicitly - an `http://` scheme or an `:80` port. A
 * `:443`/`https://` is https; any other explicit port keeps https (Caddy still serves
 * TLS on a custom port). Snippet/named-matcher values like `(encode)` are NOT site
 * addresses and are skipped.
 *
 * dockhand.url labels override this - Caddy extraction is a fallback, never a winner
 * over an explicit user-provided URL.
 */
export interface CaddyUrl {
	url: string;
	/** The label key the address came from (`caddy` or `caddy_0`, ...). */
	group: string;
}

// Bare site-address key: `caddy` or `caddy_<N>` with NOTHING after it (a dot would
// make it a directive like `caddy.reverse_proxy`).
const SITE_KEY_RE = /^caddy(?:_\d+)?$/;

export function extractCaddyUrls(
	labels: Record<string, string> | undefined | null
): CaddyUrl[] {
	if (!labels) return [];

	const out: CaddyUrl[] = [];
	const seen = new Set<string>();

	for (const [key, value] of Object.entries(labels)) {
		if (!SITE_KEY_RE.test(key)) continue;
		const raw = (value ?? '').trim();
		if (!raw) continue;

		// A site-address label can list several addresses separated by commas.
		for (const addr of raw.split(',')) {
			const url = addressToUrl(addr.trim());
			if (!url || seen.has(url)) continue;
			seen.add(url);
			out.push({ url, group: key });
		}
	}

	return out;
}

/** Turn a single Caddy site address into a clickable URL, or null if it isn't one. */
function addressToUrl(addr: string): string | null {
	if (!addr) return null;
	// Snippet / named matcher definitions: `(encode)`, `(snippet)` - not a site.
	if (addr.startsWith('(')) return null;
	// Wildcard / catch-all placeholders aren't a clickable host.
	if (addr === '*' || addr === ':443' || addr === ':80') return null;

	let scheme: 'http' | 'https' = 'https';
	let rest = addr;

	if (/^https?:\/\//i.test(rest)) {
		scheme = rest.toLowerCase().startsWith('http://') ? 'http' : 'https';
		rest = rest.replace(/^https?:\/\//i, '');
	}

	// Split host[:port] from any path matcher (`example.com/api/*`).
	const slash = rest.indexOf('/');
	let hostPort = slash === -1 ? rest : rest.slice(0, slash);
	let path = slash === -1 ? '' : rest.slice(slash);

	if (!hostPort) return null;

	// A leading-colon address (`:8080`) is a port-only site with no host - not clickable.
	if (hostPort.startsWith(':')) return null;

	// Explicit port decides http only for :80; keep https otherwise (Caddy serves TLS
	// on custom ports too). Drop :443 as it's the https default.
	const portMatch = hostPort.match(/:(\d+)$/);
	if (portMatch) {
		const port = portMatch[1];
		if (!/^https?:\/\//i.test(addr)) {
			if (port === '80') scheme = 'http';
		}
		if (port === '443' || port === '80') hostPort = hostPort.replace(/:\d+$/, '');
	}

	// Strip a trailing wildcard from the path (`/api/*` -> `/api`).
	path = path.replace(/\/\*+$/, '').replace(/\*+$/, '');
	if (path === '/') path = '';

	return `${scheme}://${hostPort}${path}`;
}
