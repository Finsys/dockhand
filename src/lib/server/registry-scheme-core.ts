// Resolve which URL scheme (http vs https) a registry host was CONFIGURED with, so the
// bearer-token / challenge request honours a plain-HTTP registry instead of always using
// HTTPS (#1580). The browse/catalog path already honours the stored scheme; this brings
// the update-check token path in line. Pure so it is unit-testable without the DB.

export interface StoredRegistryScheme {
	/** bare host[:port], no scheme, no path (e.g. "10.10.10.10:3000") */
	host: string;
	/** 'http' | 'https' as stored */
	protocol: string;
	/** true if this stored entry is a Docker Hub variant */
	isHub: boolean;
}

/**
 * Given the requested registry host and the schemes of the configured registries,
 * return 'http' or 'https' to use for that host. A configured entry whose host matches
 * wins; a Docker Hub request matches any stored Hub entry. Falls back to 'https' when
 * nothing matches (the safe default, and what registries on the public internet use).
 */
export function resolveRegistryScheme(
	requestedHost: string,
	stored: StoredRegistryScheme[],
	requestedIsHub: boolean
): 'http' | 'https' {
	for (const s of stored) {
		if (s.host === requestedHost) return s.protocol === 'http' ? 'http' : 'https';
	}
	if (requestedIsHub) {
		for (const s of stored) {
			if (s.isHub) return s.protocol === 'http' ? 'http' : 'https';
		}
	}
	return 'https';
}
