/** A stored registry, split the way parseRegistryUrl splits it (path '' or '/org...'). */
export interface StoredRegistryEntry {
	host: string;
	path: string;
	username?: string | null;
	password?: string | null;
}

/**
 * Parse a registry URL into host and path components.
 * Handles URLs with or without protocol, and preserves organization paths.
 *
 * Examples:
 *   'https://registry.example.com/org' -> { host: 'registry.example.com', path: '/org', fullRegistry: 'registry.example.com/org' }
 *   'ghcr.io' -> { host: 'ghcr.io', path: '', fullRegistry: 'ghcr.io' }
 *   'registry.example.com:5000/myorg' -> { host: 'registry.example.com:5000', path: '/myorg', fullRegistry: 'registry.example.com:5000/myorg' }
 */
export function parseRegistryUrl(url: string): { host: string; path: string; fullRegistry: string; protocol: string } {
	// Detect protocol (default to https)
	const protocol = url.startsWith('http://') ? 'http' : 'https';
	// Remove protocol
	const withoutProtocol = url.replace(/^https?:\/\//, '');
	// Remove trailing slash
	const trimmed = withoutProtocol.replace(/\/$/, '');
	// Split on first slash (after port if present)
	const slashIndex = trimmed.indexOf('/');
	if (slashIndex === -1) {
		return { host: trimmed, path: '', fullRegistry: trimmed, protocol };
	}
	const host = trimmed.substring(0, slashIndex);
	const path = trimmed.substring(slashIndex); // includes leading /
	return { host, path, fullRegistry: trimmed, protocol };
}

const trimSlashes = (p: string) => p.replace(/\/+$/, '');

/**
 * The stored entry whose credentials apply to an image: same host, and a path that is
 * empty or a whole-segment prefix of the image's repository. The longest path wins, so
 * 'ghcr.io/team' beats 'ghcr.io' for ghcr.io/team/app; on a tie the first entry wins.
 * Entries without both a username and a password are skipped.
 */
export function matchRegistryEntry<E extends StoredRegistryEntry>(
	entries: readonly E[],
	host: string,
	repoPath: string
): E | null {
	const target = `/${repoPath.replace(/^\/+|\/+$/g, '')}`;
	let best: E | null = null;
	let bestLen = -1;
	for (const entry of entries) {
		if (entry.host !== host || !entry.username || !entry.password) continue;
		const path = trimSlashes(entry.path).toLowerCase();
		const covers = path === '' || target === path || target.startsWith(`${path}/`);
		if (covers && path.length > bestLen) {
			best = entry;
			bestLen = path.length;
		}
	}
	return best;
}

const HUB_HOST = 'index.docker.io';

/**
 * The stored registry whose credentials apply to `repo` on `registryHost`, and how it
 * matched. Every Docker Hub hostname counts as one host, so 'docker.io/team' covers
 * Hub images under team/; on a tie, an entry spelled with the requested host wins. When no
 * Hub entry's path covers the image, the first Hub entry with credentials still applies
 * ('hub-fallback'), so a single Hub login keeps covering all of Hub.
 */
export function pickRegistryCredentials<R extends { url: string; username?: string | null; password?: string | null }>(
	registries: readonly R[],
	registryHost: string,
	repo: string,
	hubHosts: ReadonlySet<string>
): { registry: R; via: 'path' | 'host-only' | 'hub-fallback' } | null {
	const canonical = (host: string) => (hubHosts.has(host) ? HUB_HOST : host);
	const requested = parseRegistryUrl(registryHost);
	const entries = registries
		.map((registry) => {
			const { host, path } = parseRegistryUrl(registry.url);
			return { host: canonical(host), exact: host === requested.host, path, username: registry.username, password: registry.password, registry };
		})
		// Stable sort: entries spelled with the requested host come first, so they win ties.
		.sort((a, b) => Number(b.exact) - Number(a.exact));

	const match = matchRegistryEntry(entries, canonical(requested.host), [requested.path, repo].filter(Boolean).join('/'));
	if (match) return { registry: match.registry, via: trimSlashes(match.path) ? 'path' : 'host-only' };

	if (hubHosts.has(requested.host)) {
		const hub = entries.find((e) => e.host === HUB_HOST && e.username && e.password);
		if (hub) return { registry: hub.registry, via: 'hub-fallback' };
	}
	return null;
}
