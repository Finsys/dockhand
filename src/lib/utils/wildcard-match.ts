/**
 * Wildcard matching for the search boxes: `*` is any run of characters (also none),
 * `?` is exactly one. The pattern covers the whole text, case-insensitively, so
 * `api_*_prod` matches `api_web_prod` and not `api_web_prod_old`.
 *
 * Matched with two pointers and one remembered star rather than a regex: a pattern
 * the user types runs on every keystroke against every name and label, and a
 * backtracking regex is exponential in the number of stars.
 */
export function globMatches(pattern: string, text: string): boolean {
	const p = Array.from(pattern.toLowerCase());
	const t = Array.from(text.toLowerCase());
	let pi = 0;
	let ti = 0;
	let star = -1;
	let starText = 0;
	while (ti < t.length) {
		if (pi < p.length && (p[pi] === '?' || (p[pi] !== '*' && p[pi] === t[ti]))) {
			pi++;
			ti++;
		} else if (pi < p.length && p[pi] === '*') {
			star = pi++;
			starText = ti;
		} else if (star !== -1) {
			// Let the last star take one more character and try again from there.
			pi = star + 1;
			ti = ++starText;
		} else {
			return false;
		}
	}
	while (pi < p.length && p[pi] === '*') pi++;
	return pi === p.length;
}

/**
 * The search boxes' text test: a plain query is a case-insensitive substring, a
 * wildcard one a whole-text pattern. `query` is already trimmed.
 */
export function searchTextMatcher(query: string, wildcard: boolean): (text: string | null | undefined) => boolean {
	if (wildcard) return (text) => globMatches(query, text ?? '');
	const needle = query.toLowerCase();
	return (text) => (text ?? '').toLowerCase().includes(needle);
}

/**
 * The mode a search box opens in. A search carried in the URL says itself whether it
 * is a pattern (`wildcard=1`, written by the page as the user types); a link from
 * elsewhere carries a plain value and opens plain. Without a search in the URL the
 * user's own setting applies.
 */
export function initialWildcard(params: URLSearchParams, hasSearch: boolean, stored: boolean): boolean {
	return hasSearch ? params.get('wildcard') === '1' : stored;
}

/** The stacks page filter: a stack matches by its name or the status it shows. */
export function stackMatchesSearch(name: string, status: string, rawQuery: string, wildcard: boolean): boolean {
	if (!rawQuery.trim()) return true;
	const matches = searchTextMatcher(wildcard ? rawQuery.trim() : rawQuery, wildcard);
	return matches(name) || matches(status);
}
