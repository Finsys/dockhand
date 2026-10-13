/**
 * Pure container search matching, so the containers-page filter is unit-testable.
 *
 * A plain query matches the name, image, any label key OR value, and (kept for
 * back-compat) the compose project. A `label:` prefix does a Docker-style label
 * filter: `label:heal` matches a container that HAS a `heal` label (any value);
 * `label:heal=true` matches only when the value is `true` too. Mirrors
 * `docker ps --filter "label=heal"` / `label=heal=true` (#1372).
 */

export interface SearchableContainer {
	name: string;
	image: string;
	labels?: Record<string, string>;
}

/** A `label:key` / `label:key=value` token, parsed once per query. */
function parseLabelToken(query: string): { key: string; value: string | null } | null {
	const m = /^label:(.+)$/i.exec(query.trim());
	if (!m) return null;
	const rest = m[1];
	const eq = rest.indexOf('=');
	if (eq === -1) return { key: rest.trim().toLowerCase(), value: null };
	return {
		key: rest.slice(0, eq).trim().toLowerCase(),
		value: rest.slice(eq + 1).trim().toLowerCase(),
	};
}

/** True if the container has a label whose key matches `key` (and value matches
 *  `value` when given). Keys and values are compared case-insensitively. */
function matchesLabelFilter(
	labels: Record<string, string> | undefined,
	key: string,
	value: string | null,
): boolean {
	if (!labels) return false;
	for (const [k, v] of Object.entries(labels)) {
		if (k.toLowerCase() !== key) continue;
		if (value === null) return true;
		if ((v ?? '').toLowerCase() === value) return true;
	}
	return false;
}

/**
 * Does a container match the search query? Empty query matches everything.
 * A `label:` query is a targeted label filter; any other query is a free-text
 * substring match over name, image, every label key/value, and the compose project.
 */
export function containerMatchesSearch(c: SearchableContainer, rawQuery: string): boolean {
	const q = rawQuery.trim();
	if (!q) return true;

	const labelToken = parseLabelToken(q);
	if (labelToken) return matchesLabelFilter(c.labels, labelToken.key, labelToken.value);

	const query = q.toLowerCase();
	if (c.name.toLowerCase().includes(query)) return true;
	if (c.image.toLowerCase().includes(query)) return true;
	if (c.labels) {
		for (const [k, v] of Object.entries(c.labels)) {
			if (k.toLowerCase().includes(query) || (v ?? '').toLowerCase().includes(query)) return true;
		}
	}
	return false;
}
